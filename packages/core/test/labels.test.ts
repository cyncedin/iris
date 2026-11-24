// Label cleanup: backup, guarded purge, unclassified threads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Iris } from "../src/service.ts";

process.env.IRIS_SECRETS = "file";
const A = "demo@iris.local";

test("purge: needs a backup and the approved count, keeps mail and Iris labels", async () => {
  const iris = new Iris({ demo: true });
  await iris.sync.sync(A, true);
  const t = iris.list({ accountId: A, view: "inbox" }).threads[0];
  const own = await iris.ensureLabel(A, "Parent/Child");
  await iris.ensureLabel(A, "Parent");
  await iris.ensureLabel(A, "Iris/Reminders");
  await iris.provider(A).modifyThread(t.id, [own.id], []);
  await iris.sync.sync(A, true);
  const count = iris.labels(A).filter((l) => l.type === "user" && !l.name.startsWith("Iris/")).length;

  await assert.rejects(iris.purgeLabels(A, count), /backup first/);
  const b = await iris.backupLabels(A);
  assert.equal(b.labels.find((l) => l.name === "Parent/Child")?.threads, 1);
  assert.equal(b.labels.length, count);
  assert.ok(!b.labels.some((l) => l.name.startsWith("Iris/")));
  const saved = JSON.parse(fs.readFileSync(b.file, "utf8"));
  assert.deepEqual(saved.labels.find((l: { name: string }) => l.name === "Parent/Child").threadIds, [t.id]);

  await assert.rejects(iris.purgeLabels(A, count + 1), /Nothing was deleted/);
  assert.ok(iris.labels(A).some((l) => l.name === "Parent"));

  const r = await iris.purgeLabels(A, count);
  assert.equal(r.deleted.length, count);
  assert.deepEqual(r.failed, []);
  assert.ok(r.deleted.indexOf("Parent/Child") < r.deleted.indexOf("Parent"), "children first");
  assert.deepEqual(iris.labels(A).filter((l) => l.type === "user").map((l) => l.name), ["Iris/Reminders"]);
  const after = iris.list({ accountId: A, view: "inbox" }).threads.find((x) => x.id === t.id);
  assert.ok(after, "the mail stays");
  assert.ok(!after.labelIds.includes(own.id), "local cache is clean");
  iris.close();
});

test("unclassifiedThreads skips labelled, spam and trash", async () => {
  const iris = new Iris({ demo: true });
  await iris.sync.sync(A, true);
  const all = iris.unclassifiedThreads(A);
  assert.ok(all.length > 2);
  iris.store.setAiLabels(A, all[0], []);
  await iris.trash(A, [all[1]]);
  const left = iris.unclassifiedThreads(A);
  assert.ok(!left.includes(all[0]), "an empty result counts as classified");
  assert.ok(!left.includes(all[1]), "trash is never sent to a model");
  iris.close();
});

test("All Mail hides threads whose labels are all unchecked", async () => {
  const iris = new Iris({ demo: true });
  await iris.sync.sync(A, true);
  const [a, b, c] = iris.list({ accountId: A, view: "all" }).threads;
  iris.store.setAiLabels(A, a.id, ["News"]);
  iris.store.setAiLabels(A, b.id, ["News", "Finance"]);
  iris.store.setAiLabels(A, c.id, []);
  const ids = (q: object) => iris.list({ accountId: A, view: "all", limit: 500, ...q }).threads.map((t) => t.id);
  const hidden = ids({ hideLabels: ["News"] });
  assert.ok(!hidden.includes(a.id));
  assert.ok(hidden.includes(b.id), "a second, checked label keeps it visible");
  assert.ok(hidden.includes(c.id));
  assert.ok(!ids({ hideUnlabeled: true }).includes(c.id));
  assert.ok(ids({ hideUnlabeled: true }).includes(a.id));
  const r = iris.list({ accountId: A, view: "all", hideLabels: ["News"], limit: 1, offset: 0 });
  assert.equal(r.threads.length, 1);
  assert.equal(r.total, hidden.length, "total follows the filter, so paging stays right");
  iris.settings.ai.autoLabelCategories = ["Finance", "News"];
  const m = iris.mailboxLabels(A);
  assert.deepEqual(m.labels, [{ name: "Finance", count: 1 }, { name: "News", count: 2 }]);
  assert.equal(m.total, iris.list({ accountId: A, view: "all" }).total);
  assert.equal(m.unlabeled, m.total - 2);
  iris.close();
});

test("purge keeps labels the user excluded", async () => {
  const iris = new Iris({ demo: true });
  await iris.sync.sync(A, true);
  await iris.ensureLabel(A, "Keep me");
  await iris.ensureLabel(A, "Drop me");
  await iris.backupLabels(A);
  const n = iris.labels(A).filter((l) => l.type === "user").length;
  const r = await iris.purgeLabels(A, n - 1, ["Keep me"]);
  assert.ok(!r.deleted.includes("Keep me"));
  assert.ok(iris.labels(A).some((l) => l.name === "Keep me"));
  iris.close();
});

test("backfill loads what the cache misses, quietly, and resumes", async () => {
  const iris = new Iris({ demo: true });
  await iris.sync.sync(A, true);
  const all = iris.list({ accountId: A, view: "all" }).threads;
  const gone = all.slice(0, 3).map((t) => t.id);
  for (const id of gone) iris.store.deleteThread(A, id);
  assert.equal(iris.list({ accountId: A, view: "all" }).total, all.length - 3);
  let notified = 0;
  iris.sync.onNewMessages = async () => void notified++;
  await iris.sync.backfill(A);
  assert.equal(iris.list({ accountId: A, view: "all" }).total, all.length);
  assert.equal(notified, 0, "old mail never notifies or reaches the classifier");
  assert.equal(iris.db.kvGet(`backfill:${A}`), "done");
  assert.equal((await iris.mailboxCoverage(A))[0].backfill, "done");
  iris.close();
});
