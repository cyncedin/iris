// Goals and progress: goals with steps, a number (metric) or a daily yes/no (habit), plus linked threads.
// Pace = progress vs. what is due by now (On track / Adjust / Off track).
import fs from "node:fs";
import { uid, type DB } from "./db.ts";
import type { Bus } from "./events.ts";
import type { Goal, GoalEntry, GoalKind, GoalPace, GoalProgress, GoalStep, GoalThread } from "./types.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** percentage points behind the expected pace that still count as on track / adjust */
const ON_TRACK_GAP = 10;
const ADJUST_GAP = 25;

interface GoalRow {
  id: string;
  title: string;
  why: string;
  start_at: number;
  due_at: number;
  status: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  kind: string;
  start_value: number | null;
  target_value: number | null;
  unit: string;
  start_date: string | null;
}

interface StepRow {
  id: string;
  goal_id: string;
  title: string;
  done_at: number | null;
}

export interface GoalInput {
  title: string;
  why?: string;
  /** epoch ms, YYYY-MM-DD (end of that day) or natural language ("in 12 weeks") */
  dueAt: number | string;
  startAt?: number;
  steps?: string[];
  kind?: GoalKind;
  startValue?: number;
  targetValue?: number;
  unit?: string;
}

export type GoalPatch = Partial<Pick<GoalInput, "title" | "why" | "dueAt" | "kind" | "startValue" | "targetValue" | "unit">> & { status?: "active" | "done" };

/**
 * The Mac's time zone right now. A running Node process keeps the zone it started with, and the daemon runs for days
 * while the user crosses time zones, so this reads the system setting each time.
 */
export function currentTimeZone(): string {
  if (process.env.TZ) return process.env.TZ;
  try {
    const zone = fs.readlinkSync("/etc/localtime").split("zoneinfo/")[1];
    if (zone) return zone;
  } catch {
    /* no symlink on this system */
  }
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Calendar day (YYYY-MM-DD) of a moment in a time zone. */
export function localDate(at = Date.now(), timeZone = currentTimeZone()): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => p.find((x) => x.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Days since the epoch. Plain calendar arithmetic, so daylight saving and travel can't skew it. */
function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
}

function isDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface EntryGoal {
  startAt: number;
  dueAt: number;
  status: "active" | "done";
  startDate: string;
  /** calendar day of dueAt */
  dueDate: string;
}

/** What every kind reports the same way. */
function timeline(g: { startAt: number; dueAt: number }, now: number) {
  const span = Math.max(DAY, g.dueAt - g.startAt);
  const totalDays = Math.ceil(span / DAY);
  return {
    span,
    totalDays,
    day: Math.max(1, Math.min(totalDays, Math.floor((now - g.startAt) / DAY) + 1)),
    daysLeft: Math.max(0, Math.ceil((g.dueAt - now) / DAY)),
    expectedPercent: Math.max(0, Math.min(100, Math.round(((now - g.startAt) / span) * 100))),
    weeks: Array.from({ length: Math.max(1, Math.ceil(span / WEEK)) }, (_, i) => ({ start: g.startAt + i * WEEK, done: 0 })),
  };
}

function paceFor(gap: number): GoalPace {
  return gap > ADJUST_GAP ? "off_track" : gap > ON_TRACK_GAP ? "adjust" : "on_track";
}

/** Day offsets of the chart points since the first day: every 7th, then the last one. */
function chartDays(last: number): number[] {
  const days: number[] = [];
  for (let d = 0; d < last; d += 7) days.push(d);
  days.push(Math.max(0, last));
  return days;
}

/** Share of the way from start to target (also for rising targets), 0-1 and not clamped. */
function metricShare(start: number, target: number, value: number): number {
  return (start - value) / (start - target);
}

function metricPercent(start: number, target: number, value: number): number {
  const share = metricShare(start, target, value);
  if (share >= 1) return 100;
  // 99.6% rounds to 100, but only a reached target may read as 100%
  return Math.min(99, Math.max(0, Math.round(share * 100)));
}

export function metricProgress(g: EntryGoal & { startValue: number; targetValue: number }, entries: GoalEntry[], now = Date.now(), today = localDate(now)): GoalProgress {
  const t = timeline(g, now);
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const lastEntry = sorted[sorted.length - 1];
  const current = lastEntry?.value ?? g.startValue;
  const reached = metricShare(g.startValue, g.targetValue, current) >= 1;
  const percent = g.status === "done" ? 100 : metricPercent(g.startValue, g.targetValue, current);
  const gap = t.expectedPercent - percent;
  const pace: GoalPace = g.status === "done" || reached ? "done" : now > g.dueAt ? "off_track" : paceFor(gap);
  const first = dayNumber(g.startDate);
  for (const e of sorted) t.weeks[Math.max(0, Math.min(t.weeks.length - 1, Math.floor((dayNumber(e.date) - first) / 7)))].done++;
  const lastDay = Math.min(dayNumber(today), dayNumber(g.dueDate)) - first;
  const trajectory = chartDays(lastDay).map((d) => {
    const at = d === lastDay ? Math.min(now, g.dueAt) : g.startAt + d * DAY;
    const seen = sorted.filter((e) => dayNumber(e.date) - first <= d);
    const pct = metricPercent(g.startValue, g.targetValue, seen[seen.length - 1]?.value ?? g.startValue);
    const expected = Math.max(0, Math.min(100, Math.round(((at - g.startAt) / t.span) * 100)));
    return { at, percent: pct, expected, gap: pct - expected };
  });
  const ran = now - g.startAt;
  return {
    percent,
    doneSteps: 0,
    totalSteps: 0,
    day: t.day,
    totalDays: t.totalDays,
    daysLeft: t.daysLeft,
    expectedPercent: t.expectedPercent,
    stepsBehind: 0,
    doneLast7Days: 0,
    pace,
    weeks: t.weeks,
    trajectory,
    projected: g.status === "active" && !reached && now < g.dueAt && ran >= WEEK ? { at: g.dueAt, gap: Math.round(Math.min(100, percent + (percent / ran) * (g.dueAt - now)) - 100) } : null,
    metric: {
      current,
      expected: round2(g.startValue + (g.targetValue - g.startValue) * (t.expectedPercent / 100)),
      lastDate: lastEntry?.date ?? null,
    },
  };
}

export function habitProgress(g: EntryGoal, entries: GoalEntry[], now = Date.now(), today = localDate(now)): GoalProgress {
  const t = timeline(g, now);
  const first = dayNumber(g.startDate);
  const todayN = dayNumber(today);
  const dueN = dayNumber(g.dueDate);
  const days = new Set(entries.map((e) => dayNumber(e.date)));
  const inGoal = [...days].filter((d) => d >= first && d <= dueN);
  const doneToday = days.has(todayN);
  // days until `upTo` that count: a day counts once it is over or logged
  const elapsedUntil = (upTo: number) => Math.max(0, Math.min(upTo, dueN + 1) - first);
  const elapsedDays = todayN > dueN ? elapsedUntil(todayN) : elapsedUntil(todayN) + (doneToday ? 1 : 0);
  const percent = g.status === "done" ? 100 : elapsedDays ? Math.round((inGoal.length / elapsedDays) * 100) : 0;
  // every day is due, so anything below 100% of the days so far is the gap
  const gap = elapsedDays ? 100 - percent : 0;
  const pace: GoalPace = g.status === "done" || (todayN > dueN && gap === 0) ? "done" : paceFor(gap);
  // an unlogged today doesn't break the streak yet
  let streak = 0;
  for (let d = doneToday ? todayN : todayN - 1; days.has(d); d--) streak++;
  for (const d of inGoal) t.weeks[Math.min(t.weeks.length - 1, Math.floor((d - first) / 7))].done++;
  const lastDay = Math.min(todayN, dueN) - first;
  const trajectory = chartDays(lastDay).map((d) => {
    const at = d === lastDay ? Math.min(now, g.dueAt) : g.startAt + d * DAY;
    const logged = inGoal.filter((x) => x - first <= d).length;
    // the chart point's own day counts once logged, like today does above
    const passed = d + (days.has(first + d) ? 1 : 0);
    const pct = passed ? Math.round((logged / passed) * 100) : 0;
    return { at, percent: pct, expected: 100, gap: passed ? pct - 100 : 0 };
  });
  return {
    percent,
    doneSteps: 0,
    totalSteps: 0,
    day: t.day,
    totalDays: t.totalDays,
    daysLeft: t.daysLeft,
    expectedPercent: elapsedDays ? 100 : 0,
    stepsBehind: 0,
    doneLast7Days: 0,
    pace,
    weeks: t.weeks,
    trajectory,
    projected: g.status === "active" && now < g.dueAt && now - g.startAt >= WEEK ? { at: g.dueAt, gap: percent - 100 } : null,
    habit: {
      loggedDays: inGoal.length,
      elapsedDays,
      streak,
      last7: [...days].filter((d) => d > todayN - 7 && d <= todayN).length,
      last7Target: 7,
      doneToday,
    },
  };
}

export function goalProgress(g: { startAt: number; dueAt: number; status: "active" | "done" }, steps: Pick<GoalStep, "doneAt">[], now = Date.now()): GoalProgress {
  const span = Math.max(DAY, g.dueAt - g.startAt);
  const totalDays = Math.ceil(span / DAY);
  const done = steps.filter((s) => s.doneAt !== null);
  const expectedPercent = Math.max(0, Math.min(100, Math.round(((now - g.startAt) / span) * 100)));
  const percent = g.status === "done" ? 100 : steps.length ? Math.round((done.length / steps.length) * 100) : 0;
  const gap = expectedPercent - percent;
  let pace: GoalPace;
  if (g.status === "done" || (steps.length > 0 && done.length === steps.length)) pace = "done";
  else if (!steps.length) pace = "no_plan";
  else if (now > g.dueAt || gap > ADJUST_GAP) pace = "off_track";
  else if (gap > ON_TRACK_GAP) pace = "adjust";
  else pace = "on_track";
  const weeks = Array.from({ length: Math.max(1, Math.ceil(span / WEEK)) }, (_, i) => ({ start: g.startAt + i * WEEK, done: 0 }));
  for (const s of done) weeks[Math.max(0, Math.min(weeks.length - 1, Math.floor((s.doneAt! - g.startAt) / WEEK)))].done++;
  const end = Math.min(now, g.dueAt);
  const times: number[] = [];
  if (steps.length && end >= g.startAt) {
    for (let t = g.startAt; t < end; t += WEEK) times.push(t);
    times.push(end);
  }
  const trajectory = times.map((at) => {
    const pct = Math.round((done.filter((s) => s.doneAt! <= at).length / steps.length) * 100);
    const expected = Math.round(((at - g.startAt) / span) * 100);
    return { at, percent: pct, expected, gap: pct - expected };
  });
  const ran = now - g.startAt;
  const projected = g.status === "active" && steps.length && now < g.dueAt && ran >= WEEK ? { at: g.dueAt, gap: Math.round(Math.min(100, percent + (percent / ran) * (g.dueAt - now)) - 100) } : null;
  return {
    percent,
    doneSteps: done.length,
    totalSteps: steps.length,
    day: Math.max(1, Math.min(totalDays, Math.floor((now - g.startAt) / DAY) + 1)),
    totalDays,
    daysLeft: Math.max(0, Math.ceil((g.dueAt - now) / DAY)),
    expectedPercent,
    stepsBehind: pace === "done" ? 0 : Math.max(0, Math.floor((expectedPercent / 100) * steps.length) - done.length),
    doneLast7Days: done.filter((s) => s.doneAt! > now - WEEK).length,
    pace,
    weeks,
    trajectory,
    projected,
  };
}

export class GoalService {
  private readonly db: DB;
  private readonly bus: Bus;
  private readonly acct: (accountId?: string) => string;
  private readonly parseWhen: (input: string) => number | null;

  constructor(opts: { db: DB; bus: Bus; acct: (accountId?: string) => string; parseWhen: (input: string) => number | null }) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.acct = opts.acct;
    this.parseWhen = opts.parseWhen;
  }

  private changed(): void {
    this.bus.emitEvent({ type: "goals-changed" });
  }

  private due(v: number | string): number {
    if (typeof v === "number") return v;
    const at = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T23:59:59`).getTime() : this.parseWhen(v);
    if (!at || Number.isNaN(at)) throw new Error(`Could not understand due date: ${v}`);
    return at;
  }

  list(now = Date.now()): Goal[] {
    const steps = this.db.all<StepRow>("SELECT id, goal_id, title, done_at FROM goal_steps ORDER BY position");
    const threads = this.db.all<{ goal_id: string; account_id: string; thread_id: string; subject: string | null; last_date: number | null }>(
      `SELECT g.goal_id, g.account_id, g.thread_id, t.subject, t.last_date FROM goal_threads g
       LEFT JOIN threads t ON t.account_id = g.account_id AND t.id = g.thread_id ORDER BY g.added_at DESC`,
    );
    const entries = this.db.all<{ goal_id: string; date: string; value: number | null }>("SELECT goal_id, date, value FROM goal_entries ORDER BY date");
    const zone = currentTimeZone();
    const today = localDate(now, zone);
    return this.db.all<GoalRow>("SELECT * FROM goals ORDER BY status, due_at").map((r) => {
      const status = r.status === "done" ? "done" : "active";
      const own: GoalStep[] = steps.filter((s) => s.goal_id === r.id).map((s) => ({ id: s.id, title: s.title, doneAt: s.done_at }));
      const linked: GoalThread[] = threads
        .filter((t) => t.goal_id === r.id)
        .map((t) => ({ accountId: t.account_id, threadId: t.thread_id, subject: t.subject ?? "(thread not synced)", lastDate: t.last_date }));
      const logged: GoalEntry[] = entries.filter((e) => e.goal_id === r.id).map((e) => ({ date: e.date, value: e.value }));
      const kind = (r.kind || "steps") as GoalKind;
      const base = { startAt: r.start_at, dueAt: r.due_at, status: status as "active" | "done" };
      const dated = { ...base, startDate: r.start_date ?? localDate(r.start_at, zone), dueDate: localDate(r.due_at, zone) };
      return {
        id: r.id,
        title: r.title,
        why: r.why,
        startAt: r.start_at,
        dueAt: r.due_at,
        status,
        kind,
        startValue: r.start_value,
        targetValue: r.target_value,
        unit: r.unit,
        startDate: r.start_date,
        entries: logged,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        completedAt: r.completed_at,
        steps: own,
        threads: linked,
        progress:
          kind === "metric"
            ? metricProgress({ ...dated, startValue: r.start_value ?? 0, targetValue: r.target_value ?? 0 }, logged, now, today)
            : kind === "habit"
              ? habitProgress(dated, logged, now, today)
              : goalProgress(base, own, now),
      };
    });
  }

  get(id: string): Goal {
    const g = this.list().find((x) => x.id === id);
    if (!g) throw new Error(`Unknown goal: ${id}`);
    return g;
  }

  create(input: GoalInput): Goal {
    const title = input.title?.trim();
    if (!title) throw new Error("A goal needs a title");
    const now = Date.now();
    const startAt = input.startAt ?? new Date(now).setHours(0, 0, 0, 0);
    const dueAt = this.due(input.dueAt);
    if (dueAt <= startAt) throw new Error("The due date must be after the start");
    const kind = input.kind ?? "steps";
    this.checkKind(kind, input.startValue, input.targetValue, input.unit);
    if (kind !== "steps" && input.steps?.some((s) => s.trim())) throw new Error(`A ${kind} goal has no steps`);
    const id = uid("gl_");
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO goals (id, title, why, start_at, due_at, status, created_at, updated_at, kind, start_value, target_value, unit, start_date)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        title,
        input.why?.trim() ?? "",
        startAt,
        dueAt,
        now,
        now,
        kind,
        kind === "metric" ? input.startValue! : null,
        kind === "metric" ? input.targetValue! : null,
        kind === "metric" ? (input.unit?.trim() ?? "") : "",
        kind === "steps" ? null : localDate(startAt),
      );
      for (const s of input.steps ?? []) if (s.trim()) this.insertStep(id, s.trim());
    });
    this.changed();
    return this.get(id);
  }

  update(id: string, patch: GoalPatch): Goal {
    const g = this.get(id);
    const title = patch.title?.trim() ?? g.title;
    if (!title) throw new Error("A goal needs a title");
    const dueAt = patch.dueAt !== undefined ? this.due(patch.dueAt) : g.dueAt;
    if (dueAt <= g.startAt) throw new Error("The due date must be after the start");
    const status = patch.status ?? g.status;
    const completedAt = status === "done" ? (g.completedAt ?? Date.now()) : null;
    const kind = patch.kind ?? g.kind;
    if (kind !== g.kind) {
      // old data would silently stop counting (or, for entries, mean something else under the new kind)
      if (g.steps.length) throw new Error(`Remove the ${g.steps.length} steps before changing the kind of this goal`);
      if (g.entries.length) throw new Error(`Delete the ${g.entries.length} entries before changing the kind of this goal`);
    }
    const startValue = patch.startValue ?? (kind === "metric" ? (g.startValue ?? undefined) : undefined);
    const targetValue = patch.targetValue ?? (kind === "metric" ? (g.targetValue ?? undefined) : undefined);
    const unit = patch.unit ?? (kind === "metric" ? g.unit : undefined);
    this.checkKind(kind, startValue, targetValue, unit);
    this.db.run(
      `UPDATE goals SET title = ?, why = ?, due_at = ?, status = ?, completed_at = ?, updated_at = ?,
         kind = ?, start_value = ?, target_value = ?, unit = ?, start_date = ? WHERE id = ?`,
      title,
      patch.why?.trim() ?? g.why,
      dueAt,
      status,
      completedAt,
      Date.now(),
      kind,
      kind === "metric" ? startValue! : null,
      kind === "metric" ? targetValue! : null,
      kind === "metric" ? (unit?.trim() ?? "") : "",
      kind === "steps" ? null : (g.startDate ?? localDate(g.startAt)),
      id,
    );
    this.changed();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.run("DELETE FROM goals WHERE id = ?", id);
    this.changed();
  }

  private checkKind(kind: string, startValue: unknown, targetValue: unknown, unit: unknown): void {
    if (kind !== "steps" && kind !== "metric" && kind !== "habit") throw new Error(`Unknown goal kind: ${kind}`);
    if (kind !== "metric") {
      if (startValue !== undefined || targetValue !== undefined || unit) throw new Error("Start value, target value and unit only apply to a metric goal");
      return;
    }
    if (typeof startValue !== "number" || !Number.isFinite(startValue) || typeof targetValue !== "number" || !Number.isFinite(targetValue)) throw new Error("A metric goal needs a numeric start and target value");
    if (startValue === targetValue) throw new Error("Start and target value must differ");
  }

  /**
   * One entry per calendar day. A metric value replaces that day's value, logging a habit day twice changes nothing.
   * `date` defaults to today in the Mac's current time zone.
   */
  logEntry(goalId: string, input: { date?: string; value?: number | null } = {}, now = Date.now()): Goal {
    const g = this.get(goalId);
    if (g.kind === "steps") throw new Error("This goal runs on steps, it has no daily entries");
    const today = localDate(now);
    const date = input.date ?? today;
    if (!isDate(date)) throw new Error(`Not a calendar date (YYYY-MM-DD): ${date}`);
    if (date > today) throw new Error(`${date} is in the future (today is ${today})`);
    if (g.startDate && date < g.startDate) throw new Error(`${date} is before this goal started (${g.startDate})`);
    const value = input.value ?? null;
    if (g.kind === "metric") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("A metric entry needs a numeric value");
      this.db.run(
        `INSERT INTO goal_entries (goal_id, date, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(goal_id, date) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        goalId,
        date,
        value,
        now,
        now,
      );
    } else {
      if (value !== null) throw new Error("A habit entry has no value");
      this.db.run("INSERT OR IGNORE INTO goal_entries (goal_id, date, value, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)", goalId, date, now, now);
    }
    this.changed();
    return this.get(goalId);
  }

  deleteEntry(goalId: string, date: string): Goal {
    const g = this.get(goalId);
    if (!g.entries.some((e) => e.date === date)) throw new Error(`Unknown entry: ${date}`);
    this.db.run("DELETE FROM goal_entries WHERE goal_id = ? AND date = ?", goalId, date);
    this.changed();
    return this.get(goalId);
  }

  private insertStep(goalId: string, title: string): void {
    const pos = this.db.get<{ p: number | null }>("SELECT MAX(position) AS p FROM goal_steps WHERE goal_id = ?", goalId)?.p ?? -1;
    this.db.run("INSERT INTO goal_steps (id, goal_id, title, position) VALUES (?, ?, ?, ?)", uid("gs_"), goalId, title, pos + 1);
  }

  addStep(goalId: string, title: string): Goal {
    if (this.get(goalId).kind !== "steps") throw new Error("Only a steps goal has steps");
    if (!title?.trim()) throw new Error("A step needs a title");
    this.insertStep(goalId, title.trim());
    this.changed();
    return this.get(goalId);
  }

  updateStep(goalId: string, stepId: string, patch: { title?: string; done?: boolean }): Goal {
    const step = this.get(goalId).steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Unknown step: ${stepId}`);
    const doneAt = patch.done === undefined ? step.doneAt : patch.done ? (step.doneAt ?? Date.now()) : null;
    this.db.run("UPDATE goal_steps SET title = ?, done_at = ? WHERE id = ?", patch.title?.trim() || step.title, doneAt, stepId);
    this.changed();
    return this.get(goalId);
  }

  deleteStep(goalId: string, stepId: string): Goal {
    this.db.run("DELETE FROM goal_steps WHERE id = ? AND goal_id = ?", stepId, goalId);
    this.changed();
    return this.get(goalId);
  }

  linkThread(goalId: string, accountIdIn: string | undefined, threadId: string): Goal {
    this.get(goalId);
    const accountId = this.acct(accountIdIn);
    if (!this.db.get("SELECT 1 AS x FROM threads WHERE account_id = ? AND id = ?", accountId, threadId)) throw new Error("Thread not found");
    this.db.run("INSERT OR IGNORE INTO goal_threads (goal_id, account_id, thread_id, added_at) VALUES (?, ?, ?, ?)", goalId, accountId, threadId, Date.now());
    this.changed();
    return this.get(goalId);
  }

  unlinkThread(goalId: string, accountIdIn: string | undefined, threadId: string): Goal {
    this.db.run("DELETE FROM goal_threads WHERE goal_id = ? AND account_id = ? AND thread_id = ?", goalId, this.acct(accountIdIn), threadId);
    this.changed();
    return this.get(goalId);
  }
}
