// In-memory Google Calendar stand-in for demo mode and tests. Stores Google event resources and reuses the real mappers.
import { importBody, mapCalendar, mapEvent, mergeRanges, toGoogleBody, type GCalendarListEntry, type GEvent } from "../gcal/model.ts";
import type { IcsEvent } from "../ics.ts";
import { ProviderError, type CalendarEventWrite, type CalendarProvider, type SendUpdates } from "../provider.ts";
import type { Calendar, CalendarEvent, ResponseStatus, TimeRange } from "../types.ts";
import { localIso } from "../when.ts";

const DAY = 86_400_000;

/** iCalUID shared by the demo "Weekly sync" series and the invite in the demo mailbox. */
export const DEMO_WEEKLY_UID = "weekly-sync-7f3a2c@becker.example";
export const DEMO_MEET = "https://meet.google.com/abc-defg-hij";

function at(base: Date, dayOffset: number, h: number, m = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Next given weekday (0 = Sun) at h:m, at least `minDays` days from now (today counts if still ahead). */
export function nextWeekdayAt(now: Date, dow: number, h: number, m = 0, minDays = 0): Date {
  for (let i = minDays; i < minDays + 8; i++) {
    const d = at(now, i, h, m);
    if (d.getDay() === dow && d.getTime() > now.getTime()) return d;
  }
  return at(now, 7, h, m);
}

function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The REQUEST that "Thomas Becker" sent for the weekly sync (attached to the demo invite mail). */
export function demoInviteIcs(email: string, now = new Date()): string {
  const start = nextWeekdayAt(now, 1, 9);
  const end = new Date(start.getTime() + 30 * 60_000);
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    `DTSTAMP:${icsUtc(new Date(now.getTime() - DAY))}`,
    "ORGANIZER;CN=Thomas Becker:mailto:thomas@becker.example",
    `UID:${DEMO_WEEKLY_UID}`,
    "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Thomas Becker:mailto:thomas@becker.example",
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Alex Morgan;X-NUM-GUESTS=0:mailto:${email}`,
    `DESCRIPTION:Weekly Northstar sync: pilot status\\, deck\\, next steps.\\n\\nJoin with Google Meet: ${DEMO_MEET}`,
    "LOCATION:Google Meet",
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
    "SUMMARY:Weekly sync",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

const timed = (d: Date) => ({ dateTime: localIso(d.getTime()) });
/** Google event ids are base32hex (0-9, a-v) */
const base32hex = (n: number) => n.toString(32);
const allDayDate = (d: Date) => ({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` });

export class FakeCalendarProvider implements CalendarProvider {
  readonly kind = "fake" as const;
  readonly email: string;
  private calendars: GCalendarListEntry[] = [];
  private store = new Map<string, Map<string, GEvent>>();
  private masters = new Set<string>(); // `${calendarId}\n${eventId}` of recurring series (not listed with singleEvents)
  private seq = 1;
  private changes: { seq: number; calendarId: string; id: string }[] = [];
  private tokensExpired = false;
  /** writes as "insert|patch|delete|respond <calendarId> <eventId> sendUpdates=…" (tests) */
  readonly calls: string[] = [];

  constructor(email = "demo@iris.local", seed = true) {
    this.email = email;
    this.calendars = [
      { id: email, summary: email, backgroundColor: "#4986e7", primary: true, selected: true, accessRole: "owner", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      { id: "northstar.team@group.calendar.google.com", summary: "Northstar", backgroundColor: "#16a765", selected: true, accessRole: "writer", timeZone: "Europe/Berlin" },
      { id: "en.german#holiday@group.v.calendar.google.com", summary: "Holidays in Germany", backgroundColor: "#f83a22", selected: true, accessRole: "reader", timeZone: "Europe/Berlin" },
    ];
    for (const c of this.calendars) this.store.set(c.id, new Map());
    if (seed) this.seed(new Date());
  }

  // ------------------------------------------------------------ seed (fictional, matches the demo mailbox)

  private put(calendarId: string, e: GEvent, master = false): void {
    this.store.get(calendarId)!.set(e.id, { status: "confirmed", iCalUID: `${e.id}@iris.demo`, htmlLink: `https://calendar.google.com/calendar/event?eid=${e.id}`, updated: new Date().toISOString(), ...e });
    if (master) this.masters.add(`${calendarId}\n${e.id}`);
    this.touch(calendarId, e.id);
  }

  private seed(now: Date): void {
    const me = this.email;
    const primary = me;
    const team = "northstar.team@group.calendar.google.com";
    const holidays = "en.german#holiday@group.v.calendar.google.com";
    const self = (rs: ResponseStatus, organizer = false) => ({ email: me, displayName: "Alex Morgan", self: true, responseStatus: rs, ...(organizer ? { organizer: true } : {}) });

    // Weekly sync: Mondays 9:00–9:30, invite still unanswered (matches the "Invitation: Weekly sync" mail)
    const thomas = { email: "thomas@becker.example", displayName: "Thomas Becker" };
    const weekly: Partial<GEvent> = {
      summary: "Weekly sync",
      description: `Weekly Northstar sync: pilot status, deck, next steps.\n\nJoin with Google Meet: ${DEMO_MEET}`,
      location: "Google Meet",
      iCalUID: DEMO_WEEKLY_UID,
      organizer: thomas,
      attendees: [{ ...thomas, organizer: true, responseStatus: "accepted" }, self("needsAction")],
      hangoutLink: DEMO_MEET,
    };
    const firstMonday = nextWeekdayAt(at(now, -35, 0), 1, 9);
    this.put(primary, { id: "weeklysync", ...weekly, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"], start: timed(firstMonday), end: timed(new Date(firstMonday.getTime() + 30 * 60_000)) }, true);
    for (let k = 0; k < 24; k++) {
      const s = at(firstMonday, 7 * k, 9);
      this.put(primary, { id: `weeklysync_${icsUtc(s)}`, ...weekly, recurringEventId: "weeklysync", start: timed(s), end: timed(new Date(s.getTime() + 30 * 60_000)) });
    }

    // Application review with Sophie (her mail: "Does Saturday 10:00 work? I'll send a calendar invite.")
    const sophie = { email: "sophie.brandt@mentor.example", displayName: "Sophie Brandt" };
    const sat = nextWeekdayAt(now, 6, 10);
    this.put(primary, {
      id: "ethreview",
      summary: "Application review",
      description: "Motivation letter walkthrough.",
      organizer: sophie,
      attendees: [{ ...sophie, organizer: true, responseStatus: "accepted" }, self("needsAction")],
      hangoutLink: "https://meet.google.com/app-revw-sat",
      start: timed(sat),
      end: timed(new Date(sat.getTime() + 60 * 60_000)),
    });

    // Flight LIS → BCN (booking QX7P2L), a Thursday about two weeks out
    const flight = nextWeekdayAt(now, 4, 10, 40, 14);
    this.put(primary, {
      id: "flightqx7p2l",
      summary: "Flight LIS → BCN (SkyEuro QX7P2L)",
      description: "Booking reference: QX7P2L\nSeat 14A, 20kg baggage included.",
      location: "Lisbon Airport (LIS)",
      organizer: { email: me, self: true },
      colorId: "7",
      start: timed(flight),
      end: timed(new Date(flight.getTime() + (3 * 60 + 25) * 60_000)),
    });

    this.put(primary, { id: "gymtoday", summary: "Gym", organizer: { email: me, self: true }, colorId: "10", start: timed(at(now, 0, 7)), end: timed(at(now, 0, 8)) });

    const jonas = { email: "jonas@medtech-partners.example", displayName: "Jonas Richter" };
    const fri = nextWeekdayAt(now, 5, 11);
    this.put(primary, {
      id: "jonaspricing",
      summary: "Call with Jonas Richter: pricing",
      organizer: { email: me, self: true },
      attendees: [self("accepted", true), { ...jonas, responseStatus: "accepted" }],
      hangoutLink: "https://meet.google.com/jon-pric-ing",
      start: timed(fri),
      end: timed(new Date(fri.getTime() + 30 * 60_000)),
    });

    // Northstar team calendar
    this.put(team, { id: "deepwork", summary: "Deep work: Northstar demo", organizer: { email: team }, start: timed(at(now, 1, 14)), end: timed(at(now, 1, 16)) });
    this.put(team, { id: "dryrun", summary: "Demo dry run", organizer: { email: team }, start: timed(at(now, -3, 15)), end: timed(at(now, -3, 16)) });
    const anna = { email: "a.weber@acme.example", displayName: "Anna Weber" };
    const pilot = nextWeekdayAt(now, 3, 10, 0, 21);
    this.put(team, {
      id: "pilotonboarding",
      summary: "Pilot onboarding: Acme Corp",
      location: "Acme Corp, Room 2.14",
      organizer: { email: me, self: true },
      attendees: [self("accepted", true), { ...anna, responseStatus: "tentative" }],
      start: timed(pilot),
      end: timed(new Date(pilot.getTime() + 2 * 3600_000)),
    });

    // Holidays (all-day, free)
    const nextDate = (month: number, day: number) => {
      const d = new Date(now.getFullYear(), month - 1, day);
      if (d.getTime() + DAY < now.getTime()) d.setFullYear(d.getFullYear() + 1);
      return d;
    };
    for (const [id, name, m, d] of [
      ["reformation", "Reformation Day (regional holiday)", 10, 31],
      ["christmas", "Christmas Day", 12, 25],
    ] as const) {
      const s = nextDate(m, d);
      this.put(holidays, { id, summary: name, transparency: "transparent", organizer: { email: holidays }, start: allDayDate(s), end: allDayDate(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1)) });
    }
  }

  // ------------------------------------------------------------ test hooks

  /** Make every issued sync token invalid (next incremental sync gets "expired" → full resync). */
  expireSyncTokens(): void {
    this.tokensExpired = true;
  }

  /** Simulate a change made elsewhere (e.g. in Google Calendar on the phone). */
  externalInsert(calendarId: string, e: GEvent): void {
    this.put(calendarId, e);
  }

  // ------------------------------------------------------------ helpers

  private touch(calendarId: string, id: string): void {
    this.changes.push({ seq: ++this.seq, calendarId, id });
  }

  private cal(calendarId: string): Map<string, GEvent> {
    const c = this.store.get(calendarId === "primary" ? this.email : calendarId);
    if (!c) throw new ProviderError(`Calendar ${calendarId} → 404: notFound`, 404);
    return c;
  }

  private realId(calendarId: string): string {
    return calendarId === "primary" ? this.email : calendarId;
  }

  private isMaster(calendarId: string, id: string): boolean {
    return this.masters.has(`${this.realId(calendarId)}\n${id}`);
  }

  private bounds(e: GEvent): { start: number; end: number } {
    const m = mapEvent(e, "", this.email);
    return { start: m.start, end: m.end };
  }

  private applyPatch(e: GEvent, body: Partial<GEvent>): GEvent {
    const clean = (d: GEvent["start"]) => (d ? (Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null)) as GEvent["start"]) : d);
    const next: GEvent = { ...e, ...body, updated: new Date().toISOString(), sequence: (e.sequence ?? 0) + 1 };
    if (body.start) next.start = clean(body.start);
    if (body.end) next.end = clean(body.end);
    if (body.conferenceData?.createRequest) {
      next.hangoutLink = `https://meet.google.com/irs-${String(this.seq).padStart(4, "0")}-dmo`;
      next.conferenceData = { entryPoints: [{ entryPointType: "video", uri: next.hangoutLink }] };
    }
    return next;
  }

  // ------------------------------------------------------------ CalendarProvider

  async listCalendars(): Promise<Calendar[]> {
    return this.calendars.filter((c) => !c.hidden || c.primary).map((c) => mapCalendar(c, this.email));
  }

  async listEvents(calendarId: string, opts: { timeMin?: number; timeMax?: number; syncToken?: string }) {
    const id = this.realId(calendarId);
    const cal = this.cal(id);
    if (opts.syncToken) {
      const since = Number(opts.syncToken.replace(/^fake-/, ""));
      if (this.tokensExpired || !Number.isFinite(since)) {
        this.tokensExpired = false;
        return "expired" as const;
      }
      const ids = [...new Set(this.changes.filter((c) => c.seq > since && c.calendarId === id).map((c) => c.id))];
      const events: CalendarEvent[] = [];
      const deletedIds: string[] = [];
      for (const eid of ids) {
        if (this.isMaster(id, eid)) continue;
        const e = cal.get(eid);
        if (!e || e.status === "cancelled") deletedIds.push(eid);
        else events.push(mapEvent(e, id, this.email));
      }
      return { events, deletedIds, nextSyncToken: `fake-${this.seq}` };
    }
    const inRange = [...cal.values()]
      .filter((e) => !this.isMaster(id, e.id))
      .filter((e) => {
        const b = this.bounds(e);
        return (opts.timeMax === undefined || b.start < opts.timeMax) && (opts.timeMin === undefined || b.end > opts.timeMin);
      });
    return {
      events: inRange.filter((e) => e.status !== "cancelled").map((e) => mapEvent(e, id, this.email)),
      deletedIds: inRange.filter((e) => e.status === "cancelled").map((e) => e.id), // showDeleted=true
      nextSyncToken: opts.timeMax === undefined ? `fake-${this.seq}` : null,
    };
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    const e = this.cal(calendarId).get(eventId);
    return e && e.status !== "cancelled" ? mapEvent(e, this.realId(calendarId), this.email) : null;
  }

  async findByICalUID(calendarId: string, iCalUID: string): Promise<CalendarEvent[]> {
    const id = this.realId(calendarId);
    const all = [...this.cal(id).values()].filter((e) => e.iCalUID === iCalUID); // showDeleted: cancelled included
    const masters = all.filter((e) => this.isMaster(id, e.id));
    return (masters.length ? masters : all).map((e) => mapEvent(e, id, this.email));
  }

  async insertEvent(calendarId: string, w: CalendarEventWrite, opts: { sendUpdates: SendUpdates }): Promise<CalendarEvent> {
    const id = this.realId(calendarId);
    const cal = this.cal(id);
    const eventId = `iris${base32hex(++this.seq)}${base32hex(Math.floor(Math.random() * 32 ** 4))}`;
    let e: GEvent = { id: eventId, organizer: { email: this.email, self: true }, creator: { email: this.email, self: true } };
    e = this.applyPatch(e, toGoogleBody(w, null, { patch: false }));
    if (e.attendees?.length && !e.attendees.some((a) => a.self)) e.attendees = [{ email: this.email, self: true, organizer: true, responseStatus: "accepted" }, ...e.attendees];
    e.attendees = e.attendees?.map((a) => ({ responseStatus: "needsAction", ...a }));
    cal.set(eventId, { status: "confirmed", iCalUID: `${eventId}@google.com`, htmlLink: `https://calendar.google.com/calendar/event?eid=${eventId}`, ...e });
    this.touch(id, eventId);
    this.calls.push(`insert ${id} ${eventId} sendUpdates=${opts.sendUpdates}`);
    return mapEvent(cal.get(eventId)!, id, this.email);
  }

  async patchEvent(calendarId: string, eventId: string, w: CalendarEventWrite, opts: { sendUpdates: SendUpdates }): Promise<CalendarEvent> {
    const id = this.realId(calendarId);
    const cal = this.cal(id);
    const e = cal.get(eventId);
    if (!e || e.status === "cancelled") throw new ProviderError(`Unknown event: ${eventId}`, 404);
    const next = this.applyPatch(e, toGoogleBody(w, e, { patch: true }));
    next.attendees = next.attendees?.map((a) => ({ responseStatus: "needsAction", ...a }));
    cal.set(eventId, next);
    this.touch(id, eventId);
    this.calls.push(`patch ${id} ${eventId} sendUpdates=${opts.sendUpdates}`);
    return mapEvent(next, id, this.email);
  }

  async deleteEvent(calendarId: string, eventId: string, opts: { sendUpdates: SendUpdates }): Promise<void> {
    const id = this.realId(calendarId);
    const cal = this.cal(id);
    const targets = [...cal.values()].filter((e) => e.id === eventId || (this.isMaster(id, eventId) && e.recurringEventId === eventId));
    for (const e of targets) {
      cal.set(e.id, { ...e, status: "cancelled", updated: new Date().toISOString() });
      this.touch(id, e.id);
    }
    this.calls.push(`delete ${id} ${eventId} sendUpdates=${opts.sendUpdates}`);
  }

  async respond(calendarId: string, eventId: string, selfEmail: string, response: Exclude<ResponseStatus, "needsAction">): Promise<CalendarEvent> {
    const id = this.realId(calendarId);
    const cal = this.cal(id);
    const e = cal.get(eventId);
    if (!e || e.status === "cancelled") throw new ProviderError(`Unknown event: ${eventId}`, 404);
    // attendeesOmitted: only the self entry is sent; like Google, it must be on the guest list
    if (!e.attendees?.some((a) => a.self || a.email.toLowerCase() === selfEmail.toLowerCase()))
      throw new ProviderError("You are not on the guest list of this event, so there is nothing to RSVP.", 400);
    // RSVP on a series answers every instance (like Gmail's invite buttons)
    const targets = [e, ...(this.isMaster(id, eventId) ? [...cal.values()].filter((x) => x.recurringEventId === eventId && x.status !== "cancelled") : [])];
    for (const t of targets) {
      cal.set(t.id, {
        ...t,
        attendees: t.attendees?.map((a) => (a.self || a.email.toLowerCase() === selfEmail.toLowerCase() ? { ...a, self: true, responseStatus: response } : a)),
        updated: new Date().toISOString(),
      });
      this.touch(id, t.id);
    }
    this.calls.push(`respond ${id} ${eventId} ${response} sendUpdates=all`);
    return mapEvent(cal.get(eventId)!, id, this.email);
  }

  async importEvent(calendarId: string, ve: IcsEvent): Promise<CalendarEvent> {
    const id = this.realId(calendarId);
    const cal = this.cal(id);
    const existing = [...cal.values()].find((e) => e.iCalUID === ve.uid && e.status !== "cancelled");
    if (existing) return mapEvent(existing, id, this.email);
    const eventId = `imp${base32hex(++this.seq)}`;
    const body = importBody(ve);
    const e: GEvent = {
      id: eventId,
      status: "confirmed",
      htmlLink: `https://calendar.google.com/calendar/event?eid=${eventId}`,
      updated: new Date().toISOString(),
      ...body,
      attendees: body.attendees?.map((a) => (a.email.toLowerCase() === this.email.toLowerCase() ? { ...a, self: true } : a)),
    };
    cal.set(eventId, e);
    this.touch(id, eventId);
    this.calls.push(`import ${id} ${eventId}`);
    return mapEvent(e, id, this.email);
  }

  async freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<TimeRange[]> {
    const busy: TimeRange[] = [];
    for (const cid of calendarIds) {
      const id = this.realId(cid);
      for (const e of this.store.get(id)?.values() ?? []) {
        if (e.status === "cancelled" || e.transparency === "transparent" || this.isMaster(id, e.id)) continue;
        if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
        const b = this.bounds(e);
        if (b.end <= timeMin || b.start >= timeMax) continue;
        busy.push({ start: Math.max(b.start, timeMin), end: Math.min(b.end, timeMax) });
      }
    }
    return mergeRanges(busy);
  }
}
