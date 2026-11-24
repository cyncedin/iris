import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.ts";
import { IrisClient } from "../src/client.ts";

process.env.IRIS_SECRETS = "file";

const servers: { close: () => Promise<void> }[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-srv-"));
  process.env.IRIS_HOME = home; // secrets file lives here too
  const srv = await startServer({ demo: true, home: path.join(home, "demo"), port: 0, log: () => undefined });
  srv.iris.settings.undoSendSeconds = 0;
  await srv.iris.sync.sync("demo@iris.local", true);
  const ui = new IrisClient(srv.url, srv.token, "ui");
  const agent = new IrisClient(srv.url, srv.token, "mcp");
  servers.push(srv);
  return { srv, ui, agent };
}

test("auth + host check", async () => {
  const { srv } = await boot();
  assert.equal((await fetch(`${srv.url}/api/status`)).status, 401);
  assert.equal((await fetch(`${srv.url}/api/status?token=nope`)).status, 401);
  assert.equal((await fetch(`${srv.url}/api/status`, { headers: { "x-iris-token": srv.token } })).status, 200);
  // DNS rebinding: foreign Host header is rejected even with a token
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(`${srv.url}/api/status`, { headers: { "x-iris-token": srv.token, host: "evil.example:7788" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  const html = await (await fetch(`${srv.url}/`)).text();
  assert.match(html, /__IRIS__/);
});

test("inbox, thread, actions, undo over HTTP", async () => {
  const { srv, ui } = await boot();
  const inbox = await ui.get<{ threads: { id: string; subject: string }[]; total: number }>("/api/threads", { view: "inbox" });
  assert.ok(inbox.total >= 10);
  const t = inbox.threads[0];
  const full = await ui.get<{ messages: unknown[] }>(`/api/threads/${t.id}`);
  assert.ok(full.messages.length >= 1);
  const done = await ui.post<{ undoId: string }>("/api/actions/done", { threadIds: [t.id], wait: true });
  assert.ok(done.undoId);
  const after = await ui.get<{ threads: { id: string }[] }>("/api/threads", { view: "inbox" });
  assert.ok(!after.threads.some((x) => x.id === t.id));
  await ui.post("/api/undo", { undoId: done.undoId, wait: true });
  const back = await ui.get<{ threads: { id: string }[] }>("/api/threads", { view: "inbox" });
  assert.ok(back.threads.some((x) => x.id === t.id));
  const splits = await ui.get<{ name: string; count: number }[]>("/api/splits");
  assert.ok(splits.some((s) => s.name === "Important"));
  const found = await ui.get<{ id: string }[]>("/api/search", { q: "flight", remote: 0 });
  assert.ok(found.length >= 1);
  const rem = await ui.post<{ when: string }>("/api/remind", { threadIds: [t.id], when: "tomorrow" });
  assert.match(rem.when, /tomorrow/);
  assert.equal((await ui.get<unknown[]>("/api/reminders")).length, 1);
});

test("agents draft instead of send unless allowed", async () => {
  const { srv, ui, agent } = await boot();
  const draft = { to: "someone@example.com", subject: "Hi", html: "<p>Hello</p>" };
  const r = await agent.post<{ status: string; draftId: string }>("/api/send", { draft });
  assert.equal(r.status, "drafted");
  assert.ok(r.draftId);
  await assert.rejects(agent.patch("/api/settings", { agent: { allowSend: true } }), /Agent permissions/);
  await ui.patch("/api/settings", { agent: { allowSend: true } });
  const s = await agent.post<{ status: string; id: string }>("/api/send", { draft, instant: true });
  assert.ok(["queued", "sending"].includes(s.status));
  await srv.iris.processOutbox();
  assert.equal((await agent.get<{ status: string }>(`/api/outbox/${s.id}`)).status, "sent");
});

test("goals over HTTP", async () => {
  const { ui } = await boot();
  const g = await ui.post<{ id: string; steps: { id: string }[]; progress: { pace: string; totalSteps: number } }>("/api/goals", { title: "Ship", dueAt: "in 12 weeks", steps: ["One", "Two"] });
  assert.equal(g.progress.totalSteps, 2);
  const t = (await ui.get<{ threads: { id: string; accountId: string }[] }>("/api/threads", { view: "inbox" })).threads[0];
  const linked = await ui.post<{ threads: unknown[] }>(`/api/goals/${g.id}/threads`, { account: t.accountId, threadId: t.id });
  assert.equal(linked.threads.length, 1);
  const checked = await ui.patch<{ progress: { doneSteps: number } }>(`/api/goals/${g.id}/steps/${g.steps[0].id}`, { done: true });
  assert.equal(checked.progress.doneSteps, 1);
  assert.equal((await ui.del<{ threads: unknown[] }>(`/api/goals/${g.id}/threads/${t.id}`, { account: t.accountId })).threads.length, 0);
  await assert.rejects(ui.post("/api/goals", { title: "No date" }), /dueAt required/);
  await assert.rejects(ui.patch("/api/goals/nope", { title: "x" }), /Unknown goal/);
  await ui.del(`/api/goals/${g.id}`);
  assert.equal((await ui.get<unknown[]>("/api/goals")).length, 0);
});

test("metric and habit goals over HTTP", async () => {
  const { ui } = await boot();
  const m = await ui.post<{ id: string; kind: string }>("/api/goals", { title: "Weight", dueAt: "in 12 weeks", kind: "metric", startValue: 115, targetValue: 105, unit: "kg" });
  assert.equal(m.kind, "metric");
  const logged = await ui.post<{ entries: { date: string; value: number }[]; progress: { percent: number; metric: { current: number } } }>(`/api/goals/${m.id}/entries`, { value: 110 });
  assert.equal(logged.progress.metric.current, 110);
  assert.equal(logged.progress.percent, 50);
  const date = logged.entries[0].date;
  assert.equal((await ui.post<{ entries: unknown[] }>(`/api/goals/${m.id}/entries`, { value: 109, date })).entries.length, 1);
  assert.equal((await ui.del<{ entries: unknown[] }>(`/api/goals/${m.id}/entries/${date}`)).entries.length, 0);
  await assert.rejects(ui.del(`/api/goals/${m.id}/entries/${date}`), /Unknown entry/);
  const h = await ui.post<{ id: string }>("/api/goals", { title: "Post", dueAt: "in 8 weeks", kind: "habit" });
  const done = await ui.post<{ progress: { habit: { doneToday: boolean; streak: number } } }>(`/api/goals/${h.id}/entries`, {});
  assert.deepEqual([done.progress.habit.doneToday, done.progress.habit.streak], [true, 1]);
  await assert.rejects(ui.post(`/api/goals/${h.id}/entries`, { value: 1 }), /no value/);
  const old = await ui.post<{ id: string }>("/api/goals", { title: "Open", dueAt: "in 8 weeks" });
  const changed = await ui.patch<{ kind: string; progress: { pace: string } }>(`/api/goals/${old.id}`, { kind: "habit" });
  assert.deepEqual([changed.kind, changed.progress.pace], ["habit", "on_track"]);
});

test("SSE events stream", async () => {
  const { srv, ui } = await boot();
  const ctrl = new AbortController();
  const res = await fetch(`${srv.url}/api/events?token=${srv.token}`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const t = (await ui.get<{ threads: { id: string }[] }>("/api/threads", { view: "inbox" })).threads[0];
  await ui.post("/api/actions/star", { threadIds: [t.id] });
  let buf = "";
  const dec = new TextDecoder();
  while (!buf.includes("threads-changed")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
  }
  assert.match(buf, /event: hello/);
  assert.match(buf, /threads-changed/);
  ctrl.abort();
});
