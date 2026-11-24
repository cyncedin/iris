// Split inbox: speed on a realistic mailbox size, memo invalidation, and equivalence with the plain per-thread evaluation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Iris } from "../src/service.ts";
import { evaluate, isEmptyQuery, parseQuery, type QueryTarget } from "../src/query.ts";
import type { Message } from "../src/types.ts";

process.env.IRIS_SECRETS = "file";

const ME = "me@perf.local";
const WORDS = "alpha beta gamma delta invoice meeting project update release notes budget travel".split(" ");

function words(n: number, seed: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += WORDS[(seed * 31 + i * 7) % WORDS.length] + " ";
  return s;
}

/** ~2,000 inbox threads (+ archived ones), 1-3 messages each, the label/list/attachment mix of a real mailbox. */
function syntheticIris(inbox = 2000, archived = 200): Iris {
  const iris = new Iris({ home: fs.mkdtempSync(path.join(os.tmpdir(), "iris-perf-")) });
  iris.store.upsertAccount({ id: ME, email: ME, name: "Me", provider: "fake" });
  iris.store.replaceLabels(ME, [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "UNREAD", name: "UNREAD", type: "system" },
    { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
    { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
    { id: "Label_1", name: "Clients/VIP", type: "user" },
  ]);
  iris.db.tx(() => {
    for (let i = 0; i < inbox + archived; i++) {
      const tid = `t${i}`;
      const labels = [
        ...(i < inbox ? ["INBOX"] : []),
        ...(i % 3 === 0 ? ["UNREAD"] : []),
        ...(i % 5 === 0 ? ["IMPORTANT"] : []),
        ...(i % 4 === 0 ? ["CATEGORY_PROMOTIONS"] : []),
        ...(i % 17 === 0 ? ["Label_1"] : []),
      ];
      const msgs: Message[] = [];
      for (let j = 0; j < 1 + (i % 3); j++) {
        msgs.push({
          id: `${tid}m${j}`,
          threadId: tid,
          accountId: ME,
          date: Date.now() - i * 3_600_000 + j * 60_000,
          from: i % 7 === 0 ? { name: "GitHub", email: "notifications@github.com" } : { name: `Person ${i % 300}`, email: `p${i % 300}@example.com` },
          to: [{ name: "Me", email: ME }],
          cc: [],
          bcc: [],
          replyTo: [],
          subject: i % 11 === 0 ? `Invitation: sync ${i}` : `Subject ${i} ${words(4, i)}`,
          snippet: words(12, i + j),
          labelIds: labels,
          messageIdHeader: `<${tid}.${j}@perf>`,
          references: "",
          inReplyTo: "",
          listId: i % 4 === 0 ? `<news${i % 20}.example.com>` : "",
          listUnsubscribe: "",
          listUnsubscribePost: "",
          bodyHtml: "",
          bodyText: words(150, i * 3 + j),
          attachments: i % 13 === 0 ? [{ id: "a1", filename: i % 26 === 0 ? "invite.ics" : "doc.pdf", mimeType: "application/octet-stream", size: 10, inline: false }] : [],
          isDraft: false,
          isSent: false,
        });
      }
      iris.store.saveThread(ME, tid, msgs, [ME]);
      if (i % 9 === 0) iris.store.setAiLabels(ME, tid, ["Newsletter"]);
    }
  });
  iris.ensureDefaultSplits(ME);
  for (const s of iris.splits(ME)) if (!s.builtin) iris.updateSplit(ME, s.id, { enabled: true });
  iris.createSplit(ME, { name: "GitHub", query: "from:github.com" });
  iris.createSplit(ME, { name: "AI News", query: "label:ai/newsletter", leaveInImportantOther: true });
  iris.createSplit(ME, { name: "VIP", query: "label:clients/vip OR is:starred" });
  return iris;
}

function ms(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function best(n: number, fn: () => unknown): number {
  let m = Infinity;
  for (let i = 0; i < n; i++) m = Math.min(m, ms(fn));
  return m;
}

/** The straightforward algorithm (one FTS lookup + one parse per thread and split): the semantics the fast path must keep. */
function referenceAssignment(iris: Iris, accountId: string): Map<string, string[]> {
  const names = new Map(iris.store.labels(accountId).map((l) => [l.id, l.name.toLowerCase()]));
  const muted = iris.store.labelByName(accountId, "Iris/Muted")?.id ?? null;
  const snoozed = new Set(
    iris.db.all<{ thread_id: string }>("SELECT thread_id FROM reminders WHERE account_id = ? AND status = 'pending'", accountId).map((r) => r.thread_id),
  );
  const matches = (q: string, t: QueryTarget) => {
    const node = parseQuery(q.replace(/list:\*/g, "list:@@any@@"));
    return isEmptyQuery(node) || evaluate(node, t);
  };
  const splits = iris.splits(accountId).filter((s) => s.enabled);
  const important = splits.find((s) => s.builtin === "important");
  const other = splits.find((s) => s.builtin === "other");
  const out = new Map(splits.map((s) => [s.id, [] as string[]]));
  for (const t of iris.inboxThreads(accountId)) {
    const f = iris.store.ftsText(accountId, t.id);
    const body = (f?.body ?? t.snippet).toLowerCase();
    const tg: QueryTarget = {
      subject: t.subject.toLowerCase(),
      from: (f?.from ?? t.participants.map((p) => `${p.name} ${p.email}`).join(" ")).toLowerCase(),
      to: (f?.to ?? "").toLowerCase(),
      body,
      labelIds: t.labelIds,
      labelNames: [...t.labelIds.map((l) => names.get(l) ?? l.toLowerCase()), ...(t.aiLabels ?? []).map((l) => `ai/${l.toLowerCase()}`)],
      listId: t.listId ? `${t.listId.toLowerCase()} @@any@@` : "",
      attachments: t.hasAttachments ? body : "",
      lastDate: t.lastDate,
      unread: t.unread,
      starred: t.starred,
      important: t.important,
      snoozed: snoozed.has(t.id),
      muted: !!muted && t.labelIds.includes(muted),
    };
    let claimed = false;
    for (const s of splits.filter((x) => !x.builtin)) {
      if (s.query && matches(s.query, tg)) {
        out.get(s.id)!.push(t.id);
        if (!s.leaveInImportantOther) claimed = true;
        break;
      }
    }
    if (claimed) continue;
    const isImportant = important ? (important.query ? matches(important.query, tg) : t.important) : false;
    if (important && isImportant) out.get(important.id)!.push(t.id);
    else if (other) out.get(other.id)!.push(t.id);
    else if (important) out.get(important.id)!.push(t.id);
  }
  return out;
}

function assertSameAsReference(iris: Iris, accountId: string): void {
  const ref = referenceAssignment(iris, accountId);
  for (const s of iris.splitsWithCounts(accountId)) {
    const ids = iris.list({ accountId, view: "split", splitId: s.id, limit: 100_000 }).threads.map((t) => t.id);
    assert.deepEqual(ids, ref.get(s.id), `split ${s.name}`);
    assert.equal(s.count, ref.get(s.id)!.length, `count ${s.name}`);
  }
}

test("split counts + split lists stay fast on ~2,000 inbox threads", () => {
  const iris = syntheticIris();
  const splits = iris.splitsWithCounts(ME); // first build
  const inbox = iris.list({ accountId: ME, view: "inbox" }).total;
  assert.equal(inbox, 2000);
  assert.ok(splits.length >= 7, "custom + builtin splits enabled");
  const other = splits.find((s) => s.builtin === "other")!;
  const github = splits.find((s) => s.name === "GitHub")!;
  assert.ok(github.count > 100 && other.count > 100, `${github.count} / ${other.count}`);
  const warmCounts = best(5, () => iris.splitsWithCounts(ME));
  const warmList = best(5, () => iris.list({ accountId: ME, view: "split", splitId: other.id }));
  assert.ok(warmCounts < 150, `splitsWithCounts warm ${warmCounts.toFixed(1)} ms`);
  assert.ok(warmList < 150, `split list warm ${warmList.toFixed(1)} ms`);
  // after a write the memo is rebuilt: still one FTS scan, not one per thread
  const rebuild = best(3, () => {
    iris.store.setAiLabels(ME, "t1", [`x${Math.random()}`]);
    iris.splitsWithCounts(ME);
  });
  assert.ok(rebuild < 400, `rebuild after a change ${rebuild.toFixed(1)} ms`);
  const filtered = best(3, () => iris.list({ accountId: ME, view: "inbox", q: "from:github" }));
  assert.ok(filtered < 400, `inbox q= filter ${filtered.toFixed(1)} ms`);
  iris.close();
  fs.rmSync(iris.home, { recursive: true, force: true });
});

test("split memo invalidates on label, AI label, importance, split and inbox changes", async () => {
  const iris = new Iris({ demo: true });
  const acct = "demo@iris.local";
  await iris.sync.sync(acct, true);
  iris.ensureDefaultSplits(acct);
  const vip = iris.createSplit(acct, { name: "VIP", query: "label:clients/vip" });
  const ai = iris.createSplit(acct, { name: "Receipts", query: "label:ai/receipts" });
  const count = (id: string) => iris.splitsWithCounts(acct).find((s) => s.id === id)!.count;
  const ids = (id: string) => iris.list({ accountId: acct, view: "split", splitId: id }).threads.map((t) => t.id);
  const important = iris.splits(acct).find((s) => s.builtin === "important")!;
  const other = iris.splits(acct).find((s) => s.builtin === "other")!;

  assert.equal(count(vip.id), 0);
  const target = iris.list({ accountId: acct, view: "split", splitId: other.id }).threads[0];
  assert.ok(target, "a thread in Other");
  // user label (creates the label → replaceLabels, then an optimistic label change)
  await iris.addLabel(acct, [target.id], "Clients/VIP");
  assert.equal(count(vip.id), 1);
  assert.deepEqual(ids(vip.id), [target.id]);
  assert.ok(!ids(other.id).includes(target.id), "claimed by the custom split");
  iris.removeLabel(acct, [target.id], "Clients/VIP");
  assert.equal(count(vip.id), 0);
  assert.ok(ids(other.id).includes(target.id));
  // AI label
  iris.store.setAiLabels(acct, target.id, ["Receipts"]);
  assert.deepEqual(ids(ai.id), [target.id]);
  iris.store.setAiLabels(acct, target.id, []);
  assert.equal(count(ai.id), 0);
  // importance moves it between the built-ins
  iris.markImportant(acct, [target.id], true);
  assert.ok(ids(important.id).includes(target.id) && !ids(other.id).includes(target.id));
  iris.markImportant(acct, [target.id], false);
  assert.ok(ids(other.id).includes(target.id));
  // split query edits and deletes
  iris.updateSplit(acct, vip.id, { query: `subject:"${target.subject.toLowerCase().slice(0, 12)}"` });
  assert.ok(ids(vip.id).includes(target.id));
  iris.deleteSplit(acct, vip.id);
  assert.equal(iris.splitsWithCounts(acct).find((s) => s.id === vip.id), undefined);
  // done → leaves the inbox and every split
  const before = iris.list({ accountId: acct, view: "inbox" }).total;
  iris.markDone(acct, [target.id]);
  assert.equal(iris.list({ accountId: acct, view: "inbox" }).total, before - 1);
  assert.ok(!iris.splitsWithCounts(acct).some((s) => ids(s.id).includes(target.id)));
  await iris.flush(acct);
  iris.close();
});

test("split assignment matches the per-thread reference evaluation", async () => {
  const iris = new Iris({ demo: true });
  const acct = "demo@iris.local";
  await iris.sync.sync(acct, true);
  iris.ensureDefaultSplits(acct);
  for (const s of iris.splits(acct)) if (!s.builtin) iris.updateSplit(acct, s.id, { enabled: true });
  // ordered so every custom split gets hits on the demo mailbox (first match wins, also for leave-in-Important/Other)
  iris.createSplit(acct, { name: "Text", query: "pilot OR \"data protection\"" });
  iris.createSplit(acct, { name: "Files", query: "has:attachment -filename:ics" });
  iris.createSplit(acct, { name: "From", query: "from:github OR from:(weber OR klein)" });
  iris.createSplit(acct, { name: "Recent", query: "newer_than:1d is:unread" });
  iris.createSplit(acct, { name: "To", query: "to:demo -is:unread -list:* subject:re", leaveInImportantOther: true });
  iris.createSplit(acct, { name: "Empty", query: "   " }); // parses to nothing → takes the rest, like before
  const counts = iris.splitsWithCounts(acct);
  for (const name of ["Calendar", "News", "Text", "Files", "From", "Recent", "To", "Empty"]) {
    assert.ok(counts.find((s) => s.name === name)!.count > 0, `${name} has threads`);
  }
  assertSameAsReference(iris, acct);
  // and after the memo was used once, still the same result
  assertSameAsReference(iris, acct);
  iris.close();
});
