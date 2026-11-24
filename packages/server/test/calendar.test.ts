// Calendar over HTTP in demo mode (FakeCalendarProvider): populated calendar, invite in the demo mailbox, RSVP, agent safety.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Calendar, CalendarEvent, Thread, ThreadSummary } from "@iris/core";
import { startServer } from "../src/server.ts";
import { IrisClient } from "../src/client.ts";

process.env.IRIS_SECRETS = "file";

const DAY = 86_400_000;
const ACCT = "demo@iris.local";
const servers: { close: () => Promise<void> }[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cal-srv-"));
  process.env.IRIS_HOME = home;
  const srv = await startServer({ demo: true, home: path.join(home, "demo"), port: 0, log: () => undefined });
  await srv.iris.sync.sync(ACCT, true);
  await srv.iris.calendar.sync(ACCT);
  servers.push(srv);
  return { srv, ui: new IrisClient(srv.url, srv.token, "ui"), agent: new IrisClient(srv.url, srv.token, "mcp") };
}

const today = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

test("demo calendar: calendars, seeded events matching the demo mail, availability", async () => {
  const { ui } = await boot();
  const cals = await ui.get<Calendar[]>("/api/calendars");
  assert.deepEqual(cals.map((c) => c.summary), ["demo@iris.local", "Northstar", "Holidays in Germany"]);
  assert.ok(cals[0].primary && cals[0].selected && cals[0].notify);
  const list = await ui.get<CalendarEvent[]>("/api/events", { from: today(), to: today() + 30 * DAY });
  const names = new Set(list.map((e) => e.summary));
  for (const n of ["Weekly sync", "Application review", "Flight LIS → BCN (SkyEuro QX7P2L)", "Call with Jonas Richter: pricing", "Deep work: Northstar demo"]) assert.ok(names.has(n), n);
  const weekly = list.filter((e) => e.summary === "Weekly sync");
  assert.ok(weekly.length >= 4 && weekly.every((e) => new Date(e.start).getDay() === 1 && new Date(e.start).getHours() === 9 && e.end - e.start === 30 * 60_000), "Mondays 9:00–9:30");
  assert.equal(weekly[0].selfResponse, "needsAction");
  assert.equal(weekly[0].conferenceUrl, "https://meet.google.com/abc-defg-hij");
  const review = list.find((e) => e.summary === "Application review")!;
  assert.equal(new Date(review.start).getDay(), 6);
  assert.equal(new Date(review.start).getHours(), 10);
  assert.ok(list.every((x, i) => i === 0 || list[i - 1].start <= x.start), "sorted by start");
  assert.ok(list.every((e) => e.color), "colors filled in");

  const one = await ui.get<CalendarEvent>(`/api/events/${encodeURIComponent(review.calendarId)}/${review.id}`);
  assert.equal(one.summary, "Application review");

  const av = await ui.get<{ slots: { start: number; end: number }[]; text: string }>("/api/availability", { days: 5, duration: 30 });
  assert.ok(av.slots.length > 0);
  assert.ok(av.slots.every((s) => s.end - s.start >= 30 * 60_000 && new Date(s.start).getHours() >= 9 && ![0, 6].includes(new Date(s.start).getDay())));
  assert.match(av.text, /work\?/);
  const fb = await ui.get<{ busy: { start: number; end: number }[] }>("/api/freebusy", { from: today(), to: today() + 14 * DAY });
  assert.ok(fb.busy.length > 0);
});

test("demo invite thread: invite payload, RSVP from the thread (agents blocked), mark done", async () => {
  const { ui, agent } = await boot();
  const inbox = await ui.get<{ threads: ThreadSummary[] }>("/api/threads", { view: "inbox", limit: 100 });
  const inv = inbox.threads.find((t) => t.subject.startsWith("Invitation: Weekly sync"))!;
  const t = await ui.get<Thread>(`/api/threads/${inv.id}`);
  assert.ok(t.invite, "thread carries the invite");
  assert.equal(t.invite!.kind, "request");
  assert.equal(t.invite!.summary, "Weekly sync");
  assert.equal(t.invite!.recurring, true);
  assert.equal(t.invite!.canRsvp, true);
  assert.equal(t.invite!.event?.id, "weeklysync", "answered on the series");
  assert.equal(t.invite!.selfResponse, "needsAction");

  await assert.rejects(agent.post(`/api/threads/${inv.id}/invite/rsvp`, { response: "accepted" }), /RSVP emails the organizer/);
  const r = await ui.post<{ event: CalendarEvent; markedDone: boolean }>(`/api/threads/${inv.id}/invite/rsvp`, { response: "accepted", markDone: true });
  assert.equal(r.event.selfResponse, "accepted");
  assert.equal(r.markedDone, true);
  const after = await ui.get<{ threads: ThreadSummary[] }>("/api/threads", { view: "inbox", limit: 100 });
  assert.ok(!after.threads.some((x) => x.id === inv.id), "RSVP + Mark Done");
  const list = await ui.get<CalendarEvent[]>("/api/events", { from: today(), to: today() + 30 * DAY });
  assert.ok(list.filter((e) => e.summary === "Weekly sync").every((e) => e.selfResponse === "accepted"), "every instance answered after the re-sync");
  assert.equal((await ui.get<Thread>(`/api/threads/${inv.id}`)).invite!.selfResponse, "accepted");
});

test("demo: agents create solo events, need allowSend for guests; calendar-changed over SSE", async () => {
  const { srv, ui, agent } = await boot();
  const ctrl = new AbortController();
  const res = await fetch(`${srv.url}/api/events?token=${srv.token}`, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
  const reader = res.body!.getReader();

  const e = await agent.post<CalendarEvent>("/api/events", { text: "Gym tomorrow 7am for 1h" });
  assert.equal(e.summary, "Gym");
  assert.equal(e.end - e.start, 3600_000);
  await assert.rejects(agent.post("/api/events", { text: "Coffee with Lena friday 10am", attendees: ["lena@northwind.vc"] }), /Allow sending/);
  const review = (await ui.get<CalendarEvent[]>("/api/events", { from: today(), to: today() + 8 * DAY })).find((x) => x.summary === "Application review")!;
  await assert.rejects(agent.request("DELETE", `/api/events/${encodeURIComponent(review.calendarId)}/${review.id}`), /has guests/);
  await ui.patch("/api/settings", { agent: { allowSend: true } });
  const g = await agent.post<CalendarEvent>("/api/events", { text: "Coffee with Lena friday 10am", attendees: ["lena@northwind.vc"], conference: true });
  assert.ok(g.attendees.some((a) => a.email === "lena@northwind.vc"));
  assert.match(g.conferenceUrl ?? "", /^https:\/\/meet\.google\.com\//);
  assert.ok((srv.iris.calendarProvider(ACCT) as unknown as { calls: string[] }).calls.some((c) => c.startsWith("insert") && c.endsWith("sendUpdates=all")));

  let buf = "";
  const dec = new TextDecoder();
  while (!buf.includes("calendar-changed")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
  }
  assert.match(buf, /event: calendar-changed/);
  ctrl.abort();

  const text = await ui.post<{ text: string; html: string }>("/api/availability/text", {
    slots: [
      { start: today() + DAY + 10 * 3600_000, end: today() + DAY + 10.5 * 3600_000 },
      { start: today() + DAY + 14 * 3600_000, end: today() + DAY + 15 * 3600_000 },
    ],
    duration: 30,
    timeZone: "Europe/Berlin",
  });
  // slots are local-tomorrow; rendered in Europe/Berlin they may be "tomorrow" or a named day depending on the hour
  assert.match(text.text, /^Does 30 min (tomorrow \(\w{3} \d{1,2}\)|on \w{3} \w{3} \d{1,2}) work\? I can do .+ or .+\.$/);
});
