// Goals page ("g g"): goals, their steps and linked threads, with progress against the time that has passed.
import { useState } from "react";
import type { Goal, GoalKind, GoalPace } from "@iris/core/types.ts";
import { api } from "../api";
import { closeGoals, errorToast, loadGoals, openThread, setState, useApp } from "../state";
import { Icon, type IconName } from "./Icon";

const PACE: Record<GoalPace, { label: string; icon: IconName; cls: string }> = {
  on_track: { label: "On track", icon: "check", cls: "ok" },
  adjust: { label: "Adjust", icon: "alert", cls: "warn" },
  off_track: { label: "Off track", icon: "octagon-alert", cls: "danger" },
  no_plan: { label: "No steps yet", icon: "pen", cls: "neutral" },
  done: { label: "Done", icon: "circle-check", cls: "ok" },
};

const WEEK = 7 * 86_400_000;

async function mutate(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    await loadGoals();
    return true;
  } catch (e) {
    errorToast(e);
    return false;
  }
}

function dateValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Number from a text field, with a German decimal comma; NaN if it isn't one. */
function parseNumber(v: string): number {
  return v.trim() ? Number(v.trim().replace(",", ".")) : NaN;
}

const fmtValue = (n: number, unit: string) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;
const fmtDay = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

function GoalForm({ goal, onClose }: { goal?: Goal; onClose: () => void }) {
  const [title, setTitle] = useState(goal?.title ?? "");
  const [why, setWhy] = useState(goal?.why ?? "");
  const [due, setDue] = useState(dateValue(goal?.dueAt ?? Date.now() + 12 * WEEK));
  const [steps, setSteps] = useState("");
  const [kind, setKind] = useState<GoalKind>(goal?.kind ?? "steps");
  const [startValue, setStartValue] = useState(goal?.startValue?.toString() ?? "");
  const [targetValue, setTargetValue] = useState(goal?.targetValue?.toString() ?? "");
  const [unit, setUnit] = useState(goal?.unit ?? "");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const metric = kind === "metric" ? { startValue: parseNumber(startValue), targetValue: parseNumber(targetValue), unit } : {};
    const ok = goal
      ? await mutate(() => api.patch(`/api/goals/${goal.id}`, { title, why, dueAt: due, ...metric }))
      : await mutate(() => api.post("/api/goals", { title, why, dueAt: due, kind, ...metric, ...(kind === "steps" ? { steps: steps.split("\n") } : {}) }));
    if (ok) onClose();
  };
  return (
    <form
      className="goal-form"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && e.metaKey) void submit(e);
      }}
    >
      <label>
        <span>Goal</span>
        <input autoFocus required value={title} placeholder="Ship v1 before the conference" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>Why</span>
        <input value={why} placeholder="Optional: why this matters" onChange={(e) => setWhy(e.target.value)} />
      </label>
      <label>
        <span>Due</span>
        <input type="date" required value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      {!goal && (
        <label>
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as GoalKind)}>
            <option value="steps">Steps</option>
            <option value="metric">Number (e.g. weight)</option>
            <option value="habit">Daily habit</option>
          </select>
        </label>
      )}
      {!goal && kind === "steps" && (
        <label>
          <span>Steps</span>
          <textarea rows={4} value={steps} placeholder="One step per line. Progress is steps done." onChange={(e) => setSteps(e.target.value)} />
        </label>
      )}
      {kind === "metric" && (
        <div className="goal-form-metric">
          <label>
            <span>Start</span>
            <input required inputMode="decimal" value={startValue} placeholder="115" onChange={(e) => setStartValue(e.target.value)} />
          </label>
          <label>
            <span>Target</span>
            <input required inputMode="decimal" value={targetValue} placeholder="105" onChange={(e) => setTargetValue(e.target.value)} />
          </label>
          <label>
            <span>Unit</span>
            <input value={unit} placeholder="kg" onChange={(e) => setUnit(e.target.value)} />
          </label>
        </div>
      )}
      <div className="goal-form-actions">
        <button type="button" className="btn sm" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn sm btn-primary">
          {goal ? "Save" : "Create goal"}
        </button>
      </div>
    </form>
  );
}

/** Progress so far, with a marker where the pace says it should be today. */
function Meter({ goal }: { goal: Goal }) {
  const p = goal.progress;
  const active = goal.status === "active";
  const summary = p.metric ? `${fmtValue(p.metric.current, goal.unit)} now, goal ${fmtValue(goal.targetValue ?? 0, goal.unit)}` : p.habit ? `${p.habit.loggedDays} of ${plural(p.habit.elapsedDays, "day")}` : `${p.doneSteps} of ${p.totalSteps} steps`;
  // a habit is due every day, so "expected by today" is always the end of the bar
  const marker = active && goal.kind !== "habit";
  return (
    <div className="goal-meter">
      <div className="goal-meter-head">
        <span>
          {active ? `Day ${p.day} of ${p.totalDays} · ${p.daysLeft ? `${plural(p.daysLeft, "day")} left` : "due"}` : "Completed"}
          {active && p.stepsBehind > 0 && ` · ${plural(p.stepsBehind, "step")} behind pace`}
        </span>
        <span className="tnum">
          {summary} · <strong>{p.percent}%</strong>
        </span>
      </div>
      <div className="goal-track" role="img" aria-label={`${p.percent}% done${marker ? `, ${p.expectedPercent}% expected by today` : ""}`}>
        <div className="goal-fill" style={{ width: `${p.percent}%` }} />
        {marker && <div className="goal-marker" style={{ left: `${p.expectedPercent}%` }} title={`Expected by today: ${p.expectedPercent}%`} />}
      </div>
    </div>
  );
}

/** Habit days logged per week. Weeks that haven't started stay empty. */
function Weeks({ goal }: { goal: Goal }) {
  const weeks = goal.progress.weeks;
  if (weeks.length < 2) return null;
  const now = Date.now();
  return (
    <div className="goal-weeks" role="img" aria-label={`Days logged per week: ${weeks.map((w) => w.done).join(", ")}`}>
      {weeks.map((w, i) => (
        <div key={w.start} className={`goal-week${w.start > now ? " future" : ""}${now >= w.start && now < w.start + WEEK ? " current" : ""}`} title={`Week ${i + 1}: ${w.done} of 7 days`}>
          <div className="goal-week-bar" style={{ height: w.done ? `${Math.max(16, (w.done / 7) * 100)}%` : 0 }} />
        </div>
      ))}
    </div>
  );
}

/** Date picker for logging a past day. */
function EntryDate({ goal, value, onChange }: { goal: Goal; value: string; onChange: (v: string) => void }) {
  return <input className="goal-entry-date" type="date" aria-label={`Day to log for ${goal.title}`} min={goal.startDate ?? undefined} max={dateValue(Date.now())} value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** The latest entries, each removable. Logging a metric day again corrects it. */
function EntryList({ goal, url }: { goal: Goal; url: string }) {
  const recent = [...goal.entries].reverse().slice(0, 7);
  if (!recent.length) return null;
  return (
    <ul className="goal-entries">
      {recent.map((e) => (
        <li key={e.date} className="tnum">
          <span>{fmtDay(e.date)}</span>
          {e.value !== null && <span>{fmtValue(e.value, goal.unit)}</span>}
          <button className="icon-btn sm goal-remove" title="Delete entry" aria-label={`Delete entry of ${fmtDay(e.date)}`} onClick={() => void mutate(() => api.del(`${url}/entries/${e.date}`))}>
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Logged values against the straight line from start to target. */
function Sparkline({ goal }: { goal: Goal }) {
  const first = dayNumber(goal.startDate ?? dateValue(goal.startAt));
  const last = Math.max(first + 1, dayNumber(dateValue(goal.dueAt)));
  const start = goal.startValue ?? 0;
  const target = goal.targetValue ?? 0;
  const values = [start, target, ...goal.entries.map((e) => e.value ?? start)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const W = 300;
  const H = 44;
  const x = (date: string) => 3 + ((dayNumber(date) - first) / (last - first)) * (W - 6);
  const y = (v: number) => 3 + ((hi - v) / (hi - lo || 1)) * (H - 6);
  return (
    <svg className="goal-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${goal.entries.length} values logged. Target line from ${fmtValue(start, goal.unit)} to ${fmtValue(target, goal.unit)}`}>
      <line className="goal-spark-pace" x1={3} y1={y(start)} x2={W - 3} y2={y(target)} />
      <polyline className="goal-spark-line" points={goal.entries.map((e) => `${x(e.date).toFixed(1)},${y(e.value ?? start).toFixed(1)}`).join(" ")} />
      {goal.entries.map((e) => (
        <circle key={e.date} className="goal-spark-dot" cx={x(e.date)} cy={y(e.value ?? start)} r={3}>
          <title>{`${fmtDay(e.date)}: ${fmtValue(e.value ?? start, goal.unit)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function MetricLog({ goal, url }: { goal: Goal; url: string }) {
  const [value, setValue] = useState("");
  // only a picked past day is kept: the window can stay open overnight, and "today" must not go stale
  const [picked, setPicked] = useState<string | null>(null);
  const m = goal.progress.metric;
  const submit = () => {
    const n = parseNumber(value);
    if (Number.isNaN(n)) return errorToast(new Error("Enter a number"));
    void mutate(() => api.post(`${url}/entries`, { value: n, date: picked ?? dateValue(Date.now()) })).then((ok) => {
      if (ok) {
        setValue("");
        setPicked(null);
      }
    });
  };
  return (
    <div className="goal-log">
      {m && (
        <dl className="goal-log-stats tnum">
          <div>
            <dt>Now</dt>
            <dd>{fmtValue(m.current, goal.unit)}</dd>
          </div>
          <div>
            <dt>Target today</dt>
            <dd>{fmtValue(m.expected, goal.unit)}</dd>
          </div>
        </dl>
      )}
      <Sparkline goal={goal} />
      <div className="goal-log-form">
        <input
          className="goal-entry-value"
          inputMode="decimal"
          value={value}
          placeholder={goal.unit ? `Value in ${goal.unit}` : "Value"}
          aria-label={`Value for ${goal.title}`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
            if (e.key === "Enter") submit();
          }}
        />
        <EntryDate goal={goal} value={picked ?? dateValue(Date.now())} onChange={setPicked} />
        <button className="btn sm" disabled={!value.trim()} onClick={submit}>
          Log
        </button>
      </div>
      <EntryList goal={goal} url={url} />
    </div>
  );
}

function HabitLog({ goal, url }: { goal: Goal; url: string }) {
  const today = dateValue(Date.now());
  const [picked, setPicked] = useState<string | null>(null);
  const h = goal.progress.habit;
  const doneToday = goal.entries.some((e) => e.date === today);
  return (
    <div className="goal-log">
      {h && (
        <dl className="goal-log-stats tnum">
          <div>
            <dt>Streak</dt>
            <dd>{plural(h.streak, "day")}</dd>
          </div>
          <div>
            <dt>Last 7 days</dt>
            <dd>
              {h.last7}/{h.last7Target}
            </dd>
          </div>
        </dl>
      )}
      <div className="goal-log-form">
        <button className={`btn sm${doneToday ? "" : " btn-primary"}`} disabled={doneToday} onClick={() => void mutate(() => api.post(`${url}/entries`, { date: dateValue(Date.now()) }))}>
          <Icon name="check" size={14} />
          {doneToday ? "Done today ✓" : "Done today"}
        </button>
        <EntryDate goal={goal} value={picked ?? today} onChange={setPicked} />
        <button className="btn sm" disabled={!picked || picked === today} onClick={() => void mutate(() => api.post(`${url}/entries`, { date: picked })).then((ok) => ok && setPicked(null))}>
          Log past day
        </button>
      </div>
      <EntryList goal={goal} url={url} />
    </div>
  );
}

const CHART = { w: 640, h: 220, left: 8, right: 8, top: 22, bottom: 24 };
/** pace gap in percentage points: bands match the On track / Adjust / Off track limits in core/goals.ts */
const GAP_TOP = 30;
const GAP_BOTTOM = -60;
const BANDS = [
  { from: GAP_TOP, to: -10, cls: "good", label: "On track" },
  { from: -10, to: -25, cls: "warn", label: "Adjust" },
  { from: -25, to: GAP_BOTTOM, cls: "bad", label: "Off track" },
];
const MAX_LINES = 8;

/** One line per goal: how far ahead of or behind its pace it has been, week by week, then the projection. */
function Trajectory({ goals, all }: { goals: Goal[]; all: Goal[] }) {
  const withLine = goals.filter((g) => g.progress.trajectory.length);
  const plotted = withLine.slice(0, MAX_LINES);
  if (!plotted.length) return null;
  const now = Date.now();
  const from = Math.min(...plotted.map((g) => g.startAt));
  const to = Math.max(...plotted.map((g) => g.dueAt));
  const span = Math.max(1, to - from);
  const plotW = CHART.w - CHART.left - CHART.right;
  const plotH = CHART.h - CHART.top - CHART.bottom;
  const x = (at: number) => CHART.left + (Math.max(from, Math.min(to, at)) - from) / span * plotW;
  const y = (gap: number) => CHART.top + (GAP_TOP - Math.max(GAP_BOTTOM, Math.min(GAP_TOP, gap))) / (GAP_TOP - GAP_BOTTOM) * plotH;
  const weeks = Math.max(1, Math.ceil(span / WEEK));
  const every = Math.ceil(weeks / 12);
  // color follows the goal, not its rank: the oldest goal keeps slot 1 whatever is filtered or sorted
  const slot = (g: Goal) => [...all].sort((a, b) => a.createdAt - b.createdAt).findIndex((o) => o.id === g.id) % MAX_LINES;
  const totalDays = Math.ceil(span / 86_400_000);
  const day = Math.max(1, Math.min(totalDays, Math.floor((now - from) / 86_400_000) + 1));
  const daysLeft = Math.max(0, Math.ceil((to - now) / 86_400_000));
  return (
    <section className="goal-chart" aria-label="Goal progress over time">
      <div className="goal-chart-head">
        <strong className="tnum">
          Day {day} of {totalDays}
        </strong>
        <span className="tnum">{plural(daysLeft, "day")} left</span>
      </div>
      <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} role="img" aria-label={plotted.map((g) => `${g.title}: ${g.progress.percent}% done, ${PACE[g.progress.pace].label}`).join("; ")}>
        {BANDS.map((b) => (
          <g key={b.cls}>
            <rect className={`goal-band ${b.cls}`} x={CHART.left} width={plotW} y={y(b.from)} height={y(b.to) - y(b.from)} />
            <text className="goal-band-label" x={CHART.left + 6} y={y(b.from) + 13}>
              {b.label}
            </text>
          </g>
        ))}
        {Array.from({ length: weeks }, (_, i) => i)
          .filter((i) => i % every === 0)
          .map((i) => (
            <text key={i} className="goal-axis-label" x={x(from + (i + 0.5) * WEEK)} y={CHART.h - 8} textAnchor="middle">
              w{i + 1}
            </text>
          ))}
        <line className="goal-today" x1={x(now)} x2={x(now)} y1={CHART.top} y2={CHART.h - CHART.bottom} />
        <text className="goal-axis-label strong" x={x(now)} y={14} textAnchor="middle">
          Today
        </text>
        {plotted.map((g) => {
          const p = g.progress;
          const last = p.trajectory[p.trajectory.length - 1];
          const color = `var(--series-${slot(g) + 1})`;
          return (
            <g key={g.id}>
              {p.projected && <line className="goal-projection" stroke={color} x1={x(last.at)} y1={y(last.gap)} x2={x(p.projected.at)} y2={y(p.projected.gap)} />}
              <polyline className="goal-line" stroke={color} points={p.trajectory.map((t) => `${x(t.at).toFixed(1)},${y(t.gap).toFixed(1)}`).join(" ")} />
              {p.trajectory.map((t) => (
                <g key={t.at}>
                  <circle className="goal-dot" fill={color} cx={x(t.at)} cy={y(t.gap)} r={3} />
                  <circle className="goal-hit" cx={x(t.at)} cy={y(t.gap)} r={9}>
                    <title>{`${g.title}, ${new Date(t.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}: ${t.percent}% done, ${t.expected}% expected`}</title>
                  </circle>
                </g>
              ))}
            </g>
          );
        })}
      </svg>
      <ul className="goal-legend">
        {plotted.map((g) => {
          const pace = PACE[g.progress.pace];
          return (
            <li key={g.id}>
              <span className="goal-swatch" style={{ background: `var(--series-${slot(g) + 1})` }} aria-hidden />
              <span className="goal-legend-name">{g.title}</span>
              <span className={`pill ${pace.cls}`}>
                <Icon name={pace.icon} size={12} stroke={2} />
                {pace.label}
              </span>
            </li>
          );
        })}
        {withLine.length > plotted.length && <li className="goal-legend-more">+{withLine.length - plotted.length} more not shown</li>}
      </ul>
    </section>
  );
}

function GoalCard({ goal }: { goal: Goal }) {
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState("");
  const pace = PACE[goal.progress.pace];
  const url = `/api/goals/${goal.id}`;
  if (editing) return <div className="goal-card"><GoalForm goal={goal} onClose={() => setEditing(false)} /></div>;
  return (
    <section className="goal-card" aria-label={goal.title}>
      <header className="goal-head">
        <div className="goal-title">
          <h2>{goal.title}</h2>
          {goal.why && <p>{goal.why}</p>}
        </div>
        <span className={`pill ${pace.cls}`}>
          <Icon name={pace.icon} size={12} stroke={2} />
          {pace.label}
        </span>
        <div className="goal-actions">
          <button className="icon-btn sm" title="Edit" aria-label="Edit goal" onClick={() => setEditing(true)}>
            <Icon name="pen" size={14} />
          </button>
          <button
            className="icon-btn sm"
            title={goal.status === "done" ? "Reopen" : "Mark complete"}
            aria-label={goal.status === "done" ? "Reopen goal" : "Mark goal complete"}
            onClick={() => void mutate(() => api.patch(url, { status: goal.status === "done" ? "active" : "done" }))}
          >
            <Icon name={goal.status === "done" ? "undo" : "circle-check"} size={14} />
          </button>
          <button
            className="icon-btn sm"
            title="Delete"
            aria-label="Delete goal"
            onClick={() => {
              if (confirm(`Delete "${goal.title}" with its ${goal.kind === "steps" ? "steps" : "entries"}? This can't be undone.`)) void mutate(() => api.del(url));
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </header>
      <Meter goal={goal} />
      {goal.kind === "habit" && <Weeks goal={goal} />}
      {goal.kind === "metric" && <MetricLog goal={goal} url={url} />}
      {goal.kind === "habit" && <HabitLog goal={goal} url={url} />}
      {goal.kind === "steps" && (
        <>
          <ul className="goal-steps">
            {goal.steps.map((s) => (
              <li key={s.id} className={s.doneAt ? "done" : ""}>
                <label>
                  <input type="checkbox" checked={!!s.doneAt} onChange={(e) => void mutate(() => api.patch(`${url}/steps/${s.id}`, { done: e.target.checked }))} />
                  <span>{s.title}</span>
                </label>
                <button className="icon-btn sm goal-remove" title="Remove step" aria-label={`Remove step ${s.title}`} onClick={() => void mutate(() => api.del(`${url}/steps/${s.id}`))}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <input
            className="goal-add-step"
            value={step}
            placeholder="Add a step…"
            aria-label={`Add a step to ${goal.title}`}
            onChange={(e) => setStep(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
              if (e.key === "Enter" && step.trim()) void mutate(() => api.post(`${url}/steps`, { title: step })).then((ok) => ok && setStep(""));
            }}
          />
        </>
      )}
      {goal.threads.length > 0 && (
        <div className="goal-threads">
          {goal.threads.map((t) => (
            <div key={`${t.accountId}\n${t.threadId}`} className="goal-thread">
              <button className="goal-thread-open" onClick={() => void openThread(t.threadId, t.accountId)}>
                <Icon name="mail" size={14} />
                <span>{t.subject}</span>
              </button>
              <button
                className="icon-btn sm goal-remove"
                title="Unlink thread"
                aria-label={`Unlink ${t.subject}`}
                onClick={() => void mutate(() => api.del(`${url}/threads/${encodeURIComponent(t.threadId)}`, { account: t.accountId }))}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function GoalsPage() {
  const goals = useApp((s) => s.goals);
  const creating = useApp((s) => s.goalsForm);
  const active = goals.filter((g) => g.status === "active");
  const completed = goals.filter((g) => g.status === "done");
  const onTrack = active.filter((g) => g.progress.pace === "on_track" || g.progress.pace === "done").length;
  const last7 = goals.reduce((n, g) => n + g.progress.doneLast7Days, 0);
  const close = () => setState({ goalsForm: false });
  return (
    <div className="thread goals">
      <div className="thread-inner">
        <div className="thread-top">
          <button className="icon-btn back" title="Back (Esc)" aria-label="Back" onClick={closeGoals}>
            <Icon name="arrow-left" />
          </button>
          <button className="btn sm" onClick={() => setState({ goalsForm: true })}>
            <Icon name="plus" size={14} />
            New goal <kbd>N</kbd>
          </button>
        </div>
        <h1 className="subject">Goals</h1>
        {active.length > 0 && (
          <dl className="goal-stats">
            <div>
              <dt>On track</dt>
              <dd className="tnum">
                {onTrack} of {active.length}
              </dd>
            </div>
            <div>
              <dt>Steps, last 7 days</dt>
              <dd className="tnum">{last7}</dd>
            </div>
          </dl>
        )}
        <Trajectory goals={active} all={goals} />
        {creating && (
          <div className="goal-card">
            <GoalForm onClose={close} />
          </div>
        )}
        {!creating && !goals.length && (
          <p className="goal-empty">
            No goals yet. Add one with a due date and a few steps, then link the mail that belongs to it with <kbd>⇧</kbd> <kbd>G</kbd>.
          </p>
        )}
        {active.map((g) => (
          <GoalCard key={g.id} goal={g} />
        ))}
        {completed.length > 0 && <h2 className="goal-section">Completed</h2>}
        {completed.map((g) => (
          <GoalCard key={g.id} goal={g} />
        ))}
      </div>
    </div>
  );
}
