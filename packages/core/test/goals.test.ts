// Goals: progress math, CRUD, thread links.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Iris } from "../src/service.ts";
import { goalProgress, habitProgress, localDate, metricProgress } from "../src/goals.ts";
import { DB, MIGRATIONS } from "../src/db.ts";

process.env.IRIS_SECRETS = "file";

const DAY = 86_400_000;
const start = Date.UTC(2026, 0, 1);
const span = { startAt: start, dueAt: start + 84 * DAY, status: "active" as const };
const steps = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ doneAt: i < done ? start + DAY : null }));

test("pace compares steps done with time elapsed", () => {
  const halfway = start + 42 * DAY;
  assert.equal(goalProgress(span, steps(5, 10), halfway).pace, "on_track");
  assert.equal(goalProgress(span, steps(4, 10), halfway).pace, "on_track", "10 points behind is still on track");
  assert.equal(goalProgress(span, steps(3, 10), halfway).pace, "adjust");
  assert.equal(goalProgress(span, steps(2, 10), halfway).pace, "off_track");
  assert.equal(goalProgress(span, [], halfway).pace, "no_plan");
  assert.equal(goalProgress(span, steps(10, 10), halfway).pace, "done");
  assert.equal(goalProgress(span, steps(9, 10), start + 85 * DAY).pace, "off_track", "overdue is off track");
  const p = goalProgress(span, steps(2, 10), halfway);
  assert.deepEqual([p.day, p.totalDays, p.daysLeft, p.expectedPercent, p.stepsBehind], [43, 84, 42, 50, 3]);
});

test("weekly buckets stay inside the goal's weeks", () => {
  const p = goalProgress(span, [{ doneAt: start - DAY }, { doneAt: start + 8 * DAY }, { doneAt: start + 200 * DAY }, { doneAt: null }], start + 9 * DAY);
  assert.equal(p.weeks.length, 12);
  assert.equal(p.weeks[0].done, 1);
  assert.equal(p.weeks[1].done, 1);
  assert.equal(p.weeks[11].done, 1);
  assert.equal(p.doneLast7Days, 2, "only steps from the last 7 days");
});

test("goals: create, steps, links, completion, delete", async () => {
  const iris = new Iris({ demo: true });
  await iris.sync.sync("demo@iris.local", true);
  const events: string[] = [];
  iris.bus.onEvent((e) => events.push(e.type));
  const g = iris.goals.create({ title: " Ship v2 ", dueAt: "in 12 weeks", steps: ["Plan", " ", "Build"] });
  assert.equal(g.title, "Ship v2");
  assert.deepEqual(g.steps.map((s) => s.title), ["Plan", "Build"]);
  assert.ok(events.includes("goals-changed"));

  const added = iris.goals.addStep(g.id, "Ship");
  assert.deepEqual(added.steps.map((s) => s.title), ["Plan", "Build", "Ship"]);
  const checked = iris.goals.updateStep(g.id, g.steps[0].id, { done: true });
  assert.equal(checked.progress.doneSteps, 1);
  assert.equal(checked.progress.percent, 33);
  assert.equal(iris.goals.updateStep(g.id, g.steps[0].id, { done: false }).progress.doneSteps, 0);

  const t = iris.list({ accountId: "demo@iris.local", view: "inbox" }).threads[0];
  const linked = iris.goals.linkThread(g.id, t.accountId, t.id);
  assert.deepEqual(linked.threads.map((x) => x.subject), [t.subject]);
  assert.equal(iris.goals.linkThread(g.id, t.accountId, t.id).threads.length, 1, "linking twice is a no-op");
  assert.throws(() => iris.goals.linkThread(g.id, t.accountId, "nope"), /Thread not found/);
  assert.equal(iris.goals.unlinkThread(g.id, t.accountId, t.id).threads.length, 0);

  const done = iris.goals.update(g.id, { status: "done" });
  assert.equal(done.progress.pace, "done");
  assert.ok(done.completedAt);
  assert.equal(iris.goals.update(g.id, { status: "active" }).completedAt, null);

  assert.throws(() => iris.goals.create({ title: "x", dueAt: "2000-01-01" }), /after the start/);
  assert.throws(() => iris.goals.create({ title: "x", dueAt: "gibberish" }), /Could not understand/);
  assert.throws(() => iris.goals.create({ title: "  ", dueAt: "in 3 days" }), /title/);

  iris.goals.delete(g.id);
  assert.equal(iris.goals.list().length, 0);
  assert.equal(iris.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM goal_steps")?.n, 0, "steps cascade");
  iris.close();
});

test("trajectory: weekly gap to the pace, plus a projection once the goal has run a week", () => {
  const now = start + 21 * DAY;
  const p = goalProgress(span, [{ doneAt: start + 3 * DAY }, { doneAt: start + 10 * DAY }, { doneAt: null }, { doneAt: null }], now);
  assert.deepEqual(p.trajectory.map((x) => x.at), [start, start + 7 * DAY, start + 14 * DAY, now]);
  assert.deepEqual(p.trajectory.map((x) => x.percent), [0, 25, 50, 50]);
  assert.deepEqual(p.trajectory.map((x) => x.gap), [0, 17, 33, 25]);
  assert.deepEqual(p.projected, { at: span.dueAt, gap: 0 }, "ahead of pace caps at 100% done");
  assert.equal(goalProgress(span, steps(0, 2), start + 3 * DAY).projected, null, "too early to project");
  assert.deepEqual(goalProgress(span, [], now).trajectory, [], "no steps, no line");
  const late = goalProgress(span, steps(1, 4), start + 100 * DAY);
  assert.equal(late.trajectory.at(-1)?.at, span.dueAt, "the line stops at the due date");
  assert.equal(late.projected, null);
});

// ---- metric and habit goals
const entryGoal = { startAt: start, dueAt: start + 84 * DAY, status: "active" as const, startDate: "2026-01-01", dueDate: "2026-03-26" };
const metricGoal = { ...entryGoal, startValue: 115, targetValue: 105 };
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const at = (n: number) => start + n * DAY + 12 * 3_600_000;
const logged = (...days: number[]) => days.map((n) => ({ date: day(n), value: null }));

test("metric: percent runs from start to target, falling and rising, clamped to 0-100", () => {
  const p = (value: number, g = metricGoal) => metricProgress(g, [{ date: day(1), value }], at(2), day(2)).percent;
  assert.equal(p(115), 0);
  assert.equal(p(110), 50);
  assert.equal(p(105), 100);
  assert.equal(p(120), 0, "further from the target than the start");
  assert.equal(p(100), 100, "past the target");
  const rising = { ...entryGoal, startValue: 60, targetValue: 80 };
  assert.equal(p(70, rising), 50);
  assert.equal(p(50, rising), 0);
  assert.equal(p(90, rising), 100);
  const toZero = { ...entryGoal, startValue: 10, targetValue: 0 };
  assert.equal(p(0, toZero), 100, "a target of 0 is a real target");
  assert.equal(p(105.04), 99, "almost there doesn't round up to reached");
  assert.equal(metricProgress(metricGoal, [{ date: day(1), value: 105.04 }], at(2), day(2)).pace, "on_track");
});

test("metric: the newest day counts, not the newest insert, and the target today is linear", () => {
  const p = metricProgress(metricGoal, [{ date: day(5), value: 110 }, { date: day(2), value: 113 }], start + 42 * DAY, day(42));
  assert.equal(p.metric?.current, 110);
  assert.equal(p.metric?.lastDate, day(5));
  assert.equal(p.metric?.expected, 110, "halfway through the time, halfway from 115 to 105");
  const empty = metricProgress(metricGoal, [], start, day(0));
  assert.equal(empty.percent, 0, "no entry starts at 0%");
  assert.equal(empty.metric?.current, 115);
  assert.notEqual(empty.pace, "no_plan");
  assert.deepEqual([metricProgress(metricGoal, [], start, day(0)).trajectory.length, metricProgress(metricGoal, [], start + 15 * DAY, day(15)).trajectory.length], [1, 4]);
});

test("metric: pace uses the same limits as steps", () => {
  const halfway = start + 42 * DAY; // 50% expected
  const pace = (value: number) => metricProgress(metricGoal, [{ date: day(1), value }], halfway, day(42)).pace;
  assert.equal(pace(111), "on_track"); // 40%: 10 behind
  assert.equal(pace(111.5), "adjust"); // 35%: 15 behind
  assert.equal(pace(112.5), "adjust"); // 25%: 25 behind
  assert.equal(pace(113), "off_track"); // 20%: 30 behind
  assert.equal(pace(105), "done");
  assert.equal(metricProgress(metricGoal, [{ date: day(80), value: 106 }], start + 85 * DAY, day(85)).pace, "off_track", "overdue without reaching it");
  assert.equal(metricProgress({ ...metricGoal, status: "done" }, [], at(1), day(1)).percent, 100);
});

test("habit: logged days over days passed, today only counts once logged", () => {
  const p = (today: number, ...days: number[]) => habitProgress(entryGoal, logged(...days), at(today), day(today));
  const first = p(0);
  assert.deepEqual([first.percent, first.pace, first.habit?.elapsedDays], [0, "on_track", 0], "an open first morning isn't failing");
  assert.equal(p(0, 0).percent, 100);
  assert.deepEqual([p(1).percent, p(1).pace, p(1).habit?.elapsedDays], [0, "off_track", 1], "yesterday was missed");
  assert.deepEqual([p(4, 0, 1, 2, 3).percent, p(4, 0, 1, 2, 3).habit?.elapsedDays], [100, 4], "nothing due yet today");
  assert.deepEqual([p(4, 0, 1, 2, 3, 4).percent, p(4, 0, 1, 2, 3, 4).habit?.elapsedDays], [100, 5]);
  assert.equal(p(4, 0, 1).percent, 50);
  assert.equal(habitProgress(entryGoal, logged(83, 84), at(100), day(100)).habit?.elapsedDays, 85, "the count stops at the due date");
  assert.equal(habitProgress(entryGoal, logged(83, 84, 90), at(100), day(100)).habit?.loggedDays, 2, "days after the due date don't count");
  assert.notEqual(p(0).pace, "no_plan");
});

test("habit: pace uses the same limits as steps", () => {
  const pace = (hits: number) => habitProgress(entryGoal, logged(...Array.from({ length: hits }, (_, i) => i)), at(40), day(40)).pace;
  // 40 days passed, today open
  assert.equal(pace(36), "on_track"); // 90%: 10 behind
  assert.equal(pace(35), "adjust"); // 88%
  assert.equal(pace(30), "adjust"); // 75%: 25 behind
  assert.equal(pace(29), "off_track"); // 73%
});

test("habit: streak and last 7 days", () => {
  const h = (today: number, ...days: number[]) => habitProgress(entryGoal, logged(...days), at(today), day(today)).habit!;
  assert.equal(h(10, 7, 8, 9, 10).streak, 4);
  assert.equal(h(10, 7, 8, 9).streak, 3, "an unlogged today doesn't break it yet");
  assert.equal(h(10, 7, 8).streak, 0, "yesterday missed");
  assert.equal(h(10, 5, 6, 8, 9).streak, 2, "a gap ends it");
  assert.equal(h(0).streak, 0);
  assert.deepEqual([h(10, 4, 5, 6, 7, 8, 9, 10).last7, h(10, 4, 5, 6, 7, 8, 9, 10).last7Target], [7, 7]);
  assert.equal(h(10, 3, 4, 10).last7, 2, "day 3 is 7 days back, outside the window");
  // across a month and a year
  const dec = { ...entryGoal, startAt: Date.UTC(2026, 11, 20), dueAt: Date.UTC(2027, 1, 1), startDate: "2026-12-20", dueDate: "2027-02-01" };
  const across = habitProgress(dec, [{ date: "2026-12-31", value: null }, { date: "2027-01-01", value: null }], Date.UTC(2027, 0, 1, 12), "2027-01-01").habit!;
  assert.equal(across.streak, 2);
});

test("localDate: the calendar day of the zone the user is in", () => {
  const evening = Date.UTC(2026, 10, 4, 17, 0);
  assert.equal(localDate(evening, "Asia/Makassar"), "2026-11-05");
  assert.equal(localDate(evening, "Asia/Ho_Chi_Minh"), "2026-11-05");
  assert.equal(localDate(evening, "Europe/Berlin"), "2026-11-04");
  assert.equal(localDate(evening, "America/Los_Angeles"), "2026-11-04");
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test("entries: one per day, correctable, deletable, validated", async () => {
  const iris = new Iris({ demo: true });
  const today = localDate();
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  const startAt = Date.now() - 10 * DAY;
  const m = iris.goals.create({ title: "Weight", dueAt: "in 12 weeks", startAt, kind: "metric", startValue: 115, targetValue: 105, unit: "kg" });
  assert.deepEqual([m.kind, m.startValue, m.targetValue, m.unit, m.progress.percent], ["metric", 115, 105, "kg", 0]);

  iris.goals.logEntry(m.id, { value: 112 });
  assert.deepEqual(iris.goals.logEntry(m.id, { value: 111 }).entries, [{ date: today, value: 111 }], "a new value replaces the day");
  const both = iris.goals.logEntry(m.id, { value: 113, date: yesterday });
  assert.equal(both.entries.length, 2);
  assert.equal(both.progress.metric?.current, 111, "backfilling an older day doesn't change the current value");
  assert.throws(() => iris.goals.logEntry(m.id, { date: today }), /numeric value/);
  assert.throws(() => iris.goals.logEntry(m.id, { value: "112" as unknown as number }), /numeric value/);
  assert.throws(() => iris.goals.logEntry(m.id, { value: 110, date: tomorrow }), /future/);
  assert.throws(() => iris.goals.logEntry(m.id, { value: 110, date: "2026-02-31" }), /calendar date/);
  assert.throws(() => iris.goals.logEntry(m.id, { value: 110, date: "2020-01-01" }), /before this goal started/);
  assert.equal(iris.goals.deleteEntry(m.id, yesterday).entries.length, 1);
  assert.throws(() => iris.goals.deleteEntry(m.id, yesterday), /Unknown entry/);

  const h = iris.goals.create({ title: "Post", dueAt: "in 8 weeks", startAt, kind: "habit" });
  iris.goals.logEntry(h.id);
  const twice = iris.goals.logEntry(h.id);
  assert.deepEqual(twice.entries, [{ date: today, value: null }], "logging twice changes nothing");
  assert.equal(twice.progress.habit?.loggedDays, 1);
  assert.throws(() => iris.goals.logEntry(h.id, { value: 3 }), /no value/);
  assert.throws(() => iris.goals.addStep(h.id, "x"), /Only a steps goal/);

  const s = iris.goals.create({ title: "Plan", dueAt: "in 8 weeks", steps: ["One"] });
  assert.equal(s.kind, "steps");
  assert.throws(() => iris.goals.logEntry(s.id, { value: 1 }), /runs on steps/);
  assert.throws(() => iris.goals.update(s.id, { kind: "habit" }), /Remove the 1 steps/);
  assert.throws(() => iris.goals.update(m.id, { kind: "habit" }), /Delete the 1 entries/);
  assert.throws(() => iris.goals.create({ title: "x", dueAt: "in 3 days", kind: "metric", startValue: 5, targetValue: 5 }), /must differ/);
  assert.throws(() => iris.goals.create({ title: "x", dueAt: "in 3 days", kind: "metric", startValue: 5 }), /numeric start and target/);
  assert.throws(() => iris.goals.create({ title: "x", dueAt: "in 3 days", kind: "habit", steps: ["a"] }), /no steps/);
  assert.throws(() => iris.goals.create({ title: "x", dueAt: "in 3 days", kind: "habit", unit: "kg" }), /only apply/);

  iris.goals.delete(m.id);
  assert.equal(iris.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM goal_entries WHERE goal_id = ?", m.id)?.n, 0, "entries cascade");
  iris.close();
});

test("a goal without steps or entries can change kind, keeping its dates", () => {
  const iris = new Iris({ demo: true });
  const g = iris.goals.create({ title: "Abnehmen", why: "Warum", dueAt: "in 8 weeks" });
  assert.equal(g.progress.pace, "no_plan");
  const m = iris.goals.update(g.id, { kind: "metric", startValue: 115, targetValue: 105, unit: "kg" });
  assert.deepEqual([m.kind, m.startValue, m.targetValue, m.unit, m.startAt, m.dueAt, m.why, m.title], ["metric", 115, 105, "kg", g.startAt, g.dueAt, "Warum", "Abnehmen"]);
  assert.equal(m.startDate, localDate(g.startAt));
  assert.notEqual(m.progress.pace, "no_plan");
  assert.equal(iris.goals.update(g.id, { targetValue: 100 }).targetValue, 100);
  assert.equal(iris.goals.update(g.id, { title: "Neu" }).startValue, 115, "other edits keep the metric");
  const h = iris.goals.update(g.id, { kind: "habit" });
  assert.deepEqual([h.kind, h.startValue, h.targetValue, h.unit], ["habit", null, null, ""]);
  iris.close();
});

test("migration: a database from before goal kinds keeps every goal as it was", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-mig-"));
  const file = path.join(dir, "iris.db");
  const old = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 4)) old.exec(m);
  old.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (4);");
  old.exec(`INSERT INTO goals (id, title, why, start_at, due_at, status, created_at, updated_at) VALUES ('gl_a', 'Old', 'Why', ${start}, ${start + 84 * DAY}, 'active', 1, 2)`);
  old.exec("INSERT INTO goal_steps (id, goal_id, title, position, done_at) VALUES ('s1', 'gl_a', 'One', 0, 5), ('s2', 'gl_a', 'Two', 1, NULL)");
  old.close();

  const db = new DB(file);
  assert.equal(db.get<{ version: number }>("SELECT version FROM schema_version")?.version, MIGRATIONS.length);
  const r = db.get<Record<string, unknown>>("SELECT * FROM goals WHERE id = 'gl_a'")!;
  assert.deepEqual([r.title, r.why, r.start_at, r.status, r.updated_at], ["Old", "Why", start, "active", 2]);
  assert.deepEqual([r.kind, r.start_value, r.target_value, r.unit, r.start_date], ["steps", null, null, "", null]);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM goal_steps")?.n, 2);
  db.run("INSERT INTO goal_entries (goal_id, date, value, created_at, updated_at) VALUES ('gl_a', '2026-01-02', NULL, 1, 1)");
  assert.throws(() => db.run("INSERT INTO goal_entries (goal_id, date, value, created_at, updated_at) VALUES ('gl_a', '2026-01-02', NULL, 1, 1)"), /UNIQUE/);
  db.close();
  const again = new DB(file);
  assert.equal(again.get<{ version: number }>("SELECT version FROM schema_version")?.version, MIGRATIONS.length, "reopening is a no-op");
  again.close();
  fs.rmSync(dir, { recursive: true });
});
