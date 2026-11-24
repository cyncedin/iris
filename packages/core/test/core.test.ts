import { test } from "node:test";
import assert from "node:assert/strict";
import { Iris } from "../src/service.ts";
import { FakeProvider } from "../src/fake/provider.ts";
import { evaluate, parseQuery } from "../src/query.ts";
import { parseWhen } from "../src/when.ts";
import { parseAddressList, buildMime } from "../src/mime.ts";

process.env.IRIS_SECRETS = "file";

async function demo() {
  const iris = new Iris({ demo: true });
  iris.settings.undoSendSeconds = 0;
  await iris.sync.sync("demo@iris.local", true);
  iris.ensureDefaultSplits("demo@iris.local");
  return { iris, fake: iris.provider("demo@iris.local") as FakeProvider, acct: "demo@iris.local" };
}

test("address parsing", () => {
  const a = parseAddressList('"Weber, Anna" <A.Weber@x.de>, bob@y.com, Carl <c@z.org>');
  assert.deepEqual(a, [
    { name: "Weber, Anna", email: "a.weber@x.de" },
    { name: "", email: "bob@y.com" },
    { name: "Carl", email: "c@z.org" },
  ]);
});

test("query language", () => {
  const t = {
    subject: "pilot timeline",
    from: "anna weber a.weber@acme.example",
    to: "me@x",
    body: "please send the dpo docs",
    labelIds: ["INBOX", "UNREAD"],
    labelNames: ["inbox", "unread", "clients/vip"],
    listId: "",
    attachments: "",
    lastDate: Date.now() - 3600_000,
    unread: true,
    starred: false,
    important: true,
    snoozed: false,
    muted: false,
  };
  const ok = (q: string) => evaluate(parseQuery(q), t);
  assert.ok(ok("from:weber is:unread"));
  assert.ok(ok("label:clients/vip"));
  assert.ok(ok("(from:nobody OR subject:pilot) -has:attachment"));
  assert.ok(!ok("-from:weber"));
  assert.ok(ok("newer_than:2d"));
  assert.ok(!ok("older_than:2d"));
  assert.ok(ok('"dpo docs"'));
});

test("natural language times", () => {
  const now = new Date(2026, 9, 21, 10, 0); // Wed 21 Oct 2026 10:00
  const tomorrow = new Date(parseWhen("tomorrow", now)!);
  assert.equal(tomorrow.getDate(), 22);
  assert.equal(tomorrow.getHours(), 8);
  assert.equal(new Date(parseWhen("3h", now)!).getHours(), 13);
  const fri = new Date(parseWhen("fri 3pm", now)!);
  assert.equal(fri.getDay(), 5);
  assert.equal(fri.getHours(), 15);
  assert.equal(parseWhen("gibberish", now), null);
});

test("sync + inbox + splits", async () => {
  const { iris, acct } = await demo();
  const inbox = iris.list({ accountId: acct, view: "inbox" });
  assert.ok(inbox.total >= 10, `inbox has ${inbox.total}`);
  const splits = iris.splitsWithCounts(acct);
  const important = splits.find((s) => s.builtin === "important")!;
  const other = splits.find((s) => s.builtin === "other")!;
  assert.equal(important.count + other.count, inbox.total);
  const custom = iris.createSplit(acct, { name: "Lists", query: "list:*" });
  const counts = iris.splitsWithCounts(acct);
  assert.ok(counts.find((s) => s.id === custom.id)!.count >= 2);
  iris.close();
});

test("mark done, undo, trash", async () => {
  const { iris, acct, fake } = await demo();
  const first = iris.list({ accountId: acct, view: "inbox" }).threads[0];
  iris.markDone(acct, [first.id]);
  assert.ok(!iris.list({ accountId: acct, view: "inbox" }).threads.some((t) => t.id === first.id));
  await iris.flush(acct);
  assert.ok(!(await fake.getThread(first.id))!.messages.some((m) => m.labelIds.includes("INBOX")));
  iris.undo();
  await iris.flush(acct);
  assert.ok(iris.list({ accountId: acct, view: "inbox" }).threads.some((t) => t.id === first.id));
  iris.trash(acct, [first.id]);
  assert.ok(iris.list({ accountId: acct, view: "trash" }).threads.some((t) => t.id === first.id));
  iris.close();
});

test("remind me: returns to inbox, reply cancels if-no-reply", async () => {
  const { iris, acct, fake } = await demo();
  const [a, b] = iris.list({ accountId: acct, view: "inbox" }).threads;
  await iris.remind(acct, [a.id], "tomorrow");
  await iris.remind(acct, [b.id], "in 2 days", { ifNoReply: true });
  assert.equal(iris.list({ accountId: acct, view: "reminders" }).total, 2);
  assert.ok(!iris.list({ accountId: acct, view: "inbox" }).threads.some((t) => t.id === a.id));
  // time travel
  iris.db.run("UPDATE reminders SET remind_at = ? WHERE thread_id = ?", Date.now() - 1, a.id);
  await iris.processReminders();
  const back = iris.list({ accountId: acct, view: "inbox" }).threads;
  assert.equal(back[0].id, a.id, "returned thread is on top");
  // a reply in b cancels its reminder
  fake.deliver({ threadId: b.id, from: { name: "Someone", email: "someone@x.example" }, subject: "Re: x", bodyText: "answer" });
  await iris.sync.sync(acct);
  assert.equal(iris.reminders(acct).length, 0);
  iris.close();
});

test("send with undo window, cancel, reply threading, bcc kept", async () => {
  const { iris, acct, fake } = await demo();
  iris.settings.undoSendSeconds = 60;
  const t = iris.list({ accountId: acct, view: "inbox", q: "pilot" }).threads[0];
  assert.ok(t, "pilot thread exists");
  const draft = iris.replyDraft(acct, t.id, "replyAll");
  assert.equal((draft.to as { email: string }[])[0].email, "a.weber@acme.example");
  const item = iris.send({ ...draft, html: "<p>Sure, docs attached soon.</p>", bcc: "boss@x.example" });
  assert.equal(item.status, "queued");
  iris.cancelSend(item.id);
  await iris.processOutbox();
  assert.equal(fake.sent.length, 0);
  const item2 = iris.send({ ...draft, html: "<p>Sending now.</p>", bcc: "boss@x.example" }, { instant: true });
  await iris.processOutbox();
  assert.equal(iris.outboxItem(item2.id)!.status, "sent");
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].raw, /In-Reply-To: <.+@demo\.iris>/);
  assert.match(fake.sent[0].raw, /Bcc: boss@x\.example/);
  assert.equal(fake.sent[0].threadId, t.id);
  const thread = await iris.thread(acct, t.id);
  assert.ok(thread!.messages.some((m) => m.isSent && /Sending now/.test(m.bodyHtml)));
  iris.close();
});

test("search local + snippets", async () => {
  const { iris, acct } = await demo();
  assert.ok(iris.searchLocal(acct, "flight").length >= 1);
  assert.ok(iris.searchLocal(acct, "from:github").length >= 1);
  assert.ok(iris.searchLocal(acct, "has:attachment").length >= 3);
  const s = iris.saveSnippet({ name: "intro", html: "Hi {first_name}, I'm {my_first_name}." });
  const e = iris.expandSnippet(s.id, { to: "Lena Hoffmann <lena@x.vc>", accountId: acct });
  assert.equal(e.html, "Hi Lena, I'm Demo.");
  iris.close();
});

test("mime builder", async () => {
  const raw = (await buildMime({ to: "a@b.c", subject: "Grüße", html: "<b>hi</b>" }, { name: "Me", email: "me@x.y" })).toString();
  assert.match(raw, /Subject: =\?UTF-8\?Q\?Gr=C3=BC=C3=9Fe\?=/i);
  assert.match(raw, /text\/html/);
});
