// Person research against a scripted, streaming (SSE) fake of the Messages API: request shape, pause_turn, parsing,
// sources, dedupe, failures, mail evidence, people extraction and the meeting-start prompt. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { Iris } from "../src/service.ts";
import { IrisAI } from "../src/ai/index.ts";
import { guessNamesFromTitle, nameFromEmail, parseResearchOutput, selfMatcher } from "../src/ai/research.ts";
import { FakeProvider } from "../src/fake/provider.ts";
import type { CalendarEvent, IrisEvent, MeetingResearchPrompt, PersonResearch } from "../src/types.ts";
import { createApp } from "../../server/src/server.ts";

process.env.IRIS_SECRETS = "file";

const ME = "demo@iris.local";

type Body = Record<string, unknown> & { model: string; messages: { role: string; content: unknown }[]; tools?: { type: string; name: string }[] };
type Block = Record<string, unknown> & { type: string };

/** One SSE response per request: `script` returns the content blocks and the stop reason. */
function fakeClient(script: (body: Body, n: number) => { content: Block[]; stop?: string } | { status: number }) {
  const requests: { body: Body; headers: Headers }[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push({ body, headers: new Headers(init?.headers) });
    const r = script(body, requests.length);
    if ("status" in r) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), { status: r.status, headers: { "content-type": "application/json" } });
    const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    let sse = ev("message_start", {
      message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
    });
    r.content.forEach((b, index) => {
      sse += ev("content_block_start", { index, content_block: b });
      sse += ev("content_block_stop", { index });
    });
    sse += ev("message_delta", { delta: { stop_reason: r.stop ?? "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    sse += ev("message_stop", {});
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { client: new Anthropic({ apiKey: "sk-ant-test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }), requests };
}

const text = (t: string, citations: unknown[] | null = null): Block => ({ type: "text", text: t, citations });
const REPORT = (name: string, src = "web") =>
  `NAME: ${name} (${src})\nTLDR: ${name} leads the pilot at the clinic.\nCONFIDENCE: high\n## Kurzprofil\n- Leads the pilot since 2025 ([Clinic](https://clinic.example/team))\n## Gesprächseinstiege\n- How is the pilot going?`;

async function demo() {
  const iris = new Iris({ demo: true });
  await iris.sync.sync(ME, true);
  const events: IrisEvent[] = [];
  iris.bus.onEvent((e) => events.push(e));
  return { iris, events };
}

function putEvent(iris: Iris, e: Partial<CalendarEvent> & { id: string; summary: string; start: number }): CalendarEvent {
  const full: CalendarEvent = {
    calendarId: ME,
    accountId: ME,
    iCalUID: `${e.id}@google.com`,
    description: "",
    location: "",
    end: e.start + 30 * 60_000,
    allDay: false,
    allDayRow: false,
    status: "confirmed",
    organizer: { email: ME, name: "", self: true },
    attendees: [],
    htmlLink: "",
    updated: Date.now(),
    ...e,
  };
  iris.db.run("INSERT OR IGNORE INTO calendars (account_id, id, summary, is_primary, access_role) VALUES (?, ?, ?, 1, 'owner')", ME, ME, ME);
  iris.db.run(
    "INSERT INTO events (account_id, calendar_id, id, ical_uid, start_ms, end_ms, status, updated, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ME,
    full.calendarId,
    full.id,
    full.iCalUID,
    full.start,
    full.end,
    full.status,
    full.updated,
    JSON.stringify(full),
  );
  return full;
}

test("research: Opus 5.5 with web tools, effort high, fallback; pause_turn continues; NAME/TLDR/CONFIDENCE and sources parsed", async () => {
  const { iris, events } = await demo();
  const { client, requests } = fakeClient((_b, n) => {
    if (n === 1)
      return {
        stop: "pause_turn",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Anna Berg clinic pilot" } },
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://news.example/a", title: "News A", encrypted_content: "x", page_age: null }] },
        ],
      };
    return {
      content: [
        { type: "server_tool_use", id: "srv_2", name: "web_fetch", input: { url: "https://clinic.example/team" } },
        {
          type: "web_fetch_tool_result",
          tool_use_id: "srv_2",
          content: { type: "web_fetch_result", url: "https://clinic.example/team", retrieved_at: null, content: { type: "document", title: "Team | Clinic", citations: null, source: { type: "text", media_type: "text/plain", data: "Anna Berg" } } },
        },
        text("Let me put this together.\n"),
        text(REPORT("Anna Berg"), [{ type: "web_search_result_location", url: "https://news.example/a", title: "News A", cited_text: "Anna", encrypted_index: "e" }]),
      ],
    };
  });
  const ai = new IrisAI(iris, { client });
  const lines: string[] = [];
  const run = iris.db.run.bind(iris.db);
  iris.db.run = (sql, ...params) => {
    if (sql.startsWith("UPDATE person_research SET progress")) lines.push(String(params[0]));
    run(sql, ...params);
  };
  const started = ai.startResearch(undefined, { name: "Anna", context: "Pilot at the clinic" });
  assert.equal(started.status, "running");
  assert.equal(started.nameSource, "user");
  assert.ok(started.id.startsWith("r_"));
  const r = await ai.waitResearch(started.id, 5000);
  assert.equal(r.status, "done", r.error);

  assert.equal(requests.length, 2, "pause_turn re-requested once");
  const req = requests[0];
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.stream, true);
  assert.equal(req.body.max_tokens, 32000);
  assert.deepEqual((req.body.output_config as { effort: string }).effort, "high");
  assert.deepEqual(req.body.tools, [
    { type: "web_search_20250305", name: "web_search", max_uses: 10 },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: 8, citations: { enabled: true }, blocked_domains: ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com"] },
  ]);
  assert.equal(req.body.fallbacks, "default");
  assert.match(String(req.headers.get("anthropic-beta")), /server-side-fallback-2026-07-01/);
  assert.ok(!("budget_tokens" in req.body) && !("tool_choice" in req.body) && !("thinking" in req.body));
  assert.match(String(req.body.system), /Never merge namesakes/);
  assert.match(String(req.body.system), /Write the report in English/);
  assert.match(JSON.stringify(req.body.messages), /Pilot at the clinic/);
  assert.match(JSON.stringify(req.body.messages), /<me>[^]*demo@iris\.local/);
  const second = requests[1].body.messages;
  assert.equal(second.length, 2);
  assert.equal(second[1].role, "assistant");
  assert.match(JSON.stringify(second[1].content), /server_tool_use/);

  assert.equal(r.name, "Anna Berg", "NAME line completes the name");
  assert.equal(r.nameSource, "web");
  assert.equal(r.tldr, "Anna Berg leads the pilot at the clinic.");
  assert.equal(r.confidence, "high");
  assert.match(r.report, /^## Kurzprofil/);
  assert.doesNotMatch(r.report, /TLDR|CONFIDENCE|NAME:|Let me/);
  assert.deepEqual(
    r.sources.map((s) => [s.url, s.title]),
    [
      ["https://news.example/a", "News A"],
      ["https://clinic.example/team", "Team | Clinic"],
    ],
    "cited first, deduped, titles from the tool results",
  );
  assert.equal(r.progress, "");
  assert.deepEqual(lines, ["Reading mail and calendar", "Searching the web", "Searching: Anna Berg clinic pilot", "Reading: clinic.example/team"], "live progress from server_tool_use");
  const statuses = events.filter((e) => e.type === "research-changed").map((e) => (e.data as { status: string }).status);
  assert.equal(statuses[0], "running");
  assert.equal(statuses.at(-1), "done");
  assert.deepEqual(ai.listResearch({ accountId: "all" }).map((x) => x.id), [r.id]);
  iris.close();
});

test("research: dedupe, force, failures, delete, restart recovery", async () => {
  const { iris, events } = await demo();
  let mode: "ok" | "refusal" | "500" | "plain" = "ok";
  const { client, requests } = fakeClient(() =>
    mode === "500" ? { status: 500 } : mode === "refusal" ? { content: [], stop: "refusal" } : { content: [text(mode === "plain" ? "## Kurzprofil\n- Works at Pilot GmbH." : REPORT("Lena Vogt"))] },
  );
  const ai = new IrisAI(iris, { client });
  const a = await ai.waitResearch(ai.startResearch(undefined, { name: "Lena", context: "" }).id, 5000);
  assert.equal(a.status, "done");
  assert.equal(ai.startResearch(undefined, { name: "lena" }).id, a.id, "same name + context: reused");
  assert.equal(requests.length, 1);
  const b = ai.startResearch(undefined, { name: "Lena", context: "met at DMEA" });
  assert.notEqual(b.id, a.id, "other context: new run");
  await ai.waitResearch(b.id, 5000);
  const c = ai.startResearch(undefined, { name: "Lena", force: true });
  assert.notEqual(c.id, a.id, "force: new run");
  await ai.waitResearch(c.id, 5000);

  mode = "plain";
  const p = await ai.waitResearch(ai.startResearch(undefined, { name: "Jonas" }).id, 5000);
  assert.equal(p.status, "done", "missing TLDR/CONFIDENCE lines do not fail");
  assert.equal(p.confidence, "");
  assert.equal(p.tldr, "Works at Pilot GmbH.");

  mode = "refusal";
  const f = await ai.waitResearch(ai.startResearch(undefined, { name: "Max" }).id, 5000);
  assert.equal(f.status, "failed");
  assert.match(f.error, /declined/);
  mode = "500";
  const g = await ai.waitResearch(ai.startResearch(undefined, { name: "Mia" }).id, 5000);
  assert.equal(g.status, "failed");
  assert.match(g.error, /Claude API error 500/);
  const g2 = ai.startResearch(undefined, { name: "Mia" });
  assert.notEqual(g2.id, g.id, "a failed run is not reused");
  await ai.waitResearch(g2.id, 5000);

  assert.throws(() => ai.startResearch(undefined, {}), /name or email required/);
  assert.throws(() => ai.startResearch(undefined, { name: "X", email: "nope" }), /Not an email/);
  assert.throws(() => ai.startResearch(undefined, { name: "X", context: "y".repeat(2001) }), /too long/);

  ai.deleteResearch(a.id);
  assert.equal(ai.research(a.id), null);
  assert.ok(events.some((e) => e.type === "research-changed" && (e.data as { id: string; status: string }).id === a.id && (e.data as { status: string }).status === "deleted"));
  assert.throws(() => ai.deleteResearch(a.id), /Unknown research/);

  const now = Date.now();
  iris.db.run("INSERT INTO person_research (id, account_id, name, status, created_at, updated_at) VALUES ('r_left', ?, 'Old', 'running', ?, ?)", ME, now, now);
  assert.equal(iris.onResearchRecover?.(), 1);
  assert.equal(ai.research("r_left")?.status, "failed");
  assert.equal(ai.research("r_left")?.error, "Interrupted, try again");
  iris.close();
});

test("people: title names never the user, separators, rooms and own addresses out, email local parts", async () => {
  const self = selfMatcher(["Alex", "Demo User", "demo"]);
  assert.deepEqual(guessNamesFromTitle("Elena x Alex", self), ["Elena"]);
  assert.deepEqual(guessNamesFromTitle("Alex <> Anna Berg", self), ["Anna Berg"]);
  assert.deepEqual(guessNamesFromTitle("Lena / Jonas", self), ["Lena", "Jonas"]);
  assert.deepEqual(guessNamesFromTitle("Meeting mit Elena", self), ["Elena"]);
  assert.deepEqual(guessNamesFromTitle("Lunch with Anna Berg", self), ["Anna Berg"]);
  assert.deepEqual(guessNamesFromTitle("Call Alex", self), []);
  assert.deepEqual(guessNamesFromTitle("Max Weber", self), [], "x inside a word is not a separator");
  assert.deepEqual(guessNamesFromTitle("Lunch & Learn", self), []);
  assert.deepEqual(guessNamesFromTitle("Sauna", self), []);
  assert.deepEqual(guessNamesFromTitle("CS50P", self), []);
  assert.equal(nameFromEmail("elena.marsh@x.example"), "Elena Marsh");
  assert.equal(nameFromEmail("em@harborlabs.example"), "");
  assert.equal(nameFromEmail("info@x.gr"), "");

  const { iris } = await demo();
  iris.settings.ai.researchSelfNames = ["Alex"];
  const { client } = fakeClient(() => ({ content: [text(REPORT("x"))] }));
  const ai = new IrisAI(iris, { client });
  const e = putEvent(iris, {
    id: "dimx",
    summary: "Elena x Alex",
    start: Date.now(),
    attendees: [
      { email: ME, name: "Alex", responseStatus: "accepted", self: true },
      { email: "em@harborlabs.example", name: "", responseStatus: "needsAction" },
      { email: "c-room@resource.calendar.google.com", name: "Room 1", responseStatus: "accepted" },
    ],
  });
  assert.deepEqual(ai.meetingPeople(ME, e), [{ name: "Elena", email: "em@harborlabs.example", nameSource: "title" }]);
  iris.close();
});

test("mail evidence: From display name prefills the person, the signature tail reaches the model, NAME from the signature", async () => {
  const { iris } = await demo();
  iris.settings.ai.researchSelfNames = ["Alex"];
  const fake = iris.provider(ME) as FakeProvider;
  const filler = "Wir haben die Unterlagen geprüft und melden uns zur Planung. ".repeat(50);
  fake.deliver({ from: { name: "Elena Example", email: "em@harborlabs.example" }, subject: "Northstar x Harbor Labs", bodyText: `Hallo Alex,\n\n${filler}\n\nLiebe Grüße,\nElena Example\nHarbor Labs` });
  fake.deliver({ from: { name: "", email: "tb@harborlabs.example" }, subject: "Termin", bodyText: `Hallo Alex,\n\nbis Donnerstag.\n\nLiebe Grüße,\nTom Becker\nHarbor Labs` });
  await iris.sync.sync(ME);
  const { client, requests } = fakeClient((body) => {
    const tom = /tb@harborlabs/.test(JSON.stringify(body.messages));
    return { content: [text(REPORT(tom ? "Tom Becker" : "Elena Example", "signature"))] };
  });
  const ai = new IrisAI(iris, { client });
  const e = putEvent(iris, {
    id: "dimx2",
    summary: "Elena x Alex",
    start: Date.now() - 60_000,
    attendees: [
      { email: ME, name: "", responseStatus: "accepted", self: true },
      { email: "em@harborlabs.example", name: "", responseStatus: "accepted" },
    ],
  });
  assert.deepEqual(ai.meetingPeople(ME, e), [{ name: "Elena Example", email: "em@harborlabs.example", nameSource: "mail-header" }], "From display name beats the title");

  const d = ai.startResearch(undefined, { name: "Elena", email: "em@harborlabs.example", eventId: e.id, calendarId: ME, nameSource: "title" });
  assert.equal(d.name, "Elena Example");
  assert.equal(d.nameSource, "mail-header");
  assert.equal(d.eventTitle, "Elena x Alex");
  await ai.waitResearch(d.id, 5000);
  const user = JSON.stringify(requests[0].body.messages);
  assert.match(user, /From: Elena Example <em@harborlabs.example>/);
  assert.match(user, /\[…\]/, "long body: start and end");
  assert.match(user, /Liebe Grüße,\\nElena Example\\nHarbor Labs/, "signature tail included");
  assert.match(user, /harborlabs.example \(a company domain/);
  assert.match(user, /Title: Elena x Alex/, "meeting title even when the name is known");
  assert.match(String(requests[0].body.system), /signatures sent from the person's own address are strong identity evidence/);

  const n = await ai.waitResearch(ai.startResearch(undefined, { name: "Tom", email: "tb@harborlabs.example" }).id, 5000);
  assert.match(JSON.stringify(requests[1].body.messages), /Tom Becker\\nHarbor Labs/);
  assert.equal(n.name, "Tom Becker", "NAME line completes the name");
  assert.equal(n.nameSource, "signature");
  assert.deepEqual(parseResearchOutput("TLDR: x\n## A").name, "");
  iris.close();
});

test("meeting-start prompt: attendee and title-only meetings ask once, 'Sauna' never, setting turns it off", async () => {
  const { iris, events } = await demo();
  const { client } = fakeClient(() => ({ content: [text(REPORT("Anna Berg"))] }));
  const ai = new IrisAI(iris, { client });
  const now = Date.now();
  putEvent(iris, {
    id: "kick",
    summary: "Northstar Kickoff",
    start: now - 60_000,
    attendees: [
      { email: ME, name: "Demo User", responseStatus: "accepted", self: true },
      { email: "anna@pilot.example", name: "Anna Berg", responseStatus: "accepted" },
    ],
  });
  putEvent(iris, { id: "elena", summary: "Meeting mit Elena", start: now - 2 * 60_000 });
  putEvent(iris, { id: "sauna", summary: "Sauna", start: now - 60_000 });
  putEvent(iris, { id: "old", summary: "Meeting mit Eva", start: now - 20 * 60_000, end: now + 60_000 });
  putEvent(iris, { id: "allday", summary: "Meeting mit Jan", start: now - 60_000, allDay: true });
  const done = await ai.waitResearch(ai.startResearch(undefined, { name: "Anna Berg", email: "anna@pilot.example", eventId: "kick", calendarId: ME }).id, 5000);

  events.length = 0;
  assert.equal(ai.meetingResearchDue(now), 2);
  const prompts = events.filter((e) => e.type === "notification").map((e) => e.data as MeetingResearchPrompt);
  const kick = prompts.find((p) => p.eventId === "kick")!;
  assert.equal(kick.kind, "meeting-research");
  assert.equal(kick.title, "Northstar Kickoff");
  assert.equal(kick.calendarId, ME);
  assert.deepEqual(kick.people, [{ name: "Anna Berg", email: "anna@pilot.example", nameSource: "attendee" }]);
  assert.deepEqual(kick.existing, [{ id: done.id, status: "done", tldr: done.tldr }]);
  const el = prompts.find((p) => p.eventId === "elena")!;
  assert.deepEqual(el.people, [{ name: "Elena", email: "", nameSource: "title" }]);
  assert.deepEqual(el.existing, []);
  assert.ok(!prompts.some((p) => p.eventId === "sauna"));
  assert.equal(ai.meetingResearchDue(now + 30_000), 0, "not twice");
  assert.ok(iris.db.kvGet(`research_prompted:${ME}\n${ME}\nkick\n${now - 60_000}`), "dedupe survives a restart (kv)");

  iris.settings.ai.researchPrompt = false;
  putEvent(iris, { id: "later", summary: "Coffee with Lena", start: now + 60_000 });
  assert.equal(ai.meetingResearchDue(now + 90_000), 0, "setting off");
  iris.settings.ai.researchPrompt = true;
  assert.equal(ai.meetingResearchDue(now + 90_000), 1);
  assert.equal(ai.meetingResearchDue(now + 3 * 86_400_000), 0);
  assert.equal(iris.db.kvGet(`research_prompted:${ME}\n${ME}\nkick\n${now - 60_000}`), null, "pruned after 2 days");
  iris.close();
});

test("HTTP: POST/GET/DELETE /api/research, ?wait, event people", async () => {
  const { iris } = await demo();
  const { client } = fakeClient(() => ({ content: [text(REPORT("Anna Berg"))] }));
  const ai = new IrisAI(iris, { client });
  const app = createApp({ iris, ai, token: "t", port: 0 });
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await app.fetch(
      new Request(`http://127.0.0.1${p}`, {
        method,
        headers: { "x-iris-token": "t", "x-iris-client": "ui", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const e = putEvent(iris, { id: "m1", summary: "Meeting mit Elena", start: Date.now() + 3_600_000 });
  assert.deepEqual((await call("GET", `/api/events/${encodeURIComponent(ME)}/${e.id}/people`)).json, { people: [{ name: "Elena", email: "", nameSource: "title" }] });

  assert.equal((await call("POST", "/api/research", {})).status, 400);
  const started = await call("POST", "/api/research", { name: "Anna", context: "Pilot" });
  assert.equal(started.status, 202);
  assert.equal(started.json.status, "running");
  const r = (await call("GET", `/api/research/${started.json.id}?wait=5`)).json as PersonResearch;
  assert.equal(r.status, "done");
  assert.equal(r.name, "Anna Berg");
  const again = await call("POST", "/api/research", { name: "Anna", context: "Pilot" });
  assert.equal(again.status, 200, "finished report reused");
  assert.equal(again.json.id, r.id);
  assert.deepEqual((await call("GET", "/api/research?account=all&limit=5")).json.map((x: PersonResearch) => x.id), [r.id]);
  assert.deepEqual((await call("GET", "/api/research?eventId=nope")).json, []);
  assert.equal((await call("GET", "/api/research/r_nope")).status, 404);
  assert.deepEqual((await call("DELETE", `/api/research/${r.id}`)).json, { ok: true });
  assert.equal((await call("DELETE", `/api/research/${r.id}`)).status, 404);
  iris.close();
});
