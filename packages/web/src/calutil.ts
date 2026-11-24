// Pure calendar helpers (no store access): dates, labels, overlap layout, "When" parsing, availability text.
import type { Address, CalendarEvent, CalendarInvite, EventAttendee, ResponseStatus, TimeRange } from "@iris/core/types.ts";

export const HOUR_PX = 44;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ------------------------------------------------------------ types shared with the store

export interface CalSettings {
  weekStartsOn: 0 | 1;
  showWeekends: boolean;
  showDeclined: boolean;
}

export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface EventFormInit {
  key: string;
  mode: "create" | "edit";
  event?: CalendarEvent;
  summary?: string;
  start?: number;
  end?: number;
  allDay?: boolean;
  guests?: Address[];
  location?: string;
  description?: string;
  conference?: boolean;
  calendarId?: string;
}

export interface CalAvail {
  duration: number;
  slots: TimeRange[];
  /** the week page was opened for availability: Esc/Enter go back to where we were */
  openedWeek: boolean;
  suggesting?: boolean;
}

export interface InviteView {
  iCalUID: string;
  kind: "request" | "reply" | "cancel" | "update";
  summary: string;
  description: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  conferenceUrl?: string;
  organizer: { email: string; name: string };
  attendees: EventAttendee[];
  selfResponse?: ResponseStatus;
  recurring: boolean;
  canRsvp: boolean;
  canAdd: boolean;
  replyFrom?: { email: string; name: string; responseStatus: ResponseStatus };
  messageId: string;
  threadId: string;
  /** account of the thread the invite came in (RSVP + "Add to calendar" go there) */
  accountId?: string;
  event?: CalendarEvent;
}

// ------------------------------------------------------------ date math (local time, DST safe)

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
export function startOfWeek(ms: number, weekStartsOn: 0 | 1): number {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() - weekStartsOn + 7) % 7));
  return d.getTime();
}
export function atTime(day: number, h: number, m = 0): number {
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
/** Round to a 15-min step measured from local midnight. */
export function snap(ms: number, stepMin = 15, mode: "round" | "floor" | "ceil" = "round"): number {
  const day = startOfDay(ms);
  const step = stepMin * MIN;
  return day + Math[mode]((ms - day) / step) * step;
}
export function isAllDayish(e: { allDay: boolean; start: number; end: number }): boolean {
  return e.allDay || e.end - e.start >= DAY;
}

// ------------------------------------------------------------ labels

const H12 = (() => {
  try {
    const hc = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
    return hc ? hc === "h12" || hc === "h11" : true;
  } catch {
    return true;
  }
})();

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thur", "Fri", "Sat"];

function hm(ms: number): { h: number; m: number } {
  const d = new Date(ms);
  return { h: d.getHours(), m: d.getMinutes() };
}
function clock12(ms: number): { t: string; ap: "am" | "pm" } {
  const { h, m } = hm(ms);
  return { t: `${h % 12 || 12}:${String(m).padStart(2, "0")}`, ap: h < 12 ? "am" : "pm" };
}
function clock24(ms: number): string {
  const { h, m } = hm(ms);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtTime(ms: number): string {
  if (!H12) return clock24(ms);
  const c = clock12(ms);
  return `${c.t} ${c.ap}`;
}
/** `9:00 – 9:30 am`, `11:30 am – 1:00 pm`, or `09:00 – 09:30` in 24 h locales. */
export function fmtRange(start: number, end: number): string {
  if (!H12) return `${clock24(start)} – ${clock24(end)}`;
  const a = clock12(start);
  const b = clock12(end);
  return a.ap === b.ap ? `${a.t} – ${b.t} ${b.ap}` : `${a.t} ${a.ap} – ${b.t} ${b.ap}`;
}
export function hourLabel(h: number): string {
  if (!H12) return `${String(h).padStart(2, "0")}:00`;
  return `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
}
/** `Wed, Oct 21`, plus `, 2027` outside the current year. */
export function dayTitle(ms: number): string {
  const d = new Date(ms);
  const other = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: other ? "numeric" : undefined });
}
export function dayHeader(ms: number): { dow: string; day: number } {
  const d = new Date(ms);
  return { dow: DAY_SHORT[d.getDay()], day: d.getDate() };
}
/** `October 2026`, `Sep – Oct 2026`, `Dec 2026 – Jan 2027`. */
export function weekLabel(first: number, last: number): string {
  const a = new Date(first);
  const b = new Date(last);
  const mon = (d: Date, long = false) => d.toLocaleDateString("en-US", { month: long ? "long" : "short" });
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${mon(a, true)} ${a.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear()) return `${mon(a)} – ${mon(b)} ${a.getFullYear()}`;
  return `${mon(a)} ${a.getFullYear()} – ${mon(b)} ${b.getFullYear()}`;
}
/** `Wed, Oct 21 · 9:00 – 9:30 am` (popover / invite "When" row). */
export function whenLong(e: { start: number; end: number; allDay: boolean }): string {
  if (isAllDayish(e)) {
    const lastDay = addDays(startOfDay(e.end - 1), 0);
    return startOfDay(e.start) === startOfDay(lastDay) ? `${dayTitle(e.start)} · All day` : `${dayTitle(e.start)} – ${dayTitle(lastDay)}`;
  }
  if (startOfDay(e.start) !== startOfDay(e.end - 1)) return `${dayTitle(e.start)} ${fmtTime(e.start)} – ${dayTitle(e.end)} ${fmtTime(e.end)}`;
  return `${dayTitle(e.start)} · ${fmtRange(e.start, e.end)}`;
}
export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  if (min === 60) return "1 hour";
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hours`;
}

// ------------------------------------------------------------ events

export const PALETTE: Record<string, string> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d60000",
};

// ------------------------------------------------------------ event colors
// Every event/calendar color maps to a hue with a 9-step tonal ramp and picks steps per state and
// theme (never alpha or opacity). Iris adds a contrast clamp: text always reaches 4.5:1 on its own background.
// These ramps are the only calendar hexes in the web app; calendar.css reads the --ev-* variables set from calTone().

export type CalHue = "blue" | "cobalt" | "navy" | "green" | "lime" | "yellow" | "orange" | "red" | "pink" | "magenta" | "violet" | "pewter";
/** Glass is light: it uses the Paper tone steps on its own surfaces. */
export type CalTheme = "graphite" | "paper" | "glass";

/** Ramp steps, index-aligned with every RAMPS entry. */
export const RAMP_STEPS = [0, 10, 20, 30, 40, 60, 80, 90, 100] as const;
type Step = (typeof RAMP_STEPS)[number];

/** Tonal ramp per hue, steps RAMP_STEPS. */
export const RAMPS: Record<CalHue, readonly string[]> = {
  blue: ["#eff8fd", "#daedfb", "#bbdff7", "#8dcaf2", "#4198d2", "#1173a8", "#0c5683", "#0a476d", "#16293d"],
  cobalt: ["#eff6fd", "#dae8fb", "#bbd5f7", "#8db9f2", "#4180d2", "#115aa8", "#0c4283", "#093366", "#16223d"],
  navy: ["#eff3fd", "#dae2fb", "#bbcbf7", "#8da8f2", "#4168d2", "#1141a8", "#0c2e83", "#092466", "#161c3d"],
  green: ["#f4fdfa", "#d5f7eb", "#98ebcd", "#3ac7a1", "#26a28b", "#148072", "#005c54", "#0c4243", "#17261f"],
  lime: ["#fbfbe4", "#f5f3bc", "#ebe898", "#bec73a", "#8fa226", "#677d14", "#455c00", "#30430c", "#262417"],
  yellow: ["#fff8da", "#fef1bb", "#fcdf83", "#f9d255", "#f5c428", "#dfad0d", "#ae880d", "#755c0a", "#5a4402"],
  orange: ["#fff8e1", "#fff2c9", "#ffd599", "#ffb956", "#ffab36", "#db8000", "#bf7000", "#8f4900", "#6b2f00"],
  red: ["#fff0f0", "#fedbdb", "#ffa8aa", "#ff565e", "#f72a42", "#cd0037", "#9f182d", "#860628", "#5b051c"],
  pink: ["#fff2f6", "#ffdce7", "#f6aac3", "#da7c95", "#bf6174", "#8d3d48", "#792d32", "#602626", "#421d1d"],
  magenta: ["#fff2fa", "#ffdcf3", "#f6aadd", "#da7cb4", "#bf6193", "#8d3d62", "#792d4b", "#602639", "#421d24"],
  violet: ["#f7f5ff", "#e8e0ff", "#d4c7ff", "#bea1f5", "#9e7be0", "#714cb6", "#533192", "#3f256f", "#281647"],
  pewter: ["#fcfaf7", "#f2f0eb", "#dedbd5", "#bfbcb6", "#8d8a86", "#73716d", "#474543", "#292827", "#141413"],
};

/** Google event `colorId` → hue. */
export const GOOGLE_EVENT_HUE: Record<string, CalHue> = {
  "1": "cobalt", // Lavender
  "2": "green", // Sage
  "3": "magenta", // Grape
  "4": "red", // Flamingo
  "5": "yellow", // Banana
  "6": "orange", // Tangerine
  "7": "blue", // Peacock
  "8": "pewter", // Graphite
  "9": "navy", // Blueberry
  "10": "lime", // Basil
  "11": "pink", // Tomato
};

/** Event palette hexes → colorId: the current Google palette (PALETTE + variants) and the classic one colors.get returns (core EVENT_COLORS). */
const EVENT_HEX_ID: Record<string, string> = {
  "#f6c026": "5",
  "#f5511d": "6",
  "#a4bdfc": "1",
  "#7ae7bf": "2",
  "#dbadff": "3",
  "#ff887c": "4",
  "#fbd75b": "5",
  "#ffb878": "6",
  "#46d6db": "7",
  "#e1e1e1": "8",
  "#5484ed": "9",
  "#51b749": "10",
  "#dc2127": "11",
};

/** Calendar color representatives, restricted to the hues that have a ramp here. */
export const CALENDAR_COLOR_REPS: Record<CalHue, readonly [number, number, number]> = {
  blue: [115, 182, 219],
  green: [138, 214, 172],
  orange: [224, 159, 129],
  pink: [236, 155, 184],
  red: [227, 148, 148],
  yellow: [228, 196, 80],
  lime: [186, 210, 115],
  cobalt: [141, 162, 216],
  magenta: [213, 161, 215],
  navy: [111, 140, 195],
  pewter: [155, 153, 151],
  violet: [143, 112, 194],
};

function rgbOf(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const lin = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
function oklab([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const REP_LAB = (Object.keys(CALENDAR_COLOR_REPS) as CalHue[]).map((h) => [h, oklab(CALENDAR_COLOR_REPS[h])] as const);

/**
 * colorId first; else an exact event-palette hex → colorId; else the nearest representative in OKLab; default "blue".
 * The representatives are pastel, so lightness counts a quarter (plain Euclidean maps Google green #16a765 to pewter
 * and grey #c2c2c2 to green).
 */
export function hueOf(color: { colorId?: string; hex?: string }): CalHue {
  if (color.colorId && GOOGLE_EVENT_HUE[color.colorId]) return GOOGLE_EVENT_HUE[color.colorId];
  const hex = color.hex?.trim().toLowerCase();
  if (!hex) return "blue";
  const id = EVENT_HEX_ID[hex] ?? Object.keys(PALETTE).find((k) => PALETTE[k] === hex);
  if (id && GOOGLE_EVENT_HUE[id]) return GOOGLE_EVENT_HUE[id];
  const rgb = rgbOf(hex);
  if (!rgb) return "blue";
  const [L, a, b] = oklab(rgb);
  let best: CalHue = "blue";
  let bestD = Infinity;
  for (const [h, [L2, a2, b2]] of REP_LAB) {
    const d = 0.25 * (L - L2) ** 2 + (a - a2) ** 2 + (b - b2) ** 2;
    if (d < bestD) [best, bestD] = [h, d];
  }
  return best;
}

/** WCAG 2.x contrast ratio of two hex colors (1–21). */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = (rgbOf(hex) ?? [0, 0, 0]).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export interface CalTone {
  bg: string;
  fg: string;
  border: string;
  swatch: string;
  borderStyle: "solid" | "dashed";
  borderWidth: number;
}
export interface CalToneState {
  style: BlockStyle;
  past: boolean;
}

/** The calendar surfaces an event can sit on (calendar.css `--cal-surface`): week grid = --bg, day pane = --bg-sunken. */
export const CAL_SURFACES: Record<CalTheme, readonly string[]> = {
  graphite: ["#292827", "#1f1e1d"],
  paper: ["#ffffff", "#fcfaf7"],
  // week grid on the white sheet; day pane = glass --bg-sunken (the opaque stand-in for the frosted pane, ≈ its rendered fill)
  glass: ["#ffffff", "#f5f7fa"],
};
/** Rendered surface for transparent ("bordered") blocks and the 1px gap; resolved by calendar.css. */
const SURFACE = "var(--cal-surface, var(--bg))";
const AA = 4.5;

const at = (hue: CalHue, step: Step) => RAMPS[hue][RAMP_STEPS.indexOf(step)];
/** First step from `from` (walking `dir` along the ramp) whose color reaches 4.5:1 on every background. */
function readable(hue: CalHue, from: Step, dir: 1 | -1, on: readonly string[]): string {
  const ramp = RAMPS[hue];
  let i = RAMP_STEPS.indexOf(from);
  for (; i >= 0 && i < ramp.length; i += dir) if (on.every((b) => contrast(ramp[i], b) >= AA)) return ramp[i];
  return ramp[dir < 0 ? 0 : ramp.length - 1];
}
/** Graphite filled fill: step 60, else the first darker step that carries step-0 text (yellow/orange → 90, lime → 80). */
function carbonFillIndex(hue: CalHue): number {
  const fg = at(hue, 0);
  for (const s of [60, 80, 90, 100] as const) if (contrast(at(hue, s), fg) >= AA) return RAMP_STEPS.indexOf(s);
  return RAMP_STEPS.length - 1;
}

/**
 * Colors for one event block. Fixed tone steps per state, clamped for contrast.
 * Past events use darker (Graphite) or lighter (Paper) ramp steps, never opacity.
 */
export function calTone(hue: CalHue, theme: CalTheme, s: CalToneState): CalTone {
  const ramp = RAMPS[hue];
  const surfaces = CAL_SURFACES[theme];
  const dark = theme === "graphite";
  const fillI = dark ? carbonFillIndex(hue) : RAMP_STEPS.indexOf(20);
  const swatch = ramp[fillI];
  if (s.style === "focused") {
    const v = RAMPS.violet;
    return dark
      ? { bg: v[7], fg: v[1], border: v[3], swatch: v[5], borderStyle: "solid", borderWidth: 1.5 }
      : { bg: v[0], fg: v[6], border: v[5], swatch: v[2], borderStyle: "solid", borderWidth: 1.5 };
  }
  if (s.style === "filled") {
    if (dark) {
      if (!s.past) return { bg: swatch, fg: ramp[0], border: SURFACE, swatch, borderStyle: "solid", borderWidth: 0 };
      // past: step 90; hues already clamped to 90 go one darker, so past stays distinguishable
      const bg = ramp[Math.max(RAMP_STEPS.indexOf(90), Math.min(fillI + 1, ramp.length - 1))];
      return { bg, fg: readable(hue, 20, -1, [bg]), border: SURFACE, swatch, borderStyle: "solid", borderWidth: 0 };
    }
    const bg = s.past ? at(hue, 0) : swatch;
    return { bg, fg: readable(hue, s.past ? 60 : 90, 1, [bg]), border: SURFACE, swatch, borderStyle: "solid", borderWidth: 0 };
  }
  // bordered (needsAction, declined, free) and dashed (tentative): transparent fill on the calendar surface
  const borderStyle = s.style === "dashed" ? "dashed" : "solid";
  const fg = dark ? readable(hue, s.past ? 40 : 20, -1, surfaces) : readable(hue, 60, 1, surfaces);
  const border = dark ? at(hue, s.past ? 40 : 30) : at(hue, s.past ? 40 : 60);
  return { bg: SURFACE, fg, border, swatch, borderStyle, borderWidth: 1 };
}

/** Inline custom properties for calendar.css (`--ev-bg`, `--ev-fg`, `--ev-border`, `--ev-swatch`, `--ev-bs`, `--ev-bw`). */
export function toneVars(t: CalTone): Record<string, string> {
  return { "--ev-bg": t.bg, "--ev-fg": t.fg, "--ev-border": t.border, "--ev-swatch": t.swatch, "--ev-bs": t.borderStyle, "--ev-bw": `${t.borderWidth}px` };
}

/** Readable text on a solid color block. */
export function textOn(hex: string): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "#fff";
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? "#1f1e1d" : "#ffffff";
}

export function guests(e: { attendees: EventAttendee[] }): EventAttendee[] {
  return e.attendees.filter((a) => !a.self);
}

const STATUS_ORDER: Record<ResponseStatus, number> = { accepted: 1, declined: 2, tentative: 3, needsAction: 4 };
/** Organizer first, then accepted, declined, tentative, needsAction; each group by email. */
export function sortAttendees(list: EventAttendee[], organizerEmail?: string): EventAttendee[] {
  const rank = (a: EventAttendee) => (a.organizer || a.email === organizerEmail ? 0 : STATUS_ORDER[a.responseStatus] ?? 5);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email));
}

export interface Conference {
  url: string;
  label: string; // row label
  join: string; // button label
}
/** conferenceUrl, else a Meet / Zoom / Teams link found in the description or location. */
export function conferenceOf(e: { conferenceUrl?: string; description?: string; location?: string }, accountEmail?: string): Conference | null {
  let url = e.conferenceUrl;
  if (!url) {
    const hay = `${e.location ?? ""}\n${e.description ?? ""}`;
    url =
      hay.match(/https?:\/\/(?:www\.)?meet\.google\.com\/[a-z0-9-]+/i)?.[0] ??
      hay.match(/https?:\/\/[\w.-]*zoom\.us\/j\/[^\s<>"]+/i)?.[0] ??
      hay.match(/https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"]+/i)?.[0] ??
      undefined;
  }
  if (!url) return null;
  if (/meet\.google\.com/i.test(url)) {
    const full = accountEmail && !/authuser=/.test(url) ? `${url}${url.includes("?") ? "&" : "?"}authuser=${encodeURIComponent(accountEmail)}` : url;
    return { url: full, label: "Meet", join: "Join Google Meet" };
  }
  if (/zoom\.us/i.test(url)) return { url, label: "Zoom", join: "Join Zoom Call" };
  if (/teams\.microsoft\.com/i.test(url)) return { url, label: "Teams", join: "Join Teams Call" };
  return { url, label: "Video", join: "Join Meeting" };
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Normalise the thread payload's invite (tolerates the older payload shape). */
export function inviteView(inv: CalendarInvite, threadId: string, localAnswer?: ResponseStatus): InviteView {
  const raw = inv as Partial<CalendarInvite> & CalendarInvite;
  const method = String(raw.method ?? "REQUEST").toUpperCase();
  const kind = raw.kind ?? (method === "CANCEL" ? "cancel" : method === "REPLY" ? "reply" : "request");
  const ev = raw.event;
  const attendees = raw.attendees?.length ? raw.attendees : (ev?.attendees ?? []);
  const recurring = raw.recurring ?? !!ev?.recurringEventId;
  const canRsvp = raw.canRsvp ?? ((kind === "request" || kind === "update") && !!ev && (!!ev.selfResponse || attendees.some((a) => a.self)) && !ev.organizer.self);
  let replyFrom = raw.replyFrom;
  if (!replyFrom && kind === "reply") {
    const a = attendees.find((x) => !x.self && x.responseStatus !== "needsAction");
    if (a) replyFrom = { email: a.email, name: a.name, responseStatus: a.responseStatus };
  }
  return {
    iCalUID: raw.iCalUID,
    kind,
    summary: raw.summary || ev?.summary || "",
    description: raw.description ?? ev?.description ?? "",
    start: raw.start,
    end: raw.end,
    allDay: raw.allDay,
    location: raw.location ?? ev?.location ?? "",
    conferenceUrl: raw.conferenceUrl ?? ev?.conferenceUrl,
    organizer: raw.organizer ?? ev?.organizer ?? { email: "", name: "" },
    attendees,
    selfResponse: localAnswer ?? raw.selfResponse ?? ev?.selfResponse,
    recurring,
    canRsvp,
    canAdd: !ev && !recurring && (kind === "request" || kind === "update") && !/^calendly-/i.test(raw.iCalUID ?? ""),
    replyFrom,
    messageId: raw.messageId,
    threadId,
    event: ev,
  };
}

// ------------------------------------------------------------ grid items + cascading overlap layout

export type BlockStyle = "filled" | "bordered" | "dashed" | "focused";

export interface GridItem {
  key: string;
  kind: "event" | "invite" | "draft" | "slot";
  start: number;
  end: number;
  allDay: boolean;
  title: string;
  /** tone source (hueOf: event color, else calendar color, else blue); draft and slot use violet */
  hue: CalHue;
  style: BlockStyle;
  past: boolean;
  highlight?: boolean;
  event?: CalendarEvent;
  slotIndex?: number;
}

export interface Placed {
  item: GridItem;
  top: number;
  height: number;
  left: number; // %
  width: number; // %
  z: number;
  /** clipped segment bounds within the day */
  segStart: number;
  segEnd: number;
}

/**
 * Cascade layout: columns per overlap cluster; a later-starting child (≥ 30 min after its
 * parent) is only indented 5 %, overlapped blocks are 1.7× their column width (min 33 %), indent capped at 90 %.
 */
export function layoutDay(items: GridItem[], dayStart: number, dayEnd: number): Placed[] {
  const segs = items
    .map((item) => {
      const s = Math.max(item.start, dayStart);
      const e = Math.min(item.end, dayEnd);
      return { item, s, e, le: Math.max(e, s + 15 * MIN) };
    })
    .filter((x) => x.e > x.s || (x.item.start >= dayStart && x.item.start < dayEnd))
    .sort((a, b) => a.s - b.s || b.le - b.s - (a.le - a.s));
  const out: Placed[] = [];
  let i = 0;
  while (i < segs.length) {
    // one cluster of transitively overlapping events
    let j = i;
    let maxEnd = segs[i].le;
    while (j + 1 < segs.length && segs[j + 1].s < maxEnd) {
      j++;
      maxEnd = Math.max(maxEnd, segs[j].le);
    }
    const cluster = segs.slice(i, j + 1);
    const colEnds: number[] = [];
    const cols = cluster.map((x) => {
      let c = colEnds.findIndex((end) => end <= x.s);
      if (c < 0) c = colEnds.push(0) - 1;
      colEnds[c] = x.le;
      return c;
    });
    const n = colEnds.length;
    const base = 100 / n;
    const lefts: number[] = [];
    cluster.forEach((x, k) => {
      const c = cols[k];
      let left = 0;
      if (c > 0) {
        let parent = -1;
        for (let p = 0; p < k; p++) {
          const y = cluster[p];
          if (cols[p] < c && y.s < x.le && y.le > x.s && (parent < 0 || cols[p] > cols[parent] || (cols[p] === cols[parent] && y.s > cluster[parent].s))) parent = p;
        }
        left = parent >= 0 && x.s - cluster[parent].s >= 30 * MIN ? lefts[parent] + 5 : c * base;
      }
      left = Math.min(left, 90);
      lefts.push(left);
      const overlappedLater = cluster.some((y, q) => q !== k && cols[q] > c && y.s < x.le && y.le > x.s);
      const width = n === 1 || !overlappedLater ? 100 - left : Math.max(33, Math.min(100 - left, base * 1.7));
      out.push({
        item: x.item,
        top: ((x.s - dayStart) / MIN) * (HOUR_PX / 60),
        height: Math.max(Math.floor(((x.le - x.s) / MIN) * (HOUR_PX / 60)) - 1, 11),
        left,
        width: Math.min(width, 100 - left),
        z: out.length + 1,
        segStart: x.s,
        segEnd: x.e,
      });
    });
    i = j + 1;
  }
  return out;
}

// ------------------------------------------------------------ "When" parsing (create form suggestions)

export interface WhenParse {
  date?: number; // local midnight
  time?: { h: number; m: number };
  duration?: number; // minutes
  allDay?: boolean;
}

export interface WhenSuggestion {
  start: number;
  end: number;
  allDay: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januar|februar|märz|mai|juni|juli|oktober|dezember)";
const WEEKDAYS: [RegExp, number][] = [
  [/^(sun(day)?|sonntag)$/, 0],
  [/^(mon(day)?|montag)$/, 1],
  [/^(tue(s(day)?)?|dienstag)$/, 2],
  [/^(wed(nesday)?|mittwoch)$/, 3],
  [/^(thu(r(s(day)?)?)?|donnerstag)$/, 4],
  [/^(fri(day)?|freitag)$/, 5],
  [/^(sat(urday)?|samstag)$/, 6],
];

function monthIndex(s: string): number {
  const k = s.toLowerCase().replace("ä", "a").slice(0, 3);
  const de: Record<string, number> = { mai: 4, okt: 9, dez: 11, mar: 2 };
  return MONTHS.indexOf(k) >= 0 ? MONTHS.indexOf(k) : (de[k] ?? -1);
}

function fixYear(m: number, d: number, y: number | undefined, now: Date): number {
  if (y !== undefined) return new Date(y < 100 ? 2000 + y : y, m, d).getTime();
  const t = new Date(now.getFullYear(), m, d);
  // a date more than ~2 months in the past means next year
  if (t.getTime() < startOfDay(now.getTime()) - 60 * DAY) t.setFullYear(t.getFullYear() + 1);
  return t.getTime();
}

function to24(h: number, ap: string | undefined): number {
  if (!ap) return h;
  if (/^p/.test(ap)) return h % 12 + 12;
  if (/^a/.test(ap)) return h % 12;
  return h;
}

export function parseWhen(input: string, nowMs = Date.now()): WhenParse {
  const now = new Date(nowMs);
  const today = startOfDay(nowMs);
  let s = ` ${input.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ")} `;
  const r: WhenParse = {};
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => boolean | void) => {
    const m = s.match(re);
    if (m && fn(m) !== false) s = s.replace(m[0], " ");
  };
  const setAt = (at: number) => {
    r.date = startOfDay(at);
    r.time = { h: new Date(at).getHours(), m: new Date(at).getMinutes() };
  };

  take(/\b(all[ -]?day|ganztägig|ganztags)\b/, () => void (r.allDay = true));
  // relative offsets first, so "in 2 hours" is not read as a duration
  take(/\bin (\d+) ?(h|hrs?|hours?|stunden?|m|min|mins|minutes?|minuten)\b/, (m) => setAt(snap(nowMs + +m[1] * (/^(h|s)/.test(m[2]) ? HOUR : MIN), 5)));
  take(/\bin (\d+) (days?|tagen|weeks?|wochen)\b/, (m) => void (r.date = addDays(today, +m[1] * (/^w/.test(m[2]) ? 7 : 1))));
  // ISO / dotted (23.10.) / slashed (10/23) dates
  take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => void (r.date = new Date(+m[1], +m[2] - 1, +m[3]).getTime()));
  if (r.date === undefined)
    take(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?=\s|$)/, (m) => {
      if (+m[2] < 1 || +m[2] > 12 || +m[1] > 31) return false;
      r.date = fixYear(+m[2] - 1, +m[1], m[3] ? +m[3] : undefined, now);
    });
  if (r.date === undefined)
    take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
      if (+m[1] < 1 || +m[1] > 12 || +m[2] > 31) return false;
      r.date = fixYear(+m[1] - 1, +m[2], m[3] ? +m[3] : undefined, now);
    });
  // durations: "for 1h", "90 min", "1.5 hours", "1h30", "an hour", "half an hour"
  take(/\b(?:for )?half an? hour\b/, () => void (r.duration = 30));
  take(/\b(?:for )?an hour\b/, () => void (r.duration = 60));
  take(/\b(?:for )?(\d+(?:[.,]\d+)?) ?(h|hr|hrs|hour|hours|std|stunden?)\b(?: ?(\d{1,2}) ?(?:m|min|mins|minutes)?\b)?/, (m) => {
    r.duration = Math.round(parseFloat(m[1].replace(",", ".")) * 60 + (m[3] ? +m[3] : 0));
  });
  take(/\b(?:for )?(\d+) ?(m|min|mins|minute|minutes|minuten)\b/, (m) => void (r.duration = +m[1]));
  // ranges: "3-4pm", "10:00-11:30", "2pm to 4pm", "11-1pm"
  if (!r.time)
    take(/\b(?:from )?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm|a|p)?\.? ?(?:-|to|until|till|bis) ?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm|a|p)?\b/, (m) => {
      const h1 = +m[1];
      const h2 = +m[4];
      if (h1 > 23 || h2 > 24) return false;
      const ap2 = m[6];
      let b = to24(h2, ap2);
      let a = to24(h1, m[3] ?? ap2);
      if (!m[3] && ap2 && a >= b) a = to24(h1, /^p/.test(ap2) ? "am" : "pm");
      if (!m[3] && !ap2 && a < 8) {
        a += 12;
        if (b < 12) b += 12;
      }
      const startMin = a * 60 + (m[2] ? +m[2] : 0);
      let endMin = b * 60 + (m[5] ? +m[5] : 0);
      if (endMin <= startMin) endMin += 12 * 60;
      if (endMin <= startMin || endMin > 24 * 60) return false;
      r.time = { h: Math.floor(startMin / 60), m: startMin % 60 };
      r.duration = endMin - startMin;
    });
  if (!r.time) take(/\b(noon|mittag)\b/, () => void (r.time = { h: 12, m: 0 }));
  if (!r.time) take(/\bmidnight\b/, () => void (r.time = { h: 0, m: 0 }));
  if (!r.time)
    take(/\b(?:at |um )?(\d{1,2})[:.](\d{2}) ?(am|pm|a|p|uhr)?\b/, (m) => {
      const h = to24(+m[1], m[3]);
      if (h > 23 || +m[2] > 59) return false;
      r.time = { h, m: +m[2] };
    });
  if (!r.time)
    take(/\b(?:at |um )?(\d{1,2}) ?(am|pm|a\.m\.|p\.m\.|uhr)(?=\s|$|\.)/, (m) => {
      const h = to24(+m[1], m[2]);
      if (h > 23) return false;
      r.time = { h, m: 0 };
    });
  // month-name dates: "oct 23", "23 oct", "october 23rd 2027"
  if (r.date === undefined)
    take(new RegExp(`\\b${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?,?(?: (\\d{4}))?\\b`), (m) => {
      const mi = monthIndex(m[1]);
      if (mi < 0) return false;
      r.date = fixYear(mi, +m[2], m[3] ? +m[3] : undefined, now);
    });
  if (r.date === undefined)
    take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|\\.)? ${MONTH_RE}\\.?(?: (\\d{4}))?\\b`), (m) => {
      const mi = monthIndex(m[2]);
      if (mi < 0) return false;
      r.date = fixYear(mi, +m[1], m[3] ? +m[3] : undefined, now);
    });
  // relative words
  if (r.date === undefined) {
    take(/\b(day after tomorrow|übermorgen|overmorrow)/, () => void (r.date = addDays(today, 2)));
    take(/\b(today|tod|heute|tonight)\b/, (m) => {
      r.date = today;
      if (m[1] === "tonight" && !r.time) r.time = { h: 19, m: 0 };
    });
    take(/\b(tomorrow|tmrw|tmr|tomo|morgen)\b/, () => void (r.date = addDays(today, 1)));
    take(/\bnext week\b/, () => void (r.date = addDays(today, (1 - now.getDay() + 7) % 7 || 7)));
    const wm = [...s.matchAll(/(next |this )?\b([a-zäöü]+)/g)].find((m) => WEEKDAYS.some(([re]) => re.test(m[2])));
    if (wm) {
      const wd = WEEKDAYS.find(([re]) => re.test(wm[2]))![1];
      let diff = (wd - now.getDay() + 7) % 7;
      if (wm[1] === "next " && diff === 0) diff = 7;
      r.date = addDays(today, diff);
      s = s.replace(wm[0], " ");
    }
  }
  if (!r.time)
    take(/\b(morning|afternoon|evening|abends?|nachmittags?|vormittags?)\b/, (m) => {
      const h = /^(morning|vormittag)/.test(m[1]) ? 9 : /^(afternoon|nachmittag)/.test(m[1]) ? 14 : 18;
      r.time = { h, m: 0 };
    });
  if (!r.time)
    take(/\b(?:at |um )?(\d{1,2})\b/, (m) => {
      const h = +m[1];
      if (h > 23) return false;
      r.time = { h: h >= 1 && h <= 7 ? h + 12 : h, m: 0 };
    });
  return r;
}

/** Always three choices: date+time → 30 min, 1 h, 15 min; date → 10:00, 13:00, all day; time → today, tomorrow, day after; duration → 10:00, 13:00, 17:00. */
export function whenSuggestions(input: string, nowMs = Date.now()): WhenSuggestion[] {
  const p = parseWhen(input, nowMs);
  const today = startOfDay(nowMs);
  const durs = (d?: number) => (d ? [d, ...[30, 60, 15].filter((x) => x !== d)] : [30, 60, 15]);
  const timed = (day: number, h: number, m: number, dur: number): WhenSuggestion => {
    const start = atTime(day, h, m);
    return { start, end: start + dur * MIN, allDay: false };
  };
  const allDay = (day: number): WhenSuggestion => ({ start: day, end: addDays(day, 1), allDay: true });
  if (p.allDay) {
    const day = p.date ?? (p.time ? today : addDays(today, nowMs > atTime(today, 17) ? 1 : 0));
    const multi = p.duration && p.duration >= 24 * 60 ? Math.round(p.duration / (24 * 60)) : 1;
    return [{ start: day, end: addDays(day, multi), allDay: true }, timed(day, 10, 0, 30), timed(day, 13, 0, 30)];
  }
  if (p.date !== undefined && p.time) return durs(p.duration).slice(0, 3).map((d) => timed(p.date!, p.time!.h, p.time!.m, d));
  if (p.date !== undefined) {
    const d = p.duration ?? 30;
    return [timed(p.date, 10, 0, d), timed(p.date, 13, 0, d), allDay(p.date)];
  }
  if (p.time) {
    const d = p.duration ?? 30;
    return [0, 1, 2].map((n) => timed(addDays(today, n), p.time!.h, p.time!.m, d));
  }
  if (p.duration) {
    return [10, 13, 17].map((h) => timed(atTime(today, h) > nowMs ? today : addDays(today, 1), h, 0, p.duration!)).sort((a, b) => a.start - b.start);
  }
  // nothing usable: the next quarter hour, then tomorrow morning / afternoon
  const next = snap(nowMs + 5 * MIN, 15, "ceil");
  return [
    { start: next, end: next + 30 * MIN, allDay: false },
    timed(addDays(today, 1), 10, 0, 30),
    timed(addDays(today, 1), 13, 0, 30),
  ];
}

/** Text for the When field that parses back to the same start (e.g. `Wed Oct 21 2:15pm for 45 min`). */
export function whenText(start: number, end: number, allDay: boolean): string {
  const d = new Date(start);
  const other = d.getFullYear() !== new Date().getFullYear();
  const date = `${DAY_SHORT[d.getDay()].slice(0, 3)} ${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()}${other ? ` ${d.getFullYear()}` : ""}`;
  if (allDay) {
    const days = Math.round((startOfDay(end) - startOfDay(start)) / DAY);
    return `${date} all day${days > 1 ? ` for ${days * 24}h` : ""}`;
  }
  const c = clock12(start);
  const mins = Math.round((end - start) / MIN);
  return `${date} ${c.t}${c.ap}${mins !== 30 ? ` for ${mins >= 60 && mins % 60 === 0 ? `${mins / 60}h` : `${mins} min`}` : ""}`;
}

// ------------------------------------------------------------ share availability text

/** `PDT` / `CEST` where a common abbreviation exists (en-US knows US zones, en-GB European ones), else `GMT+8`. */
function tzAbbrev(at: number, timeZone?: string): string {
  const name = (locale: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {
      return "";
    }
  };
  const us = name("en-US");
  if (!/^(GMT|UTC)[+-]/.test(us)) return us;
  const gb = name("en-GB");
  return gb && !/^(GMT|UTC)[+-]/.test(gb) ? gb : us;
}

function zoned(ms: number, timeZone?: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { y: +get("year"), mo: +get("month") - 1, d: +get("day"), h: +get("hour") % 24, mi: +get("minute"), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

const MON_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `today (Oct 21)`, `tomorrow (Oct 22)`, `Wed Oct 23` (< 8 days), `Oct 30` (+ year if not this year). */
function availDate(ms: number, nowMs: number, timeZone?: string): { label: string; relative: boolean } {
  const z = zoned(ms, timeZone);
  const n = zoned(nowMs, timeZone);
  const diff = Math.round((Date.UTC(z.y, z.mo, z.d) - Date.UTC(n.y, n.mo, n.d)) / DAY);
  const md = `${MON_SHORT[z.mo]} ${z.d}`;
  if (diff === 0) return { label: `today (${md})`, relative: true };
  if (diff === 1) return { label: `tomorrow (${md})`, relative: true };
  if (diff > 1 && diff < 8) return { label: `${WD_SHORT[z.wd]} ${md}`, relative: false };
  return { label: z.y !== n.y ? `${md}, ${z.y}` : md, relative: false };
}

function availRange(a: number, b: number, timeZone?: string): string {
  const fmt = (ms: number) => {
    const z = zoned(ms, timeZone);
    return { t: `${z.h % 12 || 12}:${String(z.mi).padStart(2, "0")}`, ap: z.h < 12 ? "am" : "pm" };
  };
  const x = fmt(a);
  const y = fmt(b);
  return x.ap === y.ap ? `${x.t}–${y.t} ${y.ap}` : `${x.t} ${x.ap}–${y.t} ${y.ap}`;
}

function availDuration(min: number): string {
  if (min === 60) return "an hour";
  if (min > 60) return `${Number.isInteger(min / 60) ? min / 60 : (min / 60).toFixed(1)} hrs`;
  return `${min} min`;
}

export function mergeSlots(slots: TimeRange[]): TimeRange[] {
  const sorted = [...slots].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Availability text (single person: "I"). */
export function renderAvailabilityText(slotsIn: TimeRange[], duration: number, timeZone?: string, nowMs = Date.now()): string {
  const slots = mergeSlots(slotsIn);
  if (!slots.length) return "";
  const tz = tzAbbrev(slots[0].start, timeZone);
  const exact = slots.every((s) => Math.round((s.end - s.start) / MIN) === duration);
  const byDay = new Map<string, TimeRange[]>();
  for (const s of slots) {
    const z = zoned(s.start, timeZone);
    const k = `${z.y}-${z.mo}-${z.d}`;
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const days = [...byDay.values()];
  if (days.length === 1 && days[0].length <= 3) {
    const { label, relative } = availDate(days[0][0].start, nowMs, timeZone);
    const ranges = days[0].map((s) => availRange(s.start, s.end, timeZone));
    const list = ranges.length === 1 ? ranges[0] : ranges.length === 2 ? `${ranges[0]} or ${ranges[1]}` : `${ranges.slice(0, -1).join(", ")}, or ${ranges[ranges.length - 1]}`;
    const head = exact ? `Does ${label} work?` : `Does ${availDuration(duration)} ${relative ? "" : "on "}${label} work?`;
    return `${head} I can do ${list}${tz ? ` ${tz}` : ""}.`;
  }
  const head = exact ? `Do any of these times${tz ? ` (${tz})` : ""} work?` : `Does ${availDuration(duration)} during any of these times${tz ? ` (${tz})` : ""} work?`;
  const lines = days.map((d) => `- ${availDate(d[0].start, nowMs, timeZone).label}: ${d.map((s) => availRange(s.start, s.end, timeZone)).join(", ")}`);
  return [head, ...lines].join("\n");
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
