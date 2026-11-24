// Google Calendar API resource shapes and mapping to Iris types. Shared by the real client and the demo fake.
import type { Calendar, CalendarEvent, EventAttendee, ResponseStatus, TimeRange } from "../types.ts";
import type { IcsEvent } from "../ics.ts";
import { partstatToResponse } from "../ics.ts";
import type { CalendarEventWrite } from "../provider.ts";
import { localIso } from "../when.ts";

export interface GDate {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface GAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  resource?: boolean;
  comment?: string;
}

export interface GEvent {
  id: string;
  status?: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GDate;
  end?: GDate;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GAttendee[];
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { requestId: string; conferenceSolutionKey?: { type: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  recurringEventId?: string;
  recurrence?: string[];
  colorId?: string;
  transparency?: string;
  eventType?: string;
  updated?: string;
  sequence?: number;
  attendeesOmitted?: boolean;
}

export interface GCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: string;
  timeZone?: string;
  deleted?: boolean;
  hidden?: boolean;
}

/** Google Calendar event palette (colors.get → event), colorId 1..11. */
export const EVENT_COLORS: Record<string, string> = {
  "1": "#a4bdfc",
  "2": "#7ae7bf",
  "3": "#dbadff",
  "4": "#ff887c",
  "5": "#fbd75b",
  "6": "#ffb878",
  "7": "#46d6db",
  "8": "#e1e1e1",
  "9": "#5484ed",
  "10": "#51b749",
  "11": "#dc2127",
};

const ROLES = new Set(["owner", "writer", "reader", "freeBusyReader"]);
const RESPONSES = new Set(["needsAction", "declined", "tentative", "accepted"]);

export function mapCalendar(c: GCalendarListEntry, accountId: string): Calendar {
  return {
    id: c.id,
    accountId,
    summary: c.summaryOverride || c.summary || c.id,
    color: c.backgroundColor || "#9fc6e7",
    primary: !!c.primary,
    selected: !!c.primary || !!c.selected,
    notify: !!c.primary,
    accessRole: (ROLES.has(c.accessRole ?? "") ? c.accessRole : "reader") as Calendar["accessRole"],
    timeZone: c.timeZone ?? "",
  };
}

/** "2026-10-22" → local midnight */
export function parseYmd(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function gdateMs(d: GDate | undefined): { ms: number; allDay: boolean } {
  if (d?.date) return { ms: parseYmd(d.date), allDay: true };
  if (d?.dateTime) return { ms: Date.parse(d.dateTime), allDay: false };
  return { ms: 0, allDay: false };
}

const CONF_URL = /https:\/\/(?:meet\.google\.com\/[a-z-]+|[\w.-]*zoom\.us\/[jw]\/[^\s"<>)]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>)]+|[\w.-]*webex\.com\/[^\s"<>)]+)/i;

export function conferenceUrlOf(e: GEvent): string | undefined {
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  if (video) return video;
  return `${e.location ?? ""} ${e.description ?? ""}`.match(CONF_URL)?.[0];
}

export function mapEvent(e: GEvent, calendarId: string, accountId: string): CalendarEvent {
  const s = gdateMs(e.start);
  const en = gdateMs(e.end);
  const attendees: EventAttendee[] = (e.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({
      email: a.email.toLowerCase(),
      name: a.displayName ?? "",
      responseStatus: (RESPONSES.has(a.responseStatus ?? "") ? a.responseStatus : "needsAction") as ResponseStatus,
      ...(a.self ? { self: true } : {}),
      ...(a.organizer ? { organizer: true } : {}),
      ...(a.optional ? { optional: true } : {}),
    }));
  const self = attendees.find((a) => a.self);
  const organizer = { email: (e.organizer?.email ?? e.creator?.email ?? "").toLowerCase(), name: e.organizer?.displayName ?? "", ...(e.organizer?.self ? { self: true } : {}) };
  const status = e.status === "tentative" || e.status === "cancelled" ? e.status : "confirmed";
  const conferenceUrl = conferenceUrlOf(e);
  const end = en.ms || s.ms;
  return {
    id: e.id,
    calendarId,
    accountId,
    iCalUID: e.iCalUID ?? "",
    summary: e.summary ?? "",
    description: e.description ?? "",
    location: e.location ?? "",
    start: s.ms,
    end,
    allDay: s.allDay,
    allDayRow: s.allDay || end - s.ms >= 86_400_000,
    ...(e.start?.timeZone ? { timeZone: e.start.timeZone } : {}),
    status,
    organizer,
    attendees,
    ...(self ? { selfResponse: self.responseStatus } : {}),
    ...(conferenceUrl ? { conferenceUrl } : {}),
    htmlLink: e.htmlLink ?? "",
    ...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {}),
    ...(e.colorId && EVENT_COLORS[e.colorId] ? { color: EVENT_COLORS[e.colorId] } : {}),
    ...(e.transparency === "transparent" ? { transparent: true } : {}),
    ...(e.eventType && e.eventType !== "default" ? { eventType: e.eventType } : {}),
    updated: e.updated ? Date.parse(e.updated) : 0,
  };
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Iris write → Google event body. For patches only the given fields are sent; start/end must be given together.
 * Attendee lists keep the existing entries (response status, self) of people that stay invited.
 */
export function toGoogleBody(w: CalendarEventWrite, existing: GEvent | null, opts: { patch: boolean; requestId?: string }): Partial<GEvent> {
  const body: Partial<GEvent> = {};
  if (w.summary !== undefined) body.summary = w.summary;
  if (w.description !== undefined) body.description = w.description;
  if (w.location !== undefined) body.location = w.location;
  if (w.start !== undefined && w.end !== undefined) {
    if (w.allDay) {
      body.start = { date: ymd(w.start), ...(opts.patch ? { dateTime: null, timeZone: null } : {}) };
      body.end = { date: ymd(w.end), ...(opts.patch ? { dateTime: null, timeZone: null } : {}) };
    } else {
      const tz = localTimeZone();
      body.start = { dateTime: localIso(w.start), timeZone: tz, ...(opts.patch ? { date: null } : {}) };
      body.end = { dateTime: localIso(w.end), timeZone: tz, ...(opts.patch ? { date: null } : {}) };
    }
  }
  if (w.attendees) {
    const prev = existing?.attendees ?? [];
    const wanted = [...new Set(w.attendees.map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const kept = prev.filter((a) => a.self && !wanted.includes(a.email.toLowerCase()));
    body.attendees = [...kept, ...wanted.map((email) => prev.find((a) => a.email.toLowerCase() === email) ?? { email })];
  }
  if (w.conference && !existing?.hangoutLink && !existing?.conferenceData?.entryPoints?.length) {
    body.conferenceData = { createRequest: { requestId: opts.requestId ?? crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  return body;
}

/** events.import body for an invite that is not on the user's calendar yet (UTC times, ICS fields). */
export function importBody(ve: IcsEvent): Partial<GEvent> {
  const when = (ms: number) => (ve.allDay ? { date: ymd(ms) } : { dateTime: new Date(ms).toISOString(), timeZone: "Etc/UTC" });
  return {
    iCalUID: ve.uid,
    summary: ve.summary,
    description: ve.description,
    location: ve.location,
    start: when(ve.start),
    end: when(ve.end),
    ...(ve.organizer.email ? { organizer: { email: ve.organizer.email, ...(ve.organizer.name ? { displayName: ve.organizer.name } : {}) } } : {}),
    attendees: ve.attendees.map((a) => ({
      email: a.email,
      ...(a.name ? { displayName: a.name } : {}),
      responseStatus: partstatToResponse(a.partstat),
      ...(a.optional ? { optional: true } : {}),
    })),
    ...(ve.rrule ? { recurrence: [`RRULE:${ve.rrule}`] } : {}),
  };
}

/** Event attendees other than the user (people who get emailed on changes). */
export function guests(e: Pick<CalendarEvent, "attendees">): EventAttendee[] {
  return e.attendees.filter((a) => !a.self);
}

/** Sort and merge overlapping/adjacent ranges. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}
