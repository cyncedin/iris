// The real GoogleCalendarProvider + calendar sync against an in-memory emulation of the Calendar v3 REST API
// (plus Google's token endpoint and the Gmail attachment endpoint for invites). No network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "iris-gcal-"));
process.env.IRIS_HOME = HOME;
process.env.IRIS_SECRETS = "file";
process.env.IRIS_GOOGLE_CLIENT_ID = "test-client";
process.env.IRIS_GOOGLE_CLIENT_SECRET = "test-secret";
process.env.IRIS_GCAL_CALLS_PER_SEC = "100000";
process.env.IRIS_GMAIL_UNITS_PER_SEC = "100000";
process.env.IRIS_QUIET = "1";

const { Iris } = await import("../src/service.ts");
const { saveTokens, CALENDAR_SCOPE } = await import("../src/gmail/oauth.ts");
const { parseGmailMessage } = await import("../src/mime.ts");
const { parseEventText } = await import("../src/when.ts");
const { parseIcs } = await import("../src/ics.ts");
const { renderAvailabilityText, durationText, NotImplementedError } = await import("../src/calendar.ts");
const { IrisAI } = await import("../src/ai/index.ts");
const { createApp } = await import("../../server/src/server.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const ME = "me@cal.test";
const OLD = "old@cal.test"; // authorized before calendar support (stored scope lacks calendar)
const DENY = "deny@cal.test"; // scope unknown locally, API answers 403 insufficientPermissions
const PRIMARY = ME;
const TEAM = "team#northstar@group.calendar.google.com";
const HOLIDAYS = "en.german#holiday@group.v.calendar.google.com";
const HIDDEN = "hidden@group.calendar.google.com";
const DAY = 86_400_000;
const b64 = (s: string) => Buffer.from(s).toString("base64url");

function at(dayOffset: number, h: number, m = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}
const iso = (d: Date | number) => new Date(d).toISOString();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface Call {
  method: string;
  path: string;
  q: URLSearchParams;
  body: J;
}

/** Minimal Google Calendar v3: the endpoints and semantics Iris relies on. */
class CalendarEmulator {
  calendars: J[] = [];
  events = new Map<string, Map<string, J>>();
  masters = new Set<string>();
  changes: { seq: number; cal: string; id: string }[] = [];
  seq = 100;
  calls: Call[] = [];
  pageSize = 2;
  disabled = false;
  /** calendar whose next syncToken request answers 410 */
  expireOnce: string | null = null;
  gone = new Set<string>();
  othersBusy: Record<string, { start: string; end: string }[]> = {};
  attachments = new Map<string, string>();
  tokenN = 0;

  addCalendar(c: J) {
    this.calendars.push(c);
    this.events.set(c.id, new Map());
  }

  put(cal: string, e: J, master = false) {
    this.events.get(cal)!.set(e.id, { status: "confirmed", iCalUID: `${e.id}@google.com`, htmlLink: `https://calendar.google.com/event?eid=${e.id}`, updated: iso(Date.now()), ...e });
    if (master) this.masters.add(`${cal}/${e.id}`);
    this.changes.push({ seq: ++this.seq, cal, id: e.id });
  }

  cancel(cal: string, id: string) {
    const e = this.events.get(cal)!.get(id)!;
    e.status = "cancelled";
    e.updated = iso(Date.now());
    this.changes.push({ seq: ++this.seq, cal, id });
  }

  /** what Google returns for the user: `self` flags */
  out(e: J): J {
    const x = structuredClone(e);
    if (x.attendees) x.attendees = x.attendees.map((a: J) => (a.email === ME ? { ...a, self: true } : a));
    if (x.organizer?.email === ME) x.organizer = { ...x.organizer, self: true };
    return x;
  }

  bounds(e: J): { s: number; e: number } {
    const p = (d: J) => (d?.date ? new Date(`${d.date}T00:00:00`).getTime() : Date.parse(d?.dateTime ?? ""));
    return { s: p(e.start), e: p(e.end) };
  }

  json(data: unknown, status = 200) {
    return new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  err(status: number, message: string, reason: string, extra = "") {
    return this.json({ error: { code: status, message, errors: [{ reason, message }], status: extra } }, status);
  }

  callsTo(method: string, re: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && re.test(c.path));
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const raw = init?.body ? String(init.body) : "";
    if (url.hostname === "oauth2.googleapis.com") {
      const p = new URLSearchParams(raw);
      assert.equal(p.get("grant_type"), "refresh_token");
      const deny = p.get("refresh_token") === "refresh-deny";
      return this.json({ access_token: `${deny ? "deny" : "tok"}${++this.tokenN}`, expires_in: 3600, ...(deny ? {} : { scope: `https://mail.google.com/ ${CALENDAR_SCOPE} openid` }) });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.hostname === "gmail.googleapis.com") {
      const m = url.pathname.match(/\/messages\/([^/]+)\/attachments\/([^/]+)$/);
      if (m && this.attachments.has(m[2])) return this.json({ data: b64(this.attachments.get(m[2])!) });
      return this.json({ error: { code: 404 } }, 404);
    }
    assert.equal(url.hostname, "www.googleapis.com", `unexpected host ${url.hostname}`);
    assert.ok(url.pathname.startsWith("/calendar/v3/"), url.pathname);
    const segs = url.pathname.slice("/calendar/v3/".length).split("/").map(decodeURIComponent);
    const p = "/" + segs.join("/");
    const body = raw ? JSON.parse(raw) : undefined;
    this.calls.push({ method, path: p, q: url.searchParams, body });
    if (auth.startsWith("Bearer deny"))
      return this.json(
        { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
        403,
      );
    if (!/^Bearer tok\d+$/.test(auth)) return this.json({ error: { code: 401 } }, 401);
    if (this.disabled)
      return this.err(403, "Google Calendar API has not been used in project 499322712571 before or it is disabled.", "accessNotConfigured", "PERMISSION_DENIED");

    if (p === "/users/me/calendarList") {
      assert.equal(url.searchParams.get("showHidden"), "true");
      return this.json({ items: this.calendars });
    }
    if (p === "/freeBusy") {
      const calendars: Record<string, J> = {};
      for (const { id } of body.items) {
        if (this.events.has(id)) {
          const busy = [...this.events.get(id)!.values()]
            .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent" && !this.masters.has(`${id}/${e.id}`))
            .map((e) => this.bounds(e))
            .filter((b) => b.e > Date.parse(body.timeMin) && b.s < Date.parse(body.timeMax))
            .map((b) => ({ start: iso(b.s), end: iso(b.e) }));
          calendars[id] = { busy };
        } else calendars[id] = { busy: this.othersBusy[id] ?? [] };
      }
      return this.json({ calendars });
    }
    const cal = segs[1];
    if (segs[0] !== "calendars" || !this.events.has(cal)) return this.err(404, "Not Found", "notFound");
    const store = this.events.get(cal)!;
    if (this.gone.has(cal)) return this.err(404, "Not Found", "notFound");

    // events.list
    if (segs.length === 3 && segs[2] === "events" && method === "GET") {
      const q = url.searchParams;
      if (q.has("iCalUID")) {
        assert.equal(q.get("showHiddenInvitations"), "true");
        assert.equal(q.get("showDeleted"), "true");
        return this.json({ items: [...store.values()].filter((e) => e.iCalUID === q.get("iCalUID") && (this.masters.has(`${cal}/${e.id}`) || !e.recurringEventId)).map((e) => this.out(e)) });
      }
      assert.equal(q.get("singleEvents"), "true");
      assert.equal(q.get("showDeleted"), "true");
      assert.equal(q.get("maxResults"), "500");
      assert.deepEqual(q.getAll("eventTypes"), ["default", "focusTime", "outOfOffice", "fromGmail"]);
      let items: J[];
      if (q.has("syncToken")) {
        if (q.has("timeMin") || q.has("timeMax")) return this.err(400, "Sync token cannot be used with timeMin/timeMax", "invalid");
        if (this.expireOnce === cal) {
          this.expireOnce = null;
          return this.err(410, "Sync token is no longer valid, a full sync is required.", "fullSyncRequired");
        }
        const since = Number(q.get("syncToken")!.replace("st-", ""));
        const ids = [...new Set(this.changes.filter((c) => c.seq > since && c.cal === cal).map((c) => c.id))];
        items = ids.map((id) => store.get(id)).filter((e) => e && !this.masters.has(`${cal}/${e.id}`));
      } else {
        assert.ok(q.has("timeMin"), "full listing needs timeMin");
        const min = Date.parse(q.get("timeMin")!);
        const max = q.has("timeMax") ? Date.parse(q.get("timeMax")!) : Infinity;
        items = [...store.values()].filter((e) => !this.masters.has(`${cal}/${e.id}`)).filter((e) => {
          const b = this.bounds(e);
          return b.e > min && b.s < max;
        });
      }
      items.sort((a, b) => this.bounds(a).s - this.bounds(b).s);
      const start = Number(q.get("pageToken") ?? 0);
      const page = items.slice(start, start + this.pageSize).map((e) => this.out(e));
      const more = start + this.pageSize < items.length;
      return this.json({ items: page, ...(more ? { nextPageToken: String(start + this.pageSize) } : { nextSyncToken: `st-${this.seq}` }) });
    }
    // events.insert / events.import
    if (segs.length === 3 && segs[2] === "events" && method === "POST") {
      assert.equal(url.searchParams.get("conferenceDataVersion"), "1");
      assert.ok(["all", "none"].includes(url.searchParams.get("sendUpdates") ?? ""), "sendUpdates set");
      assert.ok(body.start && body.end, "start and end");
      const id = `n${(++this.seq).toString(32)}`;
      const e: J = { id, organizer: { email: ME }, creator: { email: ME }, ...body };
      if (e.attendees?.length) e.attendees = [{ email: ME, organizer: true, responseStatus: "accepted" }, ...e.attendees.map((a: J) => ({ responseStatus: "needsAction", ...a }))];
      if (body.conferenceData?.createRequest) {
        e.hangoutLink = `https://meet.google.com/emu-${id}`;
        e.conferenceData = { entryPoints: [{ entryPointType: "video", uri: e.hangoutLink }] };
      }
      this.put(cal, e);
      return this.json(this.out(store.get(id)));
    }
    if (segs.length === 4 && segs[2] === "events" && segs[3] === "import" && method === "POST") {
      assert.ok(body.iCalUID, "import needs iCalUID");
      const id = `imp${(++this.seq).toString(32)}`;
      this.put(cal, { id, ...body });
      return this.json(this.out(store.get(id)));
    }
    const eid = segs[3];
    const cur = store.get(eid);
    if (segs.length === 4 && method === "GET") {
      if (!cur) return this.err(404, "Not Found", "notFound");
      if (cur.status === "cancelled") return this.err(410, "Resource has been deleted", "deleted");
      return this.json(this.out(cur));
    }
    if (segs.length === 4 && method === "PATCH") {
      if (!cur || cur.status === "cancelled") return this.err(404, "Not Found", "notFound");
      assert.ok(["all", "none"].includes(url.searchParams.get("sendUpdates") ?? ""), "sendUpdates set");
      const next: J = { ...cur };
      for (const k of ["summary", "description", "location", "colorId", "transparency"]) if (k in body) next[k] = body[k];
      const clean = (d: J) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null));
      if (body.start) next.start = clean(body.start);
      if (body.end) next.end = clean(body.end);
      if (body.attendeesOmitted) {
        for (const a of body.attendees) {
          const hit = next.attendees?.find((x: J) => x.email === a.email);
          if (!hit) return this.err(400, "Not an attendee", "invalid");
          hit.responseStatus = a.responseStatus;
        }
      } else if (body.attendees) next.attendees = body.attendees;
      if (body.conferenceData?.createRequest && url.searchParams.get("conferenceDataVersion") === "1") next.hangoutLink = `https://meet.google.com/emu-${eid}`;
      next.updated = iso(Date.now() + 1);
      next.sequence = (cur.sequence ?? 0) + 1;
      store.set(eid, next);
      this.changes.push({ seq: ++this.seq, cal, id: eid });
      return this.json(this.out(next));
    }
    if (segs.length === 4 && method === "DELETE") {
      if (!cur) return this.err(404, "Not Found", "notFound");
      assert.ok(["all", "none"].includes(url.searchParams.get("sendUpdates") ?? ""), "sendUpdates set");
      this.cancel(cal, eid);
      if (this.masters.has(`${cal}/${eid}`)) for (const e of store.values()) if (e.recurringEventId === eid) this.cancel(cal, e.id);
      return new Response(null, { status: 204 });
    }
    return this.json({ error: { code: 404, message: `emulator: no route ${method} ${p}` } }, 404);
  }
}

const gcal = new CalendarEmulator();
const realFetch = globalThis.fetch;
let iris: InstanceType<typeof Iris>;
const events: { type: string; accountId?: string; data?: J }[] = [];

// a weekly series (Mondays 9:00) the user is invited to
const thomas = { email: "thomas@becker.test", displayName: "Thomas Becker" };
const SERIES_UID = "series-uid-1@becker.test";
const firstMonday = (() => {
  for (let i = 1; i <= 7; i++) if (at(i, 9).getDay() === 1) return i;
  return 7;
})();

before(async () => {
  globalThis.fetch = ((i: string | URL | Request, init?: RequestInit) => gcal.fetch(i, init)) as typeof fetch;
  gcal.addCalendar({ id: PRIMARY, summary: ME, primary: true, selected: true, accessRole: "owner", backgroundColor: "#4986e7", timeZone: "Asia/Makassar" });
  gcal.addCalendar({ id: TEAM, summary: "Northstar", accessRole: "writer", backgroundColor: "#16a765", timeZone: "Europe/Berlin" }); // Google: not selected
  gcal.addCalendar({ id: HOLIDAYS, summary: "Holidays in Germany", selected: true, accessRole: "reader", backgroundColor: "#f83a22", timeZone: "Europe/Berlin" });
  gcal.addCalendar({ id: HIDDEN, summary: "Hidden", hidden: true, accessRole: "owner", backgroundColor: "#000000", timeZone: "UTC" });

  gcal.put(PRIMARY, { id: "e1", summary: "Dentist", start: { dateTime: iso(at(1, 10)) }, end: { dateTime: iso(at(1, 11)) }, organizer: { email: ME } });
  gcal.put(PRIMARY, { id: "e2far", summary: "Far future", start: { dateTime: iso(at(200, 10)) }, end: { dateTime: iso(at(200, 11)) } });
  gcal.put(PRIMARY, { id: "e3", summary: "Last week review", start: { dateTime: iso(at(-10, 15)) }, end: { dateTime: iso(at(-10, 16)) } });
  gcal.put(PRIMARY, { id: "e4old", summary: "Too old", start: { dateTime: iso(at(-40, 15)) }, end: { dateTime: iso(at(-40, 16)) } });
  gcal.put(PRIMARY, {
    id: "invited",
    summary: "Pilot timeline",
    organizer: { email: "anna@acme.test", displayName: "Anna Weber" },
    attendees: [{ email: "anna@acme.test", displayName: "Anna Weber", organizer: true, responseStatus: "accepted" }, { email: ME, responseStatus: "needsAction" }],
    start: { dateTime: iso(at(2, 14)) },
    end: { dateTime: iso(at(2, 15)) },
  });
  const weekly = {
    summary: "Weekly sync",
    iCalUID: SERIES_UID,
    organizer: thomas,
    attendees: [{ ...thomas, organizer: true, responseStatus: "accepted" }, { email: ME, responseStatus: "needsAction" }],
    hangoutLink: "https://meet.google.com/wee-kly-syn",
  };
  gcal.put(PRIMARY, { id: "series1", ...weekly, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"], start: { dateTime: iso(at(firstMonday, 9)) }, end: { dateTime: iso(at(firstMonday, 9, 30)) } }, true);
  for (let k = 0; k < 3; k++) {
    const s = at(firstMonday + 7 * k, 9);
    gcal.put(PRIMARY, { id: `series1_${s.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, recurringEventId: "series1", ...weekly, start: { dateTime: iso(s) }, end: { dateTime: iso(at(firstMonday + 7 * k, 9, 30)) } });
  }
  gcal.put(TEAM, { id: "t1", summary: "Team standup", start: { dateTime: iso(at(1, 9)) }, end: { dateTime: iso(at(1, 9, 15)) } });
  gcal.put(HOLIDAYS, { id: "h1", summary: "Holiday", transparency: "transparent", start: { date: ymd(at(3, 0)) }, end: { date: ymd(at(4, 0)) } });

  saveTokens(ME, { refresh_token: "refresh-me", scope: `https://mail.google.com/ ${CALENDAR_SCOPE} openid email profile` });
  saveTokens(OLD, { refresh_token: "refresh-old", scope: "https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email" });
  saveTokens(DENY, { refresh_token: "refresh-deny" });
  iris = new Iris({ home: path.join(HOME, "data") });
  for (const id of [ME, OLD, DENY]) iris.store.upsertAccount({ id, email: id, name: id.split("@")[0], provider: "gmail" });
  iris.bus.onEvent((e) => events.push({ type: e.type, accountId: e.accountId, data: e.data }));
});

after(() => {
  globalThis.fetch = realFetch;
  iris?.close();
});

const eventsCalls = (cal: string) => gcal.callsTo("GET", new RegExp(`^/calendars/${cal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/events$`));

test("calendar list (showHidden, hidden dropped, default selection) and initial sync: timeMin only, paginated, +120 d cap", async () => {
  await iris.calendar.sync(ME);
  const cals = await iris.calendar.calendars(ME);
  assert.deepEqual(cals.map((c) => c.id), [PRIMARY, TEAM, HOLIDAYS], "hidden calendar dropped, primary first");
  const byId = new Map(cals.map((c) => [c.id, c]));
  assert.equal(byId.get(PRIMARY)!.selected, true);
  assert.equal(byId.get(TEAM)!.selected, false, "not selected in Google → hidden in Iris");
  assert.equal(byId.get(HOLIDAYS)!.selected, true);
  assert.equal(byId.get(PRIMARY)!.notify, true, "notifications: primary only by default");
  assert.equal(byId.get(HOLIDAYS)!.notify, false);

  const first = eventsCalls(PRIMARY);
  assert.ok(first.length >= 3, "followed nextPageToken (page size 2)");
  assert.ok(first.every((c) => c.q.has("timeMin") && !c.q.has("timeMax") && !c.q.has("syncToken")), "initial list: timeMin, no timeMax");
  assert.ok(Math.abs(Date.parse(first[0].q.get("timeMin")!) - (Date.now() - 30 * DAY)) < 60_000, "timeMin = now - 30 d");
  const row = iris.db.get<{ sync_token: string }>("SELECT sync_token FROM calendars WHERE account_id = ? AND id = ?", ME, PRIMARY)!;
  assert.match(row.sync_token, /^st-\d+$/, "token stored after the last page");

  const list = await iris.calendar.events(ME, Date.now() - 31 * DAY, Date.now() + 119 * DAY);
  const names = list.map((e) => e.summary);
  assert.ok(names.includes("Dentist") && names.includes("Last week review") && names.includes("Pilot timeline"));
  assert.ok(!names.includes("Too old"), "before timeMin");
  assert.ok(!names.includes("Team standup"), "unselected calendar not listed by default");
  assert.ok(names.includes("Holiday"));
  assert.ok(!iris.db.get("SELECT 1 FROM events WHERE id = 'e2far'"), "instances beyond +120 d are not cached");
  assert.equal(list.filter((e) => e.summary === "Weekly sync").length, 3, "series expanded to instances (singleEvents)");
  const dentist = list.find((e) => e.summary === "Dentist")!;
  assert.equal(dentist.color, "#4986e7", "falls back to the calendar color");
  assert.equal(dentist.allDay, false);
  assert.equal(dentist.end - dentist.start, 3600_000);
  const holiday = list.find((e) => e.summary === "Holiday")!;
  assert.ok(holiday.allDay && holiday.allDayRow && holiday.transparent);
  assert.equal(new Date(holiday.start).getHours(), 0, "all-day starts at local midnight");
  assert.equal(holiday.end - holiday.start, DAY);
  const team = await iris.calendar.events(ME, Date.now(), Date.now() + 3 * DAY, [TEAM]);
  assert.deepEqual(team.map((e) => e.summary), ["Team standup"], "explicit calendars=…");
  assert.ok(events.some((e) => e.type === "calendar-changed" && e.accountId === ME));
});

test("incremental sync uses only the syncToken; cancellations via showDeleted; 410 → one full resync", async () => {
  const n = gcal.calls.length;
  gcal.put(PRIMARY, { id: "e5", summary: "Added on the phone", start: { dateTime: iso(at(1, 16)) }, end: { dateTime: iso(at(1, 17)) } });
  gcal.cancel(PRIMARY, "e3");
  events.length = 0;
  assert.equal(await iris.calendar.sync(ME), true);
  const inc = eventsCalls(PRIMARY).filter((c) => gcal.calls.indexOf(c) >= n);
  assert.ok(inc.length >= 1 && inc.every((c) => c.q.has("syncToken") && !c.q.has("timeMin") && !c.q.has("timeMax")), "incremental: token only");
  const names = (await iris.calendar.events(ME, Date.now() - 31 * DAY, Date.now() + 30 * DAY)).map((e) => e.summary);
  assert.ok(names.includes("Added on the phone"));
  assert.ok(!names.includes("Last week review"), "cancelled event removed");
  assert.ok(events.some((e) => e.type === "calendar-changed"));

  assert.equal(await iris.calendar.sync(ME), false, "nothing changed");
  gcal.expireOnce = PRIMARY;
  const m = gcal.calls.length;
  await iris.calendar.sync(ME);
  const after = eventsCalls(PRIMARY).filter((c) => gcal.calls.indexOf(c) >= m);
  assert.ok(after[0].q.has("syncToken"), "tried the token");
  assert.ok(after.slice(1).some((c) => c.q.has("timeMin") && !c.q.has("syncToken")), "then a full list");
  assert.ok((await iris.calendar.events(ME, Date.now(), Date.now() + 3 * DAY)).some((e) => e.summary === "Dentist"), "data intact");
});

test("404 on events.list disables that calendar (no flapping)", async () => {
  gcal.gone.add(TEAM);
  await iris.calendar.sync(ME);
  assert.ok(!(await iris.calendar.calendars(ME)).some((c) => c.id === TEAM), "dropped");
  assert.ok(!iris.db.get("SELECT 1 FROM events WHERE calendar_id = ?", TEAM), "its events are gone");
  const n = eventsCalls(TEAM).length;
  await iris.calendar.sync(ME);
  assert.equal(eventsCalls(TEAM).length, n, "not polled again");
  gcal.gone.delete(TEAM);
  await iris.calendar.sync(ME, { full: true });
  assert.ok((await iris.calendar.calendars(ME)).some((c) => c.id === TEAM), "a full sync re-enables it");
});

test("parseEventText: titles, times, durations, all-day, German", () => {
  const now = new Date(2026, 9, 21, 10, 0); // Wed 21 Oct 2026 10:00
  const t = (s: string) => parseEventText(s, now);
  const hm = (ms: number | null) => (ms === null ? null : `${new Date(ms).getDate()}. ${new Date(ms).getHours()}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`);
  let r = t("Lunch with Anna tomorrow 1pm for 1h");
  assert.deepEqual([r.summary, hm(r.start), hm(r.end), r.allDay], ["Lunch with Anna", "22. 13:00", "22. 14:00", false]);
  r = t("Meeting with Bob on Friday at 3pm");
  assert.deepEqual([r.summary, hm(r.start), hm(r.end)], ["Meeting with Bob", "23. 15:00", "23. 15:30"], "default 30 min");
  r = t("Offsite friday");
  assert.deepEqual([r.summary, hm(r.start), hm(r.end), r.allDay], ["Offsite", "23. 0:00", "24. 0:00", true]);
  r = t("Gym today 18:00 for 90 min");
  assert.deepEqual([r.summary, hm(r.start), hm(r.end)], ["Gym", "21. 18:00", "21. 19:30"]);
  r = t("Lunch tomorrow with Anna at 1pm");
  assert.deepEqual([r.summary, hm(r.start)], ["Lunch with Anna", "22. 13:00"], "date and time in separate phrases");
  r = t("Team offsite Nov 12-13");
  assert.deepEqual([r.summary, r.allDay, new Date(r.start!).getDate(), new Date(r.end!).getDate()], ["Team offsite", true, 12, 14], "multi-day, end exclusive");
  r = t("Board meeting Oct 30 10:00-11:30");
  assert.deepEqual([r.summary, hm(r.start), hm(r.end)], ["Board meeting", "30. 10:00", "30. 11:30"]);
  r = t("call for 1.5h at 4pm");
  assert.deepEqual([r.summary, hm(r.start), hm(r.end)], ["call", "21. 16:00", "21. 17:30"]);
  r = t("Standup 9am");
  assert.equal(hm(r.start), "22. 9:00", "a time already past today means tomorrow");
  r = t("Mittagessen mit Anna morgen 13 Uhr");
  assert.deepEqual([r.summary, hm(r.start)], ["Mittagessen mit Anna", "22. 13:00"]);
  assert.equal(t("Just a title").start, null);
});

test("ICS parsing: folding, escapes, TZID, all-day, DURATION", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:abc@x",
    "DTSTART;TZID=Europe/Berlin:20261102T090000",
    "DURATION:PT45M",
    "SUMMARY:Review\\, part 1",
    "DESCRIPTION:Line one\\nLine two that is folded ",
    " across lines",
    'ORGANIZER;CN="Weber, Anna":mailto:Anna@acme.test',
    "ATTENDEE;PARTSTAT=TENTATIVE;ROLE=OPT-PARTICIPANT;CN=Bob:mailto:bob@x.test",
    "BEGIN:VALARM",
    "SUMMARY:alarm (ignored)",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:d@x",
    "DTSTART;VALUE=DATE:20261224",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const c = parseIcs(ics);
  assert.equal(c.method, "REQUEST");
  const [a, b] = c.events;
  assert.equal(a.start, Date.UTC(2026, 10, 2, 8, 0), "09:00 CET = 08:00 UTC");
  assert.equal(a.end - a.start, 45 * 60_000);
  assert.equal(a.summary, "Review, part 1");
  assert.equal(a.description, "Line one\nLine two that is folded across lines");
  assert.deepEqual(a.organizer, { email: "anna@acme.test", name: "Weber, Anna" });
  assert.deepEqual(a.attendees, [{ email: "bob@x.test", name: "Bob", partstat: "TENTATIVE", optional: true }]);
  assert.ok(b.allDay);
  assert.equal(b.start, new Date(2026, 11, 24).getTime());
  assert.equal(b.end - b.start, DAY);
});

test("create: natural language, Meet via conferenceData, sendUpdates, resync right after the write", async () => {
  events.length = 0;
  const e = await iris.calendar.createEvent({ account: ME, text: "Lunch with Anna tomorrow 1pm for 1h", conference: true });
  const ins = gcal.callsTo("POST", /\/events$/).at(-1)!;
  assert.equal(ins.path, `/calendars/${PRIMARY}/events`, "primary calendar by default");
  assert.equal(ins.q.get("conferenceDataVersion"), "1");
  assert.equal(ins.q.get("sendUpdates"), "none", "no guests → nobody emailed");
  assert.equal(ins.body.summary, "Lunch with Anna");
  assert.equal(Date.parse(ins.body.start.dateTime), at(1, 13).getTime());
  assert.equal(Date.parse(ins.body.end.dateTime), at(1, 14).getTime());
  assert.ok(ins.body.start.timeZone, "time zone sent");
  assert.deepEqual(ins.body.conferenceData.createRequest.conferenceSolutionKey, { type: "hangoutsMeet" });
  assert.ok(ins.body.conferenceData.createRequest.requestId);
  assert.match(e.conferenceUrl ?? "", /^https:\/\/meet\.google\.com\//);
  const next = gcal.calls[gcal.calls.indexOf(ins) + 1];
  assert.ok(next.method === "GET" && next.q.has("syncToken"), "immediate incremental re-sync of that calendar");
  assert.ok(events.some((x) => x.type === "calendar-changed"));
  assert.ok((await iris.calendar.events(ME, at(1, 0).getTime(), at(2, 0).getTime())).some((x) => x.id === e.id), "cached");

  const g = await iris.calendar.createEvent({ account: ME, text: "Pilot call friday 11am", attendees: ["Anna Weber <anna@acme.test>"] });
  const ins2 = gcal.callsTo("POST", /\/events$/).at(-1)!;
  assert.equal(ins2.q.get("sendUpdates"), "all", "guests get invitations");
  assert.deepEqual(ins2.body.attendees, [{ email: "anna@acme.test" }]);
  assert.ok(g.attendees.some((a) => a.email === "anna@acme.test"));

  await iris.calendar.createEvent({ account: ME, text: "Offsite friday" });
  const ins3 = gcal.callsTo("POST", /\/events$/).at(-1)!;
  assert.ok(ins3.body.start.date && ins3.body.end.date && !ins3.body.start.dateTime, "all-day uses date");
  assert.ok(!ins3.body.conferenceData, "no Meet link by default");

  iris.settings.calendar.defaultMeetingLink = "meet";
  await iris.calendar.createEvent({ account: ME, summary: "Default Meet", start: iso(at(5, 10)) });
  assert.ok(gcal.callsTo("POST", /\/events$/).at(-1)!.body.conferenceData, "settings.calendar.defaultMeetingLink");
  iris.settings.calendar.defaultMeetingLink = null;

  await assert.rejects(iris.calendar.createEvent({ account: ME, text: "Just a title" }), /Could not find a date or time/);
  await assert.rejects(iris.calendar.createEvent({ account: ME, calendarId: HOLIDAYS, text: "x tomorrow 9am" }), /read-only/);
});

test("update: keeps duration, notify → sendUpdates, scope all moves the series, following → 501", async () => {
  const dentist = (await iris.calendar.events(ME, Date.now(), Date.now() + 3 * DAY)).find((e) => e.summary === "Dentist")!;
  const moved = await iris.calendar.updateEvent(ME, PRIMARY, dentist.id, { start: dentist.start + 3600_000 });
  const patch = gcal.callsTo("PATCH", /\/events\/e1$/).at(-1)!;
  assert.equal(patch.q.get("sendUpdates"), "none");
  assert.equal(Date.parse(patch.body.start.dateTime), dentist.start + 3600_000);
  assert.equal(Date.parse(patch.body.end.dateTime), dentist.end + 3600_000, "duration kept");
  assert.equal(patch.body.start.date, null, "patch clears date");
  assert.ok(!("summary" in patch.body), "only changed fields");
  assert.equal(moved.start, dentist.start + 3600_000);

  const pilot = (await iris.calendar.events(ME, Date.now(), Date.now() + 10 * DAY)).find((e) => e.summary === "Pilot call")!;
  await iris.calendar.updateEvent(ME, PRIMARY, pilot.id, { summary: "Pilot call (moved)", notify: false });
  assert.equal(gcal.callsTo("PATCH", /\/events\//).at(-1)!.q.get("sendUpdates"), "none", "notify: false");
  await iris.calendar.updateEvent(ME, PRIMARY, pilot.id, { location: "Room 2" });
  assert.equal(gcal.callsTo("PATCH", /\/events\//).at(-1)!.q.get("sendUpdates"), "all", "guests are told by default");
  await iris.calendar.updateEvent(ME, PRIMARY, pilot.id, { attendees: ["anna@acme.test", "jonas@partner.test"] });
  const att = gcal.callsTo("PATCH", /\/events\//).at(-1)!.body.attendees.map((a: J) => [a.email, a.responseStatus]);
  assert.deepEqual(att, [[ME, "accepted"], ["anna@acme.test", "needsAction"], ["jonas@partner.test", undefined]], "existing guests keep their state");

  const inst = (await iris.calendar.events(ME, Date.now(), Date.now() + 30 * DAY)).find((e) => e.recurringEventId === "series1")!;
  await iris.calendar.updateEvent(ME, PRIMARY, inst.id, { start: inst.start + 30 * 60_000, scope: "all", notify: false });
  const sp = gcal.callsTo("PATCH", /\/events\//).at(-1)!;
  assert.equal(sp.path, `/calendars/${PRIMARY}/events/series1`, "the series master is patched");
  assert.equal(Date.parse(sp.body.start.dateTime), at(firstMonday, 9, 30).getTime(), "series moved by the same offset");
  await assert.rejects(iris.calendar.updateEvent(ME, PRIMARY, inst.id, { summary: "x", scope: "following" }), NotImplementedError);
});

test("delete: cancellations only when there are guests; scope all deletes the series", async () => {
  const e = await iris.calendar.createEvent({ account: ME, summary: "Scratch", start: iso(at(6, 8)) });
  await iris.calendar.deleteEvent(ME, PRIMARY, e.id);
  const del = gcal.callsTo("DELETE", /\/events\//).at(-1)!;
  assert.equal(del.q.get("sendUpdates"), "none");
  assert.ok(!(await iris.calendar.events(ME, at(6, 0).getTime(), at(7, 0).getTime())).some((x) => x.id === e.id));

  const inst = (await iris.calendar.events(ME, Date.now(), Date.now() + 30 * DAY)).find((x) => x.recurringEventId === "series1")!;
  await iris.calendar.deleteEvent(ME, PRIMARY, inst.id, { scope: "all", notify: false });
  const d2 = gcal.callsTo("DELETE", /\/events\//).at(-1)!;
  assert.equal(d2.path, `/calendars/${PRIMARY}/events/series1`);
  assert.equal(d2.q.get("sendUpdates"), "none");
  assert.ok(!(await iris.calendar.events(ME, Date.now(), Date.now() + 30 * DAY)).some((x) => x.recurringEventId === "series1"), "instances gone after the resync");
  // restore the series for the invite tests
  gcal.put(PRIMARY, { ...gcal.events.get(PRIMARY)!.get("series1"), status: "confirmed" }, true);
  for (const x of gcal.events.get(PRIMARY)!.values()) if (x.recurringEventId === "series1") gcal.put(PRIMARY, { ...x, status: "confirmed", start: x.start, end: x.end });
  await iris.calendar.sync(ME);
});

test("RSVP: PATCH ?sendUpdates=all with {attendeesOmitted, attendees:[self]}", async () => {
  const e = await iris.calendar.rsvp(ME, PRIMARY, "invited", "yes");
  const p = gcal.callsTo("PATCH", /\/events\/invited$/).at(-1)!;
  assert.equal(p.q.get("sendUpdates"), "all");
  assert.deepEqual(p.body, { attendeesOmitted: true, attendees: [{ email: ME, responseStatus: "accepted" }] });
  assert.equal(e.selfResponse, "accepted");
  const cached = (await iris.calendar.events(ME, Date.now(), Date.now() + 5 * DAY)).find((x) => x.id === "invited")!;
  assert.equal(cached.selfResponse, "accepted");

  const inst = (await iris.calendar.events(ME, Date.now(), Date.now() + 30 * DAY)).find((x) => x.recurringEventId === "series1")!;
  await iris.calendar.rsvp(ME, PRIMARY, inst.id, "maybe", { scope: "all" });
  assert.equal(gcal.callsTo("PATCH", /\/events\//).at(-1)!.path, `/calendars/${PRIMARY}/events/series1`, "scope all answers the series");
  await iris.calendar.rsvp(ME, PRIMARY, inst.id, "no");
  assert.equal(gcal.callsTo("PATCH", /\/events\//).at(-1)!.path, `/calendars/${PRIMARY}/events/${inst.id}`, "default: this occurrence");
  await assert.rejects(iris.calendar.rsvp(ME, PRIMARY, "invited", "perhaps"), /Unknown RSVP response/);
});

test("busy time and availability come from cached events; freeBusy only for other people", async () => {
  // a Monday at least a week out, after the three cached "Weekly sync" Mondays
  const off = firstMonday + 21;
  const day = (h: number, m = 0) => at(off, h, m);
  gcal.put(PRIMARY, { id: "b1", summary: "Short", start: { dateTime: iso(day(10)) }, end: { dateTime: iso(day(10, 20)) } });
  gcal.put(PRIMARY, { id: "b2", summary: "Free time", transparency: "transparent", start: { dateTime: iso(day(12)) }, end: { dateTime: iso(day(13)) } });
  gcal.put(PRIMARY, { id: "b3", summary: "Declined", attendees: [{ email: "x@y.test", organizer: true, responseStatus: "accepted" }, { email: ME, responseStatus: "declined" }], start: { dateTime: iso(day(14)) }, end: { dateTime: iso(day(15)) } });
  gcal.put(PRIMARY, { id: "b4", summary: "Out of office", eventType: "outOfOffice", transparency: "transparent", start: { dateTime: iso(day(16)) }, end: { dateTime: iso(day(16, 30)) } });
  gcal.put(HOLIDAYS, { id: "h2", summary: "Holiday (opaque)", start: { date: ymd(day(0)) }, end: { date: ymd(at(off + 1, 0)) } });
  await iris.calendar.sync(ME);
  const fb = gcal.callsTo("POST", /^\/freeBusy$/).length;

  const r = await iris.calendar.availability(ME, { from: day(0).getTime(), days: 1 });
  const fmt = (x: { start: number; end: number }) => `${new Date(x.start).getHours()}:${String(new Date(x.start).getMinutes()).padStart(2, "0")}-${new Date(x.end).getHours()}:${String(new Date(x.end).getMinutes()).padStart(2, "0")}`;
  assert.deepEqual(r.slots.map(fmt), ["9:00-10:00", "10:30-16:00", "16:30-18:00"], "busy rounded to 15 min; free/declined ignored; OOO counts; reader calendars ignored");
  assert.match(r.text, /^Does 30 min (on )?.+ work\? I can do 9:00–10:00 am, 10:30 am–4:00 pm, or 4:30–6:00 pm \S+\.$/);
  const two = await iris.calendar.availability(ME, { from: day(0).getTime(), days: 1, maxRangesPerDay: 2 });
  assert.equal(two.slots.length, 2);
  const week = await iris.calendar.availability(ME, { from: day(0).getTime(), days: 3, duration: 60 });
  assert.ok(week.slots.every((s) => s.end - s.start >= 3600_000));
  assert.ok(week.slots.every((s) => ![0, 6].includes(new Date(s.start).getDay())), "weekdays only");
  assert.match(week.text, /^Does an hour during any of these times \(\S+\) work\?\n- /);
  assert.equal(gcal.callsTo("POST", /^\/freeBusy$/).length, fb, "own busy time needs no freeBusy call");

  const own = await iris.calendar.freeBusy(ME, day(9).getTime(), day(18).getTime());
  assert.deepEqual(own.busy.map(fmt), ["10:00-10:30", "16:00-16:30"]);
  gcal.othersBusy["anna@acme.test"] = [{ start: iso(day(11)), end: iso(day(12)) }];
  const anna = await iris.calendar.freeBusy(ME, day(9).getTime(), day(18).getTime(), ["anna@acme.test"]);
  assert.deepEqual(anna.busy.map(fmt), ["11:00-12:00"]);
  assert.deepEqual(gcal.callsTo("POST", /^\/freeBusy$/).at(-1)!.body.items, [{ id: "anna@acme.test" }]);
});

test("availability text: template", () => {
  const tz = "Europe/Berlin";
  const now = Date.UTC(2026, 9, 21, 8, 0); // Wed Oct 21 2026, 10:00 CEST
  const s = (d: number, h: number, m: number, h2: number, m2: number) => ({ start: Date.UTC(2026, 9, d, h - 2, m), end: Date.UTC(2026, 9, d, h2 - 2, m2) }); // CEST = UTC+2 (until Oct 25; CET = UTC+1 after)
  assert.equal(
    renderAvailabilityText({ slots: [s(23, 10, 0, 10, 30), s(23, 13, 0, 13, 30), s(23, 16, 0, 16, 30)], duration: 30, timeZone: tz, now }),
    "Does Fri Oct 23 work? I can do 10:00–10:30 am, 1:00–1:30 pm, or 4:00–4:30 pm CEST.",
  );
  assert.equal(
    renderAvailabilityText({ slots: [s(22, 11, 30, 13, 0)], duration: 30, timeZone: tz, now }),
    "Does 30 min tomorrow (Oct 22) work? I can do 11:30 am–1:00 pm CEST.",
  );
  assert.equal(
    renderAvailabilityText({ slots: [s(23, 10, 0, 10, 30), s(23, 14, 0, 14, 30)], duration: 30, timeZone: tz, now }),
    "Does Fri Oct 23 work? I can do 10:00–10:30 am or 2:00–2:30 pm CEST.",
  );
  assert.equal(
    renderAvailabilityText({ slots: [s(23, 10, 0, 10, 30), s(23, 10, 30, 11, 0)], duration: 30, timeZone: tz, now }),
    "Does 30 min on Fri Oct 23 work? I can do 10:00–11:00 am CEST.",
    "touching slots merge",
  );
  assert.equal(
    renderAvailabilityText({
      slots: [s(21, 10, 0, 11, 30), s(21, 14, 0, 15, 0), s(23, 9, 30, 12, 0), { start: Date.UTC(2026, 9, 30, 15, 0), end: Date.UTC(2026, 9, 30, 15, 30) }],
      duration: 30,
      timeZone: tz,
      now,
    }),
    "Does 30 min during any of these times (CEST) work?\n- today (Oct 21): 10:00–11:30 am, 2:00–3:00 pm\n- Fri Oct 23: 9:30 am–12:00 pm\n- Oct 30: 4:00–4:30 pm",
  );
  assert.equal(
    renderAvailabilityText({ slots: [s(22, 9, 0, 9, 30), { start: Date.UTC(2026, 9, 26, 8, 0), end: Date.UTC(2026, 9, 26, 8, 30) }], duration: 30, timeZone: tz, now, me: "alex@northstar.health", attendees: ["jp@northstar.health", "anna@acme.test"] }),
    "Do any of these times (CEST) work to meet with us?\n- tomorrow (Oct 22): 9:00–9:30 am\n- Mon Oct 26: 9:00–9:30 am",
  );
  assert.equal(
    renderAvailabilityText({ slots: [s(22, 9, 0, 9, 30)], duration: 30, timeZone: tz, now, me: "alex@northstar.health", attendees: ["jp@northstar.health", "anna@acme.test"] }),
    "Does tomorrow (Oct 22) work to meet with us? We can do 9:00–9:30 am CEST.",
  );
  assert.equal(
    renderAvailabilityText({ slots: [s(22, 9, 0, 9, 30)], duration: 30, timeZone: tz, now, me: "alex@gmail.com", attendees: ["friend@gmail.com", "anna@acme.test"] }),
    "Does tomorrow (Oct 22) work? I can do 9:00–9:30 am CEST.",
    "public mail domains are never 'internal'",
  );
  assert.deepEqual([durationText(15), durationText(60), durationText(90), durationText(120)], ["15 min", "an hour", "1.5 hrs", "2 hrs"]);
});

function inviteIcs(o: { method: string; uid: string; rrule?: boolean; partstat?: string; from?: string; fromName?: string; organizer?: string; sequence?: number }): string {
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    `METHOD:${o.method}`,
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Berlin:20261102T090000",
    "DTEND;TZID=Europe/Berlin:20261102T093000",
    ...(o.rrule ? ["RRULE:FREQ=WEEKLY;BYDAY=MO"] : []),
    `ORGANIZER;CN=Thomas Becker:mailto:${o.organizer ?? thomas.email}`,
    `UID:${o.uid}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Thomas Becker:mailto:${thomas.email}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${o.partstat ?? "NEEDS-ACTION"};CN=${o.fromName ?? "Me"}:mailto:${o.from ?? ME}`,
    "X-GOOGLE-CONFERENCE:https://meet.google.com/wee-kly-syn",
    "DESCRIPTION:Weekly sync\\, agenda in the doc",
    "LOCATION:Google Meet",
    `SEQUENCE:${o.sequence ?? 0}`,
    "STATUS:CONFIRMED",
    "SUMMARY:Weekly sync",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

let threadSeq = 0;
/** A Gmail message like Google Calendar sends: alternative(text, html, text/calendar) + invite.ics attachment. */
function saveInviteMail(ics: string, opts: { inlineData?: boolean; subject?: string } = {}): string {
  const id = `inv${++threadSeq}`;
  const cal = opts.inlineData === false ? { attachmentId: `att-cal-${id}`, size: ics.length } : { data: b64(ics), size: ics.length };
  if (opts.inlineData === false) gcal.attachments.set(`att-cal-${id}`, ics);
  gcal.attachments.set(`att-ics-${id}`, ics);
  const msg = parseGmailMessage(
    {
      id,
      threadId: id,
      labelIds: ["INBOX", "UNREAD"],
      internalDate: String(Date.now()),
      snippet: "You have been invited",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: `Thomas Becker <${thomas.email}>` },
          { name: "To", value: ME },
          { name: "Subject", value: opts.subject ?? "Invitation: Weekly sync @ Weekly from 9am to 9:30am on Monday (CET)" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { partId: "0.0", mimeType: "text/plain", body: { data: b64("You have been invited to Weekly sync"), size: 10 } },
              { partId: "0.1", mimeType: "text/html", body: { data: b64("<p>You have been invited to <b>Weekly sync</b></p>"), size: 10 } },
              { partId: "0.2", mimeType: "text/calendar", headers: [{ name: "Content-Type", value: 'text/calendar; charset="UTF-8"; method=REQUEST' }], body: cal },
            ],
          },
          { partId: "1", mimeType: "application/ics", filename: "invite.ics", body: { attachmentId: `att-ics-${id}`, size: ics.length } },
        ],
      },
    },
    ME,
    "full",
  );
  iris.store.saveThread(ME, id, [msg], [ME]);
  return id;
}

test("invite in a Gmail message (text/calendar part) → thread.invite with the series event", async () => {
  const tid = saveInviteMail(inviteIcs({ method: "REQUEST", uid: SERIES_UID, rrule: true }));
  const m = iris.store.messages(ME, tid)[0];
  assert.match(m.ics ?? "", /BEGIN:VCALENDAR/, "inline text/calendar captured");
  assert.match(m.bodyHtml, /Weekly sync/);
  assert.doesNotMatch(m.bodyText, /BEGIN:VCALENDAR/, "calendar part kept out of the body");
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.inline]), [["invite.ics", false]]);
  const t = await iris.thread(ME, tid);
  const inv = t!.invite!;
  assert.ok(inv, "invite payload");
  assert.equal(inv.kind, "request");
  assert.equal(inv.method, "REQUEST");
  assert.equal(inv.iCalUID, SERIES_UID);
  assert.equal(inv.summary, "Weekly sync");
  assert.equal(inv.description, "Weekly sync, agenda in the doc");
  assert.equal(inv.start, Date.UTC(2026, 10, 2, 8, 0), "TZID=Europe/Berlin converted");
  assert.equal(inv.end - inv.start, 30 * 60_000);
  assert.equal(inv.conferenceUrl, "https://meet.google.com/wee-kly-syn");
  assert.equal(inv.recurring, true);
  assert.equal(inv.canRsvp, true);
  assert.deepEqual(inv.organizer, { email: thomas.email, name: "Thomas Becker" });
  assert.ok(inv.attendees.some((a) => a.self && a.email === ME));
  assert.equal(inv.messageId, tid);
  assert.equal(inv.event?.id, "series1", "a series invite maps to the series master");
  assert.equal(inv.event?.calendarId, PRIMARY);

  // the same, but the text/calendar part only has an attachment id → fetched through Gmail
  const tid2 = saveInviteMail(inviteIcs({ method: "REQUEST", uid: SERIES_UID, rrule: true }), { inlineData: false, subject: "Updated invitation: Weekly sync" });
  assert.equal(iris.store.messages(ME, tid2)[0].ics, undefined);
  const inv2 = (await iris.thread(ME, tid2))!.invite!;
  assert.equal(inv2.kind, "update", "subject 'Updated invitation'");
  assert.match(iris.store.messages(ME, tid2)[0].ics ?? "", /BEGIN:VCALENDAR/, "fetched ICS cached on the message");

  const reply = (await iris.thread(ME, saveInviteMail(inviteIcs({ method: "REPLY", uid: SERIES_UID, partstat: "ACCEPTED", from: "anna@acme.test", fromName: "Anna Weber" }))))!.invite!;
  assert.equal(reply.kind, "reply");
  assert.equal(reply.canRsvp, false);
  assert.deepEqual(reply.replyFrom, { email: "anna@acme.test", name: "Anna Weber", responseStatus: "accepted" }, "the guest who answered, not the organizer");
  const cancel = (await iris.thread(ME, saveInviteMail(inviteIcs({ method: "CANCEL", uid: "gone@x.test" }))))!.invite!;
  assert.equal(cancel.kind, "cancel");
  assert.equal(cancel.canRsvp, false);
  const odd = (await iris.thread(ME, saveInviteMail(inviteIcs({ method: "DECLINECOUNTER", uid: "odd@x.test" }))))!.invite!;
  assert.equal(odd.method, "DECLINECOUNTER", "other methods are tolerated");
});

test("RSVP from an invite: lookup by iCalUID, events.import when missing, remembered per message", async () => {
  const uid = "brand-new-invite@becker.test";
  const tid = saveInviteMail(inviteIcs({ method: "REQUEST", uid }));
  const before = (await iris.thread(ME, tid))!.invite!;
  assert.equal(before.event, undefined, "not on the calendar yet");
  assert.equal(before.selfResponse, "needsAction");
  const n = gcal.calls.length;
  const r = await iris.calendar.rsvpInvite(ME, iris.store.messages(ME, tid), "accepted");
  const seq = gcal.calls.slice(n).map((c) => `${c.method} ${c.path}${c.q.has("iCalUID") ? "?iCalUID" : ""}`);
  assert.deepEqual(seq.slice(0, 4), [
    `GET /calendars/${PRIMARY}/events?iCalUID`,
    `POST /calendars/${PRIMARY}/events/import`,
    `GET /calendars/${PRIMARY}/events?iCalUID`,
    `PATCH /calendars/${PRIMARY}/events/${r.event.id}`,
  ]);
  const imp = gcal.callsTo("POST", /\/events\/import$/).at(-1)!.body;
  assert.equal(imp.iCalUID, uid);
  assert.deepEqual(imp.start, { dateTime: "2026-11-02T08:00:00.000Z", timeZone: "Etc/UTC" });
  assert.equal(gcal.calls.at(-1)!.q.has("syncToken"), true, "re-synced after the RSVP");
  assert.equal(r.event.selfResponse, "accepted");
  const after = (await iris.thread(ME, tid))!.invite!;
  assert.equal(after.selfResponse, "accepted");
  assert.equal(after.event?.id, r.event.id);

  gcal.cancel(PRIMARY, r.event.id);
  await assert.rejects(iris.calendar.rsvpInvite(ME, iris.store.messages(ME, tid), "declined"), /Event has been deleted/);
});

test("meeting notifications at lead time, once per instance; skips declined, all-day, untitled; per-calendar switch", async () => {
  const now = Date.now();
  gcal.put(PRIMARY, { id: "n1", summary: "Standup", hangoutLink: "https://meet.google.com/std-up", start: { dateTime: iso(now + 90_000) }, end: { dateTime: iso(now + 90_000 + 900_000) } });
  gcal.put(PRIMARY, { id: "n2", summary: "", start: { dateTime: iso(now + 90_000) }, end: { dateTime: iso(now + 600_000) } });
  gcal.put(PRIMARY, { id: "n3", summary: "Declined one", attendees: [{ email: "x@y.test", organizer: true, responseStatus: "accepted" }, { email: ME, responseStatus: "declined" }], start: { dateTime: iso(now + 60_000) }, end: { dateTime: iso(now + 600_000) } });
  gcal.put(PRIMARY, { id: "n4", summary: "Later", start: { dateTime: iso(now + 600_000) }, end: { dateTime: iso(now + 900_000) } });
  gcal.put(TEAM, { id: "n5", summary: "Team thing", start: { dateTime: iso(now + 90_000) }, end: { dateTime: iso(now + 600_000) } });
  await iris.calendar.sync(ME);
  events.length = 0;
  assert.equal(iris.calendar.notifyDue(120, now), 1);
  const n = events.find((e) => e.type === "notification")!;
  assert.equal(n.data.kind, "meeting");
  assert.equal(n.data.title, "Standup");
  assert.match(n.data.body, /^in 2m · \d{1,2}:\d{2}/);
  assert.equal(n.data.conferenceUrl, "https://meet.google.com/std-up");
  assert.equal(iris.calendar.notifyDue(120, now + 10_000), 0, "once");
  await iris.calendar.updateCalendar(ME, TEAM, { notify: true, color: "#123456" });
  assert.equal(iris.calendar.notifyDue(120, now + 20_000), 1, "team calendar switched on");
  const team = (await iris.calendar.calendars(ME)).find((c) => c.id === TEAM)!;
  assert.equal(team.color, "#123456", "color override");
  assert.equal(iris.calendar.notifyDue(120, now + 600_000), 1, "Later");
  await iris.calendar.updateCalendar(ME, TEAM, { color: null });
  assert.equal((await iris.calendar.calendars(ME)).find((c) => c.id === TEAM)!.color, "#16a765", "override cleared");
});

test("missing calendar scope: clear error (no API call when the grant shows it), reported once; mail untouched", async () => {
  const n = gcal.calls.length;
  events.length = 0;
  await assert.rejects(iris.calendar.sync(OLD), /^Error: Calendar access not granted yet\. Run: iris auth login$/);
  await assert.rejects(iris.calendar.sync(OLD), /Calendar access not granted yet/);
  assert.equal(gcal.calls.length, n, "stored scope lacks calendar: no request");
  await assert.rejects(iris.calendar.sync(DENY), /^Error: Calendar access not granted yet\. Run: iris auth login$/, "403 insufficientPermissions");
  await assert.rejects(iris.calendar.sync(DENY), /Calendar access not granted yet/);
  const errs = events.filter((e) => e.type === "error");
  assert.deepEqual(
    errs.map((e) => [e.accountId, e.data.where]),
    [
      [OLD, "calendar"],
      [DENY, "calendar"],
    ],
    "one error event per account, not per attempt",
  );
  await assert.rejects(iris.calendar.events(OLD, Date.now(), Date.now() + DAY), /Calendar access not granted/);
  assert.equal(iris.calendar.status(OLD).error, "Calendar access not granted yet. Run: iris auth login");
});

test("disabled Calendar API gives an actionable error", async () => {
  gcal.disabled = true;
  await assert.rejects(iris.calendar.sync(ME), /Google Calendar API is not enabled.*console\.cloud\.google\.com\/apis\/library\/calendar-json\.googleapis\.com\?project=499322712571/);
  gcal.disabled = false;
  await iris.calendar.sync(ME);
  assert.equal(iris.calendar.status(ME).error, null, "recovered");
});

test("HTTP: agent safety (403), SSE vs event list on /api/events, scope following → 501, calendar settings", async () => {
  const app = createApp({ iris, ai: new IrisAI(iris), token: "t", port: 0 });
  const call = async (method: string, p: string, body?: unknown, client = "mcp") => {
    const res = await app.fetch(
      new Request(`http://127.0.0.1${p}`, {
        method,
        headers: { "x-iris-token": "t", "x-iris-client": client, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
    const text = res.headers.get("content-type")?.includes("event-stream") ? "" : await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, res };
  };
  const enc = encodeURIComponent;
  const from = Date.now();
  const to = from + 10 * DAY;
  const listed = await call("GET", `/api/events?account=${enc(ME)}&from=${from}&to=${to}`);
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.json) && listed.json.some((e: J) => e.summary === "Pilot timeline"));
  const sse = await call("GET", "/api/events");
  assert.match(sse.res.headers.get("content-type") ?? "", /text\/event-stream/, "no query → live event stream");
  await sse.res.body?.cancel();

  const blocked = await call("POST", "/api/events", { account: ME, text: "Sync with Anna tomorrow 4pm", attendees: ["anna@acme.test"] });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.error, /Allow sending/);
  const solo = await call("POST", "/api/events", { account: ME, text: "Focus block tomorrow 7am for 1h" });
  assert.equal(solo.status, 200, "agents may create events without guests");
  assert.equal(solo.json.summary, "Focus block");
  assert.equal((await call("PATCH", `/api/events/${enc(PRIMARY)}/${solo.json.id}?account=${enc(ME)}`, { text: "tomorrow 8am" })).status, 200, "and edit them");
  assert.equal((await call("PATCH", `/api/events/${enc(PRIMARY)}/invited?account=${enc(ME)}`, { summary: "x" })).status, 403, "event with guests");
  assert.equal((await call("DELETE", `/api/events/${enc(PRIMARY)}/invited?account=${enc(ME)}`)).status, 403);
  assert.equal((await call("POST", `/api/events/${enc(PRIMARY)}/invited/rsvp?account=${enc(ME)}`, { response: "accepted" })).status, 403, "RSVP emails the organizer");
  const ui = await call("POST", `/api/events/${enc(PRIMARY)}/invited/rsvp?account=${enc(ME)}`, { response: "tentative" }, "ui");
  assert.equal(ui.status, 200);
  assert.equal(ui.json.selfResponse, "tentative");
  const uiCreate = await call("POST", "/api/events", { account: ME, text: "Sync with Anna tomorrow 4pm", attendees: ["anna@acme.test"] }, "ui");
  assert.equal(uiCreate.status, 200);

  const inst = listed.json.find((e: J) => e.recurringEventId === "series1");
  const following = await call("PATCH", `/api/events/${enc(PRIMARY)}/${inst.id}?account=${enc(ME)}`, { summary: "x", scope: "following" }, "ui");
  assert.equal(following.status, 501);

  const patched = await call("PATCH", `/api/calendars/${enc(HOLIDAYS)}?account=${enc(ME)}`, { selected: false, color: "#abcdef" }, "ui");
  assert.equal(patched.status, 200, "calendar ids with # and @ survive the URL");
  assert.deepEqual([patched.json.id, patched.json.selected, patched.json.color], [HOLIDAYS, false, "#abcdef"]);
  const scope = await call("GET", `/api/calendars?account=${enc(OLD)}`, undefined, "ui");
  assert.equal(scope.status, 403);
  assert.equal(scope.json.code, "calendar_scope");

  const text = await call("POST", "/api/availability/text", { slots: [{ start: at(1, 10).getTime(), end: at(1, 10, 30).getTime() }], duration: 30 });
  assert.equal(text.status, 200);
  assert.match(text.json.text, /^Does tomorrow \(\w{3} \d{1,2}\) work\? I can do 10:00–10:30 am \S+\.$/);
});
