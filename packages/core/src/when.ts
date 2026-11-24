// Natural-language times for Remind Me / Send Later ("tomorrow", "next mon 9am", "in 3 days", "3h", "fri").
import * as chrono from "chrono-node";

export interface TimePreset {
  id: string;
  label: string;
  at: number;
}

function atHour(d: Date, hour: number, minute = 0): Date {
  const x = new Date(d);
  x.setHours(hour, minute, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function reminderPresets(now = new Date(), hour = 8): TimePreset[] {
  const out: TimePreset[] = [];
  const later = new Date(now.getTime() + 3 * 3600_000);
  later.setMinutes(later.getMinutes() < 30 ? 30 : 60, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() < 22) out.push({ id: "later", label: "Later today", at: later.getTime() });
  if (now.getHours() < 17) out.push({ id: "evening", label: "This evening", at: atHour(now, 18).getTime() });
  out.push({ id: "tomorrow", label: "Tomorrow", at: atHour(addDays(now, 1), hour).getTime() });
  const dow = now.getDay(); // 0 Sun .. 6 Sat
  const toSat = (6 - dow + 7) % 7 || 7;
  if (dow >= 1 && dow <= 4) out.push({ id: "weekend", label: "This weekend", at: atHour(addDays(now, toSat), hour).getTime() });
  else out.push({ id: "weekend", label: "Next weekend", at: atHour(addDays(now, toSat), hour).getTime() });
  const toMon = (1 - dow + 7) % 7 || 7;
  out.push({ id: "nextweek", label: "Next week", at: atHour(addDays(now, toMon), hour).getTime() });
  const month = new Date(now);
  month.setMonth(month.getMonth() + 1);
  out.push({ id: "month", label: "In a month", at: atHour(month, hour).getTime() });
  const someday = new Date(now);
  someday.setMonth(someday.getMonth() + 3);
  out.push({ id: "someday", label: "Someday (3 months)", at: atHour(someday, hour).getTime() });
  return out;
}

/** Parse a user-entered time. Returns epoch ms or null. Times without a clock time get `hour`:00. */
export function parseWhen(input: string, now = new Date(), hour = 8): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const preset = reminderPresets(now, hour).find((p) => p.id === s || p.label.toLowerCase() === s);
  if (preset) return preset.at;
  if (/^\d{10,13}$/.test(s)) return s.length === 10 ? Number(s) * 1000 : Number(s);
  const short = s.match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|w|mo)$/);
  if (short) {
    const n = Number(short[1]);
    const unit = short[2];
    if (unit.startsWith("m") && unit !== "mo") return now.getTime() + n * 60_000;
    if (unit.startsWith("h")) return now.getTime() + n * 3600_000;
    if (unit === "d") return atHour(addDays(now, n), hour).getTime();
    if (unit === "w") return atHour(addDays(now, 7 * n), hour).getTime();
    if (unit === "mo") {
      const d = new Date(now);
      d.setMonth(d.getMonth() + n);
      return atHour(d, hour).getTime();
    }
  }
  const iso = Date.parse(input);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(iso)) return iso;
  const results = chrono.parse(input, now, { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  const d = r.start.date();
  if (!r.start.isCertain("hour")) d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) {
    // "8am" when it's already 9am → tomorrow
    if (!r.start.isCertain("day")) return addDays(d, 1).getTime();
  }
  return d.getTime();
}

export function describeWhen(at: number, now = new Date()): string {
  const d = new Date(at);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay(d, now)) return `today ${time}`;
  if (sameDay(d, addDays(now, 1))) return `tomorrow ${time}`;
  if (at - now.getTime() < 7 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })} ${time}`;
}

// ---------------------------------------------------------------- calendar events from natural language

export interface ParsedEventText {
  summary: string;
  start: number | null;
  end: number | null;
  allDay: boolean;
  /** explicit "for 1h" / "for 90 min" duration, if given */
  durationMinutes: number | null;
}

const DURATION_PATTERNS: [RegExp, (m: RegExpMatchArray) => number][] = [
  [/\b(?:for|für)\s+half\s+an?\s+hour\b/i, () => 30],
  [/\b(?:for|für)\s+(?:an?|one|eine)\s+(?:hour|stunde)\b/i, () => 60],
  [
    /\b(?:for|für)\s+(\d+(?:[.,]\d+)?)\s*(?:h|hrs?|hours?|std|stunden?)(?:\s*(?:and\s+)?(\d+)\s*(?:m|mins?|minutes?|minuten?))?(?![a-z])/i,
    (m) => Math.round(Number(m[1].replace(",", ".")) * 60) + Number(m[2] ?? 0),
  ],
  [/\b(?:for|für)\s+(\d+)\s*(?:m|mins?|minutes?|minuten?)(?![a-z])/i, (m) => Number(m[1])],
];

type ChronoResult = ReturnType<typeof chrono.parse>[number];

const hasDate = (r: ChronoResult) => r.start.isCertain("day") || r.start.isCertain("weekday") || r.start.isCertain("month");

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "Lunch with Anna tomorrow 1pm for 1h" → { summary: "Lunch with Anna", start: tomorrow 13:00, end: 14:00 }.
 * No time → all-day ("Offsite friday"). No date at all → start null. English first, German as fallback.
 */
export function parseEventText(input: string, now = new Date(), defaultMinutes = 30): ParsedEventText {
  let text = input.trim();
  let durationMinutes: number | null = null;
  for (const [re, fn] of DURATION_PATTERNS) {
    const m = text.match(re);
    if (m) {
      durationMinutes = fn(m);
      text = (text.slice(0, m.index) + " " + text.slice(m.index! + m[0].length)).replace(/\s+/g, " ").trim();
      break;
    }
  }
  const en = chrono.parse(text, now, { forwardDate: true });
  const de = chrono.de.parse(text, now, { forwardDate: true });
  const len = (rs: ChronoResult[]) => rs.reduce((n, r) => n + r.text.length, 0);
  const results = len(de) > len(en) ? de : en;
  if (!results.length) return { summary: text, start: null, end: null, allDay: false, durationMinutes };

  const first = results[0];
  const used: ChronoResult[] = [first];
  let start = first.start.date();
  let endDate = first.end?.date() ?? null;
  let timed = first.start.isCertain("hour");
  // "Lunch tomorrow with Anna at 1pm": date and time are separate matches → combine
  if (!timed) {
    const t = results.slice(1).find((r) => r.start.isCertain("hour") && !hasDate(r));
    if (t) {
      used.push(t);
      const ts = t.start.date();
      start = new Date(start);
      start.setHours(ts.getHours(), ts.getMinutes(), 0, 0);
      if (t.end) {
        const te = t.end.date();
        endDate = new Date(start);
        endDate.setHours(te.getHours(), te.getMinutes(), 0, 0);
      } else endDate = null;
      timed = true;
    }
  }

  let summary = text;
  for (const r of [...used].sort((a, b) => b.index - a.index)) summary = summary.slice(0, r.index) + " " + summary.slice(r.index + r.text.length);
  const connector = /(?:^|\s)(?:at|on|from|by|um|am|ab|@|,|-|–|:)\s*$/i;
  summary = summary.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3 && connector.test(summary); i++) summary = summary.replace(connector, "").trim();
  summary = summary.replace(/^(?:[,:\-–]|on|at|am|um)\s+/i, "").replace(/[,:\-–]\s*$/, "").trim();

  if (!timed) {
    const s = startOfLocalDay(start.getTime());
    let e = endDate ? startOfLocalDay(endDate.getTime()) : s;
    const next = new Date(e);
    next.setDate(next.getDate() + 1); // end is exclusive: next local midnight
    e = next.getTime();
    return { summary, start: s, end: e, allDay: true, durationMinutes };
  }
  let s = start.getTime();
  if (!hasDate(first) && s <= now.getTime() && used.length === 1) s += 86_400_000; // "9am" when it is already 10am
  const e = endDate && endDate.getTime() > s ? endDate.getTime() : s + (durationMinutes ?? defaultMinutes) * 60_000;
  return { summary, start: s, end: e, allDay: false, durationMinutes };
}

/** Local ISO 8601 with offset, e.g. 2026-10-22T13:00:00+08:00 */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(off / 60)}:${p(off % 60)}`;
}
