// Unified accounts at a real mailbox size: /api/mailboxes data and account=all lists stay fast.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Iris } from "../src/service.ts";
import type { Message } from "../src/types.ts";

process.env.IRIS_SECRETS = "file";

const A = "me@perf.local";
const B = "work@perf.local";

/** `inbox` inbox threads (+ archived, starred, spam, trash, labeled) for one account, the mix of a real mailbox. */
function seed(iris: Iris, me: string, inbox: number, archived: number, offsetHours: number): void {
  iris.store.upsertAccount({ id: me, email: me, name: me, provider: "fake" });
  iris.store.replaceLabels(me, [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "UNREAD", name: "UNREAD", type: "system" },
    { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
    { id: "STARRED", name: "STARRED", type: "system" },
    { id: "SPAM", name: "SPAM", type: "system" },
    { id: "TRASH", name: "TRASH", type: "system" },
    { id: "Label_1", name: "Clients/VIP", type: "user" },
    { id: "Label_2", name: "Travel", type: "user" },
  ]);
  iris.db.tx(() => {
    for (let i = 0; i < inbox + archived; i++) {
      const tid = `t${i}`;
      const labels = [
        ...(i < inbox ? ["INBOX"] : i % 10 === 0 ? ["SPAM"] : i % 10 === 1 ? ["TRASH"] : []),
        ...(i % 3 === 0 ? ["UNREAD"] : []),
        ...(i % 5 === 0 ? ["IMPORTANT"] : []),
        ...(i % 29 === 0 ? ["STARRED"] : []),
        ...(i % 17 === 0 ? ["Label_1"] : []),
        ...(i % 23 === 0 ? ["Label_2"] : []),
      ];
      const msgs: Message[] = [];
      for (let j = 0; j < 1 + (i % 3); j++) {
        msgs.push({
          id: `${tid}m${j}`,
          threadId: tid,
          accountId: me,
          date: Date.now() - (i + offsetHours) * 3_600_000 + j * 60_000,
          from: i % 7 === 0 ? { name: "GitHub", email: "notifications@github.com" } : { name: `Person ${i % 300}`, email: `p${i % 300}@example.com` },
          to: [{ name: "Me", email: me }],
          cc: [],
          bcc: [],
          replyTo: [],
          subject: `Subject ${i}`,
          snippet: `snippet ${i}`,
          labelIds: labels,
          messageIdHeader: `<${tid}.${j}@perf>`,
          references: "",
          inReplyTo: "",
          listId: i % 4 === 0 ? `<news${i % 20}.example.com>` : "",
          listUnsubscribe: "",
          listUnsubscribePost: "",
          bodyHtml: "",
          bodyText: `body of ${i} with some words alpha beta gamma`,
          attachments: [],
          isDraft: false,
          isSent: false,
        });
      }
      iris.store.saveThread(me, tid, msgs, [me]);
    }
  });
  iris.ensureDefaultSplits(me);
}

function best(n: number, fn: () => unknown): number {
  let m = Infinity;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    m = Math.min(m, performance.now() - t);
  }
  return m;
}

test("mailboxes + account=all lists stay fast on two accounts x ~1,600 inbox threads", (t) => {
  const iris = new Iris({ home: fs.mkdtempSync(path.join(os.tmpdir(), "iris-uni-perf-")) });
  seed(iris, A, 1600, 400, 0);
  seed(iris, B, 1600, 400, 0.5); // half an hour older: interleaves with A
  iris.createSplit(B, { name: "GitHub", query: "from:github.com" });

  const cold = best(1, () => iris.mailboxes());
  const m = iris.mailboxes();
  assert.deepEqual(m.accounts.map((a) => a.counts.inbox), [1600, 1600]);
  assert.equal(m.unified.inbox, 3200);
  const [ma, mb] = m.accounts;
  assert.equal(ma.counts.important + ma.counts.other, 1600);
  assert.ok(mb.counts.important + mb.counts.other < 1600, "B's custom split claims some threads");
  assert.equal(ma.counts.spam, 40);
  assert.equal(ma.counts.trash, 40);
  assert.equal(ma.counts.starred, iris.list({ accountId: A, view: "starred", limit: 1 }).total);
  const vip = ma.labels.find((l) => l.name === "Clients/VIP")!;
  assert.equal(vip.unread, iris.list({ accountId: A, view: "label", labelId: vip.id, filter: "unread", limit: 1 }).total);

  const warmMailboxes = best(10, () => iris.mailboxes());
  const warmInbox = best(10, () => iris.list({ accountId: "all", view: "inbox", limit: 100 }));
  const warmSplit = best(10, () => iris.list({ accountId: "all", view: "split", splitId: "builtin:important", limit: 100 }));
  const warmSplits = best(10, () => iris.splitsWithCounts("all"));
  const singleInbox = best(10, () => iris.list({ accountId: A, view: "inbox", limit: 100 }));
  const rebuild = best(3, () => {
    iris.store.setAiLabels(A, "t1", [`x${Math.random()}`]);
    iris.mailboxes();
  });
  t.diagnostic(
    `mailboxes cold ${cold.toFixed(1)} ms, warm ${warmMailboxes.toFixed(2)} ms, after a change ${rebuild.toFixed(1)} ms; ` +
      `all inbox ${warmInbox.toFixed(2)} ms (one account ${singleInbox.toFixed(2)} ms), all builtin:important ${warmSplit.toFixed(2)} ms, splits(all) ${warmSplits.toFixed(2)} ms`,
  );
  assert.ok(warmMailboxes < 30, `mailboxes warm ${warmMailboxes.toFixed(1)} ms`);
  assert.ok(warmInbox < 30, `account=all inbox warm ${warmInbox.toFixed(1)} ms`);
  assert.ok(warmSplit < 30, `account=all split warm ${warmSplit.toFixed(1)} ms`);
  assert.ok(warmSplits < 30, `splitsWithCounts(all) warm ${warmSplits.toFixed(1)} ms`);

  const page = iris.list({ accountId: "all", view: "inbox", limit: 4 }).threads;
  assert.deepEqual(page.map((x) => `${x.accountId}/${x.id}`), [`${A}/t0`, `${B}/t0`, `${A}/t1`, `${B}/t1`], "interleaved by date");
  iris.close();
  fs.rmSync(iris.home, { recursive: true, force: true });
});
