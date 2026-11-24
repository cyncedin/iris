// Unified accounts: account=all reads, unified built-in splits, /api/mailboxes,
// cross-account refs actions with one undo. Two FakeProvider accounts in a temp-home demo daemon.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountInfo, CalendarEvent, Calendar, FakeProvider, Mailboxes, ThreadSummary } from "@iris/core";
import { startServer } from "../src/server.ts";
import { IrisClient } from "../src/client.ts";

process.env.IRIS_SECRETS = "file";

const A = "demo@iris.local";
const B = "work@iris.local";
const DAY = 86_400_000;

const servers: { close: () => Promise<void> }[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

type Page = { threads: ThreadSummary[]; total: number };
type SplitC = { id: string; accountId: string; name: string; builtin: string | null; enabled: boolean; count: number; unread: number };

async function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-uni-"));
  process.env.IRIS_HOME = home;
  const srv = await startServer({ demo: true, home: path.join(home, "demo"), port: 0, log: () => undefined });
  const iris = srv.iris;
  iris.settings.undoSendSeconds = 0;
  // second account, connected after the first (like addGmailAccount, minus OAuth)
  iris.store.upsertAccount({ id: B, email: B, name: "Work", provider: "fake" });
  iris.ensureDefaultSplits(B);
  await Promise.all([iris.sync.sync(A, true), iris.sync.sync(B, true)]);
  // a thread only B has, newer than everything: must lead the unified inbox
  (iris.provider(B) as FakeProvider).deliver({ from: { name: "Ops", email: "ops@work.example" }, subject: "Only in work", bodyText: "Unified inbox order check" });
  await iris.sync.sync(B);
  const ui = new IrisClient(srv.url, srv.token, "ui");
  servers.push(srv);
  return { srv, iris, ui };
}

const key = (t: ThreadSummary) => Math.max(t.lastDate, t.returnedAt ?? 0);
const refOf = (t: ThreadSummary) => `${t.accountId}/${t.id}`;

test("account=all: merged inbox in sort order, paging, other views; omitting account = first account", async () => {
  const { ui } = await boot();
  const a = await ui.get<Page>("/api/threads", { view: "inbox", account: A, limit: 1000 });
  const b = await ui.get<Page>("/api/threads", { view: "inbox", account: B, limit: 1000 });
  assert.ok(a.total >= 10 && b.total === a.total + 1, `${a.total} / ${b.total}`);

  // default (no account) is still the first account, unchanged
  const def = await ui.get<Page>("/api/threads", { view: "inbox", limit: 1000 });
  assert.deepEqual(def.threads.map(refOf), a.threads.map(refOf));
  assert.ok(def.threads.every((t) => t.accountId === A));

  const all = await ui.get<Page>("/api/threads", { view: "inbox", account: "all", limit: 1000 });
  assert.equal(all.total, a.total + b.total);
  assert.equal(all.threads[0].subject, "Only in work");
  assert.equal(all.threads[0].accountId, B);
  for (let i = 1; i < all.threads.length; i++) assert.ok(key(all.threads[i - 1]) >= key(all.threads[i]), `sorted at ${i}`);
  assert.deepEqual(new Set(all.threads.map(refOf)), new Set([...a.threads, ...b.threads].map(refOf)));
  // the demo seed gives both accounts the same thread ids: they stay two threads, one per account
  const shared = a.threads[0].id;
  assert.deepEqual(all.threads.filter((t) => t.id === shared).map((t) => t.accountId).sort(), [A, B]);

  // offset/limit apply after the merge
  const page = await ui.get<Page>("/api/threads", { view: "inbox", account: "all", offset: 5, limit: 7 });
  assert.equal(page.total, all.total);
  assert.deepEqual(page.threads.map(refOf), all.threads.slice(5, 12).map(refOf));

  // other views and filters merge too
  for (const view of ["sent", "all", "done"]) {
    const [x, y, z] = await Promise.all([A, B, "all"].map((account) => ui.get<Page>("/api/threads", { view, account, limit: 1000 })));
    assert.equal(z.total, x.total + y.total, view);
    for (let i = 1; i < z.threads.length; i++) assert.ok(z.threads[i - 1].lastDate >= z.threads[i].lastDate, `${view} sorted`);
  }
  const unread = await ui.get<Page>("/api/threads", { view: "inbox", account: "all", filter: "unread", limit: 1000 });
  assert.equal(unread.total, all.threads.filter((t) => t.unread).length);
  assert.ok((await ui.get<Page>("/api/threads", { view: "inbox", account: "ALL" })).total === all.total, "case-insensitive");
});

test("unified splits: builtin:important / builtin:other over every account, custom splits per account", async () => {
  const { ui } = await boot();
  const custom = await ui.post<{ id: string }>(`/api/splits?account=${encodeURIComponent(B)}`, { name: "Flights", query: "flight" });
  const sa = await ui.get<SplitC[]>("/api/splits", { account: A });
  const sb = await ui.get<SplitC[]>("/api/splits", { account: B });
  const su = await ui.get<SplitC[]>("/api/splits", { account: "all" });
  const builtin = (list: SplitC[], k: string) => list.find((s) => s.builtin === k)!;

  // default /api/splits unchanged: the first account's splits with their own ids
  assert.deepEqual((await ui.get<SplitC[]>("/api/splits")).map((s) => s.id), sa.map((s) => s.id));
  assert.match(builtin(sa, "important").id, /^sp_/);

  assert.equal(su[0].id, "builtin:important");
  assert.equal(su[su.length - 1].id, "builtin:other");
  assert.equal(su[0].name, "Important");
  assert.ok(su.every((s) => s.enabled));
  for (const k of ["important", "other"]) {
    const u = builtin(su, k);
    assert.equal(u.accountId, "all");
    assert.equal(u.count, builtin(sa, k).count + builtin(sb, k).count, `${k} count`);
    assert.equal(u.unread, builtin(sa, k).unread + builtin(sb, k).unread, `${k} unread`);
  }
  const flights = su.find((s) => s.id === custom.id)!;
  assert.equal(flights.accountId, B);
  assert.ok(flights.count >= 1);

  // unified split lists = union of each account's built-in split
  for (const k of ["important", "other"]) {
    const u = await ui.get<Page>("/api/threads", { view: "split", split: `builtin:${k}`, account: "all", limit: 1000 });
    const x = await ui.get<Page>("/api/threads", { view: "split", split: builtin(sa, k).id, account: A, limit: 1000 });
    const y = await ui.get<Page>("/api/threads", { view: "split", split: builtin(sb, k).id, account: B, limit: 1000 });
    assert.equal(u.total, builtin(su, k).count);
    assert.deepEqual(new Set(u.threads.map(refOf)), new Set([...x.threads, ...y.threads].map(refOf)));
    // builtin:<kind> also works for one account
    const one = await ui.get<Page>("/api/threads", { view: "split", split: `builtin:${k}`, account: A, limit: 1000 });
    assert.deepEqual(one.threads.map(refOf), x.threads.map(refOf));
  }
  // a custom split id implies its account
  const fl = await ui.get<Page>("/api/threads", { view: "split", split: custom.id, account: "all", limit: 1000 });
  assert.equal(fl.total, flights.count);
  assert.ok(fl.threads.every((t) => t.accountId === B));
});

test("/api/mailboxes: per-account counts match the views, unified sums, account colors", async () => {
  const { iris, ui } = await boot();
  const inboxB = (await ui.get<Page>("/api/threads", { view: "inbox", account: B })).threads;
  const unreadB = inboxB.find((t) => t.unread)!;
  await ui.post("/api/actions/addLabel", { account: B, threadIds: [unreadB.id], label: "Clients/VIP", wait: true });
  await ui.post("/api/actions/star", { account: B, threadIds: [inboxB[1].id], wait: true });
  await ui.post("/api/actions/trash", { account: A, threadIds: [inboxB[2].id], wait: true }); // same id exists in A
  await ui.post("/api/remind", { account: B, threadIds: [inboxB[3].id], when: "tomorrow" });

  const m = await ui.get<Mailboxes>("/api/mailboxes");
  assert.deepEqual(m.accounts.map((a) => a.id), [A, B]);
  assert.deepEqual(m.accounts.map((a) => a.color), ["#007aff", "#c46a00"]);
  assert.ok(m.accounts.every((a) => a.provider === "fake" && a.error === null && a.email && typeof a.name === "string"));
  for (const acc of m.accounts) {
    const total = (view: string) => ui.get<Page>("/api/threads", { view, account: acc.id, limit: 1 }).then((r) => r.total);
    const splits = await ui.get<SplitC[]>("/api/splits", { account: acc.id });
    const inbox = await ui.get<Page>("/api/threads", { view: "inbox", account: acc.id, limit: 1000 });
    assert.equal(acc.counts.inbox, inbox.total, `${acc.id} inbox`);
    assert.equal(acc.counts.inboxUnread, inbox.threads.filter((t) => t.unread).length);
    assert.equal(acc.counts.important, splits.find((s) => s.builtin === "important")!.count);
    assert.equal(acc.counts.importantUnread, splits.find((s) => s.builtin === "important")!.unread);
    assert.equal(acc.counts.other, splits.find((s) => s.builtin === "other")!.count);
    assert.equal(acc.counts.otherUnread, splits.find((s) => s.builtin === "other")!.unread);
    for (const view of ["starred", "drafts", "reminders", "scheduled", "spam", "trash"] as const) {
      assert.equal(acc.counts[view], await total(view), `${acc.id} ${view}`);
    }
  }
  const [ma, mb] = m.accounts;
  assert.equal(mb.counts.starred, 1);
  assert.equal(ma.counts.trash, 1);
  assert.equal(mb.counts.trash, 0);
  assert.equal(mb.counts.reminders, 1);
  assert.equal(ma.counts.reminders, 0);
  assert.deepEqual(mb.labels.find((l) => l.name === "Clients/VIP"), { id: mb.labels.find((l) => l.name === "Clients/VIP")!.id, name: "Clients/VIP", unread: 1 });
  assert.ok(!mb.labels.some((l) => l.name.startsWith("Iris/")), "Iris system labels are not listed");
  assert.ok(!ma.labels.some((l) => l.name === "Clients/VIP"));
  for (const k of ["inbox", "inboxUnread", "important", "importantUnread", "other", "otherUnread"] as const) {
    assert.equal(m.unified[k], ma.counts[k] + mb.counts[k], `unified ${k}`);
  }

  // the same colors on /api/accounts and /api/status
  const accounts = await ui.get<AccountInfo[]>("/api/accounts");
  assert.deepEqual(accounts.map((a) => [a.id, a.color]), [[A, "#007aff"], [B, "#c46a00"]]);
  assert.ok(accounts.every((a) => !("signatureHtml" in a)));
  const status = await ui.get<{ accounts: { id: string; color: string }[] }>("/api/status");
  assert.deepEqual(status.accounts.map((a) => [a.id, a.color]), [[A, "#007aff"], [B, "#c46a00"]]);

  // memoized: warm calls are cheap, and a change shows up immediately
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) iris.mailboxes();
  assert.ok((performance.now() - t0) / 20 < 30, "warm mailboxes < 30 ms");
  await ui.post("/api/actions/done", { account: B, threadIds: [inboxB[0].id] });
  assert.equal((await ui.get<Mailboxes>("/api/mailboxes")).accounts[1].counts.inbox, mb.counts.inbox - 1);
});

test("refs: one action over threads of two accounts, one undo restores both", async () => {
  const { ui } = await boot();
  const ia = (await ui.get<Page>("/api/threads", { view: "inbox", account: A })).threads;
  const ib = (await ui.get<Page>("/api/threads", { view: "inbox", account: B })).threads;
  const x = ia[0].id; // exists in both accounts
  const y = ib.find((t) => t.id !== x && ia.some((s) => s.id === t.id))!.id; // also in both accounts
  const inInbox = async (account: string, id: string) =>
    (await ui.get<Page>("/api/threads", { view: "inbox", account, limit: 1000 })).threads.some((t) => t.id === id);

  const done = await ui.post<{ ok: boolean; count: number; undoId: string; description: string }>("/api/actions/done", {
    refs: [{ account: A, threadId: x }, { account: B, threadId: x }, { accountId: B, threadId: y }, { account: B, threadId: y }],
    wait: true,
  });
  assert.equal(done.ok, true);
  assert.equal(done.count, 3, "grouped per account, duplicates dropped");
  assert.equal(done.description, "Marked 3 done");
  assert.ok(done.undoId);
  assert.equal(await inInbox(A, x), false);
  assert.equal(await inInbox(B, x), false);
  assert.equal(await inInbox(B, y), false);
  assert.equal(await inInbox(A, y), true, "same id in the other account untouched");

  const u = await ui.post<{ ok: boolean; description: string }>("/api/undo", { undoId: done.undoId, wait: true });
  assert.equal(u.ok, true);
  assert.equal(u.description, "Undid: Marked 3 done");
  assert.equal(await inInbox(A, x), true);
  assert.equal(await inInbox(B, x), true);
  assert.equal(await inInbox(B, y), true);
  assert.equal((await ui.post<{ ok: boolean }>("/api/undo", {})).ok, false, "it was a single undo entry");

  // toggles decide over all refs: one starred + one not → star both, then unstar both
  await ui.post("/api/actions/star", { account: A, threadIds: [x], wait: true });
  const refs = [{ account: A, threadId: x }, { account: B, threadId: y }];
  const starred = async () => [await ui.get<{ starred: boolean }>(`/api/threads/${x}`, { account: A }), await ui.get<{ starred: boolean }>(`/api/threads/${y}`, { account: B })].map((t) => t.starred);
  await ui.post("/api/actions/toggleStar", { refs, wait: true });
  assert.deepEqual(await starred(), [true, true]);
  await ui.post("/api/actions/toggleStar", { refs, wait: true });
  assert.deepEqual(await starred(), [false, false]);

  // trash across accounts + one undo
  const tr = await ui.post<{ undoId: string; count: number }>("/api/actions/trash", { refs, wait: true });
  assert.equal(tr.count, 2);
  assert.equal(await inInbox(A, x), false);
  await ui.post("/api/undo", { undoId: tr.undoId, wait: true });
  assert.equal(await inInbox(A, x), true);
  assert.equal(await inInbox(B, y), true);

  // remind me across accounts: one time, both reminders listed under account=all, one undo cancels both
  const rem = await ui.post<{ undoId: string; count: number; when: string; reminderIds: string[] }>("/api/remind", { refs, when: "tomorrow" });
  assert.equal(rem.count, 2);
  assert.equal(rem.reminderIds.length, 2);
  assert.match(rem.when, /tomorrow/);
  const list = await ui.get<{ accountId: string; threadId: string; remindAt: number }[]>("/api/reminders", { account: "all" });
  assert.deepEqual(list.map((r) => `${r.accountId}/${r.threadId}`).sort(), [`${A}/${x}`, `${B}/${y}`].sort());
  assert.equal((await ui.get<unknown[]>("/api/reminders")).length, 1, "default = first account only");
  const remView = await ui.get<Page>("/api/threads", { view: "reminders", account: "all" });
  assert.equal(remView.total, 2);
  assert.ok(remView.threads.every((t) => t.reminder));
  await ui.post("/api/undo", { undoId: rem.undoId, wait: true });
  assert.equal((await ui.get<unknown[]>("/api/reminders", { account: "all" })).length, 0);
  assert.equal(await inInbox(A, x), true);
  assert.equal(await inInbox(B, y), true);

  // bad refs are rejected, unknown accounts are 404
  await assert.rejects(ui.post("/api/actions/done", { refs: [] }), /refs must be/);
  await assert.rejects(ui.post("/api/actions/done", { refs: [{ account: A }] }), /threadId/);
  await assert.rejects(ui.post("/api/actions/done", { refs: [{ account: "all", threadId: x }] }), /Unknown account/);
  // today's { account, threadIds } still works
  const old = await ui.post<{ count: number; undoId: string }>("/api/actions/done", { account: B, threadIds: [y], wait: true });
  assert.equal(old.count, 1);
  assert.equal(await inInbox(B, y), false);
});

test("account=all: search, drafts, outbox, contacts, calendars and events", async () => {
  const { ui } = await boot();
  // search: local and remote (per account, merged by date)
  for (const remote of [0, 1]) {
    const [x, y, z] = await Promise.all([A, B, "all"].map((account) => ui.get<ThreadSummary[]>("/api/search", { account, q: "flight", remote })));
    assert.ok(x.length >= 1 && y.length >= 1);
    assert.equal(z.length, x.length + y.length);
    assert.deepEqual(new Set(z.map((t) => t.accountId)), new Set([A, B]));
    for (let i = 1; i < z.length; i++) assert.ok(z[i - 1].lastDate >= z[i].lastDate);
  }
  const sv = await ui.get<Page>("/api/threads", { view: "search", q: "flight", account: "all" });
  assert.equal(sv.total, 2);
  assert.ok((await ui.get<ThreadSummary[]>("/api/search", { q: "flight", remote: 0 })).every((t) => t.accountId === A), "default = first account");

  // drafts: concatenated, each with its accountId
  const d = await ui.post<{ draftId: string }>("/api/drafts", { accountId: B, to: "anna@example.com", subject: "From work", html: "<p>hi</p>" });
  const drafts = await ui.get<{ draftId: string; accountId: string }[]>("/api/drafts", { account: "all" });
  assert.equal(drafts.find((x) => x.draftId === d.draftId)?.accountId, B);
  assert.ok(!(await ui.get<{ draftId: string }[]>("/api/drafts")).some((x) => x.draftId === d.draftId));

  // outbox: send later from B
  const thread = (await ui.get<Page>("/api/threads", { view: "inbox", account: B })).threads[0];
  const draft = { accountId: B, to: "anna@example.com", subject: "Later", html: "<p>later</p>", threadId: thread.id };
  const q = await ui.post<{ id: string }>("/api/send", { draft, sendAt: Date.now() + DAY });
  const ob = await ui.get<{ id: string; accountId: string }[]>("/api/outbox", { account: "all" });
  assert.equal(ob.find((o) => o.id === q.id)?.accountId, B);
  assert.equal((await ui.get<unknown[]>("/api/outbox")).length, 0);
  assert.equal((await ui.get<Page>("/api/threads", { view: "scheduled", account: "all" })).total, 1);
  assert.equal((await ui.get<Mailboxes>("/api/mailboxes")).accounts[1].counts.scheduled, 1);
  await ui.post(`/api/outbox/${q.id}/cancel`);

  // contacts: merged and deduped by email
  const [ca, cb, cu] = await Promise.all([A, B, "all"].map((account) => ui.get<{ email: string }[]>("/api/contacts", { account, q: "", limit: 50 })));
  const emails = cu.map((c) => c.email);
  assert.equal(new Set(emails).size, emails.length, "no duplicates");
  assert.deepEqual(new Set(emails), new Set([...ca, ...cb].map((c) => c.email)));

  // calendars + events of both accounts, each with accountId, events sorted by start
  const cals = await ui.get<Calendar[]>("/api/calendars", { account: "all" });
  assert.deepEqual(new Set(cals.map((c) => c.accountId)), new Set([A, B]));
  const from = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const range = { from, to: from + 8 * DAY };
  const [ea, eb, eu] = await Promise.all([A, B, "all"].map((account) => ui.get<CalendarEvent[]>("/api/calendar/events", { ...range, account })));
  assert.ok(ea.length >= 1 && eb.length >= 1);
  assert.equal(eu.length, ea.length + eb.length);
  assert.deepEqual(new Set(eu.map((e) => e.accountId)), new Set([A, B]));
  for (let i = 1; i < eu.length; i++) assert.ok(eu[i - 1].start <= eu[i].start);
  // the SSE/list endpoint too, and "primary" means each account's primary
  const ev = await ui.get<CalendarEvent[]>("/api/events", { ...range, account: "all", calendars: "primary" });
  assert.deepEqual(new Set(ev.map((e) => e.accountId)), new Set([A, B]));
  assert.ok((await ui.get<CalendarEvent[]>("/api/calendar/events", range)).every((e) => e.accountId === A), "default = first account");
});
