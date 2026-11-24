// App state: a tiny external store + the actions the UI and keyboard map to.
import { useRef, useSyncExternalStore } from "react";
import type { Address, Calendar, CalendarEvent, Goal, IrisEvent, Label, Split, Thread, ThreadSummary, ViewName } from "@iris/core/types.ts";
import { api, ApiError } from "./api";
import { emit } from "./bus";
import type { CalAvail, CalSettings, EventFormInit, InviteView, Rect } from "./calutil";
import type { IconName } from "./components/Icon";
import { meetingResearchPrompt, onResearchChanged, type ResearchCard, type ResearchPane } from "./research";

export type Filter = null | "unread" | "starred" | "important";

/** Resolved UI theme (`<html data-theme>`). Glass is the light default, Graphite the dark one, Paper the classic light one. */
export type Theme = "glass" | "graphite" | "paper";
/** "system" follows the OS: light → Glass, dark → Graphite. */
export function resolveTheme(setting: Theme | "system" | undefined): Theme {
  if (setting === "system") return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "graphite" : "glass";
  return setting === "graphite" || setting === "paper" ? setting : "glass";
}

export type RouteBase =
  | { view: "inbox"; splitId?: string }
  | { view: "label"; labelId: string; name: string }
  | { view: "search"; q: string }
  | { view: Exclude<ViewName, "inbox" | "split" | "label" | "search"> };
/** Every route is scoped: an account id, or `ALL` for the unified views ("All Inboxes"). */
export type Route = RouteBase & { account: string };
/** `navigate()` input: without `account` the current scope is kept. */
export type RouteInput = RouteBase & { account?: string };
export const ALL = "all";

/** A thread is only unique per account: unified lists can hold the same Gmail-style id twice (and the demo does). */
export interface Ref {
  account: string;
  threadId: string;
}
export const refKey = (account: string, threadId: string): string => `${account}\n${threadId}`;
export const keyOf = (t: { accountId: string; id: string }): string => refKey(t.accountId, t.id);
export const refOf = (t: { accountId: string; id: string }): Ref => ({ account: t.accountId, threadId: t.id });
export function parseKey(k: string): Ref {
  const i = k.indexOf("\n");
  return { account: k.slice(0, i), threadId: k.slice(i + 1) };
}

export interface SplitWithCount extends Split {
  count: number;
  unread: number;
}
/** Unified splits (`/api/splits?account=all`) carry no `enabled` flag: they are always on. */
export const splitOn = (s: Pick<Split, "enabled">): boolean => s.enabled !== false;

export interface StatusAccount {
  id: string;
  email: string;
  name: string;
  provider: string;
  inbox: number;
  unread: number;
  threads: number;
  lastSyncAt: number | null;
  /** deterministic per account; older daemons omit it */
  color?: string;
}

export interface MailboxCounts {
  inbox: number;
  inboxUnread: number;
  important: number;
  importantUnread: number;
  other: number;
  otherUnread: number;
  starred?: number;
  drafts?: number;
  reminders?: number;
  scheduled?: number;
  spam?: number;
  trash?: number;
}
export interface MailboxAccount {
  id: string;
  email: string;
  name: string;
  color: string;
  provider: string;
  error: string | null;
  counts: MailboxCounts;
  labels: { id: string; name: string; unread: number }[];
}
/** `GET /api/mailboxes`: sidebar data for every account in one call. */
export interface Mailboxes {
  unified: MailboxCounts;
  accounts: MailboxAccount[];
}

export interface Status {
  demo: boolean;
  accounts: StatusAccount[];
  settings: Settings;
  ai: { available: boolean; model: string };
  repo: string;
  node: string;
}

export interface Settings {
  undoSendSeconds: number;
  defaultReminderHour: number;
  autoAdvance: "next" | "previous" | "list";
  theme: Theme | "system";
  blockRemoteImages: boolean;
  ai: { enabled: boolean; model: string; autoSummarize: boolean; autoLabels: boolean; autoLabelCategories: string[]; autoLabelGuide: Record<string, string>; classifyModel: string; translateTo: string };
  agent: { allowSend: boolean };
  syncIntervalSeconds: number;
  calendar?: { notifyLeadSeconds: number; defaultMeetingLink: "meet" | null; rsvpAndDone: boolean };
}

export interface Attachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  size: number;
}

export interface ComposeState {
  key: string;
  mode: "new" | "reply" | "replyAll" | "forward";
  /** "From": the account that sends (DraftInput.accountId) */
  accountId: string;
  /** account `threadId` / `inReplyToMessageId` / `draftId` belong to. When From differs, the message starts a new conversation. */
  threadAccount?: string;
  threadId?: string;
  inReplyToMessageId?: string;
  draftId?: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  showCc: boolean;
  showBcc: boolean;
  subject: string;
  html: string;
  attachments: Attachment[];
  popped: boolean;
}

export interface Toast {
  id: string;
  text: string;
  undoId?: string;
  outboxId?: string;
  sendAt?: number;
  kind?: "info" | "error" | "send" | "success";
  /** leading icon (replaces emoji prefixes in toast text) */
  icon?: IconName;
  /** kept mounted for the exit transition; ignored by undo */
  leaving?: boolean;
  action?: { label: string; run: () => void };
  /** client-side undo (calendar writes); `z` runs the newest one while its toast is visible */
  localUndo?: () => void | Promise<void>;
}

export type Overlay =
  | { kind: "palette" }
  | { kind: "remind"; refs: Ref[] }
  | { kind: "label"; mode: "add" | "move"; refs: Ref[] }
  | { kind: "sendLater" }
  | { kind: "snippets" }
  | { kind: "zero" }
  | { kind: "settings"; section?: string }
  | { kind: "shortcuts" }
  | { kind: "goLabel" }
  | { kind: "goal"; refs: Ref[] };

export interface AppState {
  status: Status | null;
  connected: boolean;
  bootError: string | null;
  /** the daemon understands `account=all`, `builtin:*` splits and `/api/mailboxes` */
  unified: boolean;
  mailboxes: Mailboxes | null;
  route: Route;
  filter: Filter;
  threads: ThreadSummary[];
  total: number;
  loading: boolean;
  cursor: number;
  /** multi-select: `refKey(account, threadId)` */
  selected: string[];
  openId: string | null;
  /** account of the open thread */
  openAccount: string | null;
  thread: Thread | null;
  /** splits of the route's scope (`builtin:*` ids in unified routes) */
  splits: SplitWithCount[];
  labelsBy: Record<string, Label[]>;
  overlay: Overlay | null;
  compose: ComposeState | null;
  toasts: Toast[];
  /** sidebar panel pinned next to the rail (⌘\, remembered) */
  navPinned: boolean;
  /** panel shown as a flyout over the content while unpinned (hover, ⌘⇧M) */
  navPeek: boolean;
  askOpen: boolean;
  searchOpen: boolean;
  theme: Theme;
  // ---- calendar
  /** right-pane day view ("See Your Day") or the week page ("See Your Week") that replaces the list */
  calPane: null | "day" | "week";
  /** pane to return to when the week page closes */
  calPrevPane: null | "day";
  /** local midnight of the active day (day pane date / focused day of the week page) */
  calDate: number;
  calEvents: CalendarEvent[];
  calRange: { from: number; to: number; account?: string } | null;
  calendars: Calendar[];
  calLoading: boolean;
  calError: { message: string; code?: string } | null;
  /** invite of the open thread, shown as a pseudo-event in the day pane */
  calInvite: InviteView | null;
  /** the day pane was opened automatically by an invite (closes again when the thread closes) */
  calAuto: boolean;
  /** scroll the grid to this time (bumped with seq so the same time can be re-applied) */
  calFocus: { at: number; seq: number } | null;
  calPopover: { event: CalendarEvent; rect: Rect; invite?: boolean } | null;
  calForm: EventFormInit | null;
  /** chosen time of the open create form, drawn as a draft block */
  calDraft: { start: number; end: number; allDay: boolean; title?: string } | null;
  calAvail: CalAvail | null;
  calSettings: CalSettings;
  /** AI labels unchecked in All Mail; `NO_LABEL` = threads without one */
  hiddenLabels: string[];
  mailboxLabels: MailboxLabels | null;
  mailboxCoverage: MailboxCoverage[];
  goals: Goal[];
  /** the goals page, which replaces the list */
  goalsOpen: boolean;
  /** "new goal" form open on the goals page */
  goalsForm: boolean;
  /** person research panel in the right slot; null = closed */
  research: ResearchPane | null;
  /** meeting-start "Research needed?" cards, oldest first */
  researchCards: ResearchCard[];
}

export const NO_LABEL = "\u0000none";
export interface MailboxLabels {
  labels: { name: string; count: number }[];
  unlabeled: number;
  total: number;
}
export interface MailboxCoverage {
  accountId: string;
  local: number;
  gmail: number | null;
  backfill: "idle" | "running" | "done";
  left: number;
}
const HIDDEN_LABELS_KEY = "iris.mailbox.hidden";
function loadHiddenLabels(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_LABELS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

const CAL_SETTINGS_KEY = "iris.calendar.settings";
function loadCalSettings(): CalSettings {
  const d: CalSettings = { weekStartsOn: 0, showWeekends: true, showDeclined: false };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(CAL_SETTINGS_KEY) ?? "{}") as Partial<CalSettings>) };
  } catch {
    return d;
  }
}
export function setCalSettings(p: Partial<CalSettings>): void {
  const calSettings = { ...state.calSettings, ...p };
  try {
    localStorage.setItem(CAL_SETTINGS_KEY, JSON.stringify(calSettings));
  } catch {
    /* private mode */
  }
  setState({ calSettings });
}

const NAV_PINNED_KEY = "iris.nav.pinned";
function loadNavPinned(): boolean {
  try {
    return localStorage.getItem(NAV_PINNED_KEY) !== "0";
  } catch {
    return true;
  }
}

let state: AppState = {
  status: null,
  connected: true,
  bootError: null,
  unified: false,
  mailboxes: null,
  route: { view: "inbox", account: ALL },
  filter: null,
  threads: [],
  total: 0,
  loading: true,
  cursor: 0,
  selected: [],
  openId: null,
  openAccount: null,
  thread: null,
  splits: [],
  labelsBy: {},
  overlay: null,
  compose: null,
  toasts: [],
  navPinned: loadNavPinned(),
  navPeek: false,
  askOpen: false,
  searchOpen: false,
  theme: "glass",
  // day pane open by default; closing it is remembered ("" = closed)
  calPane: typeof localStorage !== "undefined" && localStorage.getItem("iris.calPane") === "" ? null : "day",
  calPrevPane: null,
  calDate: new Date(new Date().setHours(0, 0, 0, 0)).getTime(),
  calEvents: [],
  calRange: null,
  calendars: [],
  calLoading: false,
  calError: null,
  calInvite: null,
  calAuto: false,
  calFocus: null,
  calPopover: null,
  calForm: null,
  calDraft: null,
  calAvail: null,
  calSettings: loadCalSettings(),
  hiddenLabels: loadHiddenLabels(),
  mailboxLabels: null,
  mailboxCoverage: [],
  goals: [],
  goalsOpen: false,
  goalsForm: false,
  research: null,
  researchCards: [],
};

const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  if ("navPinned" in p && p.navPinned !== state.navPinned) {
    try {
      localStorage.setItem(NAV_PINNED_KEY, p.navPinned ? "1" : "0");
    } catch {
      /* private mode */
    }
  }
  if ("calPane" in p && p.calPane !== "week" && p.calPane !== state.calPane) {
    try {
      localStorage.setItem("iris.calPane", p.calPane === "day" ? "day" : "");
    } catch {
      /* private mode */
    }
  }
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
function subscribeStore(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** Select from the store. The snapshot is cached per state object so derived arrays don't loop. */
export function useApp<T>(sel: (s: AppState) => T): T {
  const cache = useRef<{ s: AppState; v: T } | null>(null);
  cache.current = null; // re-run with the current selector on every render
  return useSyncExternalStore(subscribeStore, () => {
    if (cache.current && cache.current.s === state) return cache.current.v;
    const v = sel(state);
    cache.current = { s: state, v };
    return v;
  });
}

// ------------------------------------------------------------ helpers

// Toast timers pause while the pointer is over the stack and while the tab is hidden (Sonner).
let toastSeq = 0;
const TOAST_EXIT_MS = 200; // = --dur-exit
const toastTimers = new Map<string, { remaining: number; started: number; handle: ReturnType<typeof setTimeout> | null }>();
const toastPause = new Set<string>();
function armToast(id: string) {
  const t = toastTimers.get(id);
  if (!t || t.handle || toastPause.size) return;
  t.started = Date.now();
  t.handle = setTimeout(() => dismissToast(id), t.remaining);
}
export function toast(t: Omit<Toast, "id">, ms = 6000): string {
  const id = `t${++toastSeq}`;
  setState((s) => {
    const live = s.toasts.filter((x) => !x.leaving);
    const dropped = live.slice(0, Math.max(0, live.length - 2)); // at most 3 visible, newest last
    for (const d of dropped) toastTimers.delete(d.id);
    return { toasts: [...s.toasts.filter((x) => !dropped.includes(x)), { ...t, id }] };
  });
  if (ms > 0) {
    toastTimers.set(id, { remaining: ms, started: 0, handle: null });
    armToast(id);
  }
  return id;
}
export function dismissToast(id: string): void {
  const timer = toastTimers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  toastTimers.delete(id);
  if (!state.toasts.some((t) => t.id === id && !t.leaving)) return;
  setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_EXIT_MS);
}
/** `reason` lets hover and tab visibility pause independently. */
export function pauseToasts(reason = "hover"): void {
  toastPause.add(reason);
  const now = Date.now();
  for (const t of toastTimers.values()) {
    if (!t.handle) continue;
    clearTimeout(t.handle);
    t.handle = null;
    t.remaining = Math.max(500, t.remaining - (now - t.started));
  }
}
export function resumeToasts(reason = "hover"): void {
  toastPause.delete(reason);
  if (!toastPause.size) for (const id of toastTimers.keys()) armToast(id);
}
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => (document.hidden ? pauseToasts("hidden") : resumeToasts("hidden")));
export function errorToast(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ApiError && e.code === "ai_unavailable") {
    toast({ text: "Add your Anthropic API key to use Iris AI.", kind: "error", action: { label: "Settings", run: () => setState({ overlay: { kind: "settings", section: "ai" } }) } });
    return;
  }
  if (e instanceof ApiError && e.code === "calendar_scope") {
    toast({ text: msg, kind: "error", action: { label: "How to", run: () => setState({ overlay: { kind: "settings", section: "accounts" } }) } }, 10000);
    return;
  }
  if (e instanceof ApiError && e.code === "calendar_disabled") {
    const url = msg.match(/https?:\/\/\S+/)?.[0];
    toast({ text: msg.replace(/\s*https?:\/\/\S+/, ""), kind: "error", action: url ? { label: "Enable API", run: () => void window.open(url, "_blank", "noopener,noreferrer") } : undefined }, 12000);
    return;
  }
  toast({ text: msg, kind: "error" }, 8000);
}

// ------------------------------------------------------------ accounts

/** Fallback when the daemon doesn't send `color` yet: Apple system hues that read on Glass (no purple). */
export const ACCOUNT_COLORS = ["#007aff", "#ff9500", "#34c759", "#ff2d55", "#30b0c7", "#a2845e"];

export function primaryAccount(s: AppState = state): string | undefined {
  return s.status?.accounts[0]?.id;
}
/** A concrete account for account-bound work (new mail, availability, get-me-to-zero …): the route's, else the primary one. */
export function defaultAccount(s: AppState = state): string | undefined {
  return s.route.account !== ALL ? s.route.account : primaryAccount(s);
}
export function accountColor(s: AppState, id: string | null | undefined): string {
  if (!id) return "var(--icon)";
  const mb = s.mailboxes?.accounts.find((a) => a.id === id)?.color;
  if (mb) return mb;
  const i = s.status?.accounts.findIndex((a) => a.id === id) ?? -1;
  const st = i >= 0 ? s.status!.accounts[i].color : undefined;
  return st || ACCOUNT_COLORS[Math.max(0, i) % ACCOUNT_COLORS.length];
}
export function accountEmail(s: AppState, id: string | null | undefined): string {
  return (id && s.status?.accounts.find((a) => a.id === id)?.email) || id || "";
}
/** Labels of one account; `ALL` = every account's (deduped by name). */
export function labelsOf(s: AppState, account: string | null | undefined): Label[] {
  if (account && account !== ALL) return s.labelsBy[account] ?? [];
  const seen = new Set<string>();
  return Object.values(s.labelsBy)
    .flat()
    .filter((l) => (seen.has(l.name) ? false : (seen.add(l.name), true)));
}
export const userLabel = (l: Label): boolean => l.type === "user" && !l.name.startsWith("Iris/");

const recentlyRemoved = new Map<string, number>();
function markRemoved(refs: Ref[]) {
  const now = Date.now();
  for (const r of refs) recentlyRemoved.set(refKey(r.account, r.threadId), now);
}
function filterRemoved(list: ThreadSummary[]): ThreadSummary[] {
  const now = Date.now();
  for (const [k, at] of recentlyRemoved) if (now - at > 4000) recentlyRemoved.delete(k);
  return list.filter((t) => !recentlyRemoved.has(keyOf(t)));
}

export function isInboxRoute(r: Route): boolean {
  return r.view === "inbox";
}

export function routeTitle(r: Route, splits: SplitWithCount[]): string {
  switch (r.view) {
    case "inbox":
      return splits.find((s) => s.id === r.splitId)?.name ?? (r.splitId === "builtin:other" ? "Other" : r.splitId === "builtin:important" ? "Important" : "Inbox");
    case "label":
      return r.name;
    case "search":
      return `Search: ${r.q}`;
    case "done":
      return "Done";
    case "reminders":
      return "Reminders";
    case "scheduled":
      return "Scheduled";
    case "all":
      return "All Mail";
    default:
      return r.view[0].toUpperCase() + r.view.slice(1);
  }
}

// ------------------------------------------------------------ loading

let booted = false;

export async function boot(): Promise<void> {
  try {
    const status = await api.get<Status>("/api/status");
    const theme = resolveTheme(status.settings.theme);
    setState({ status, theme, bootError: null });
    if (!status.accounts.length) {
      setState({ loading: false });
      return;
    }
    const ids = status.accounts.map((a) => a.id);
    void loadGoals();
    await loadLabels(ids);
    const unified = await loadMailboxes();
    const prev = state.route;
    const keep = booted && (prev.account === ALL ? unified : ids.includes(prev.account));
    booted = true;
    if (!keep) {
      // launch: All Inboxes → Important; older daemons: first account, first split
      const account = unified ? ALL : ids[0];
      setState({ route: { view: "inbox", account } });
      await loadSplits();
      const sp = getState().splits;
      const first = (unified ? sp.find((x) => x.builtin === "important") : undefined) ?? sp.find(splitOn);
      setState({ route: { view: "inbox", account, splitId: first?.id ?? (unified ? "builtin:important" : undefined) } });
    } else await loadSplits();
    await loadList();
  } catch (e) {
    setState({ bootError: e instanceof Error ? e.message : String(e), loading: false });
  }
}

export async function refreshStatus(): Promise<void> {
  const status = await api.get<Status>("/api/status");
  setState({ status });
}

export async function loadGoals(): Promise<void> {
  try {
    setState({ goals: await api.get<Goal[]>("/api/goals") });
  } catch {
    /* keep the last goals; mutations report their own errors */
  }
}

let splitSeq = 0;
/** last splits per scope, shown at once when the scope changes (then refreshed) */
const splitCache = new Map<string, SplitWithCount[]>();
export async function loadSplits(): Promise<void> {
  const seq = ++splitSeq;
  const account = state.route.account;
  try {
    const res = await api.get<SplitWithCount[]>("/api/splits", { account });
    const splits = Array.isArray(res) ? res : [];
    splitCache.set(account, splits);
    if (seq === splitSeq && state.route.account === account) setState({ splits });
  } catch {
    /* keep the last splits; the list request reports the error */
  }
}

/** Labels per account (default: every connected account). */
export async function loadLabels(accounts: string[] = state.status?.accounts.map((a) => a.id) ?? []): Promise<void> {
  const res = await Promise.all(accounts.map((a) => api.get<Label[]>("/api/labels", { account: a }).catch(() => null)));
  setState((s) => {
    const labelsBy = { ...s.labelsBy };
    accounts.forEach((a, i) => {
      if (res[i]) labelsBy[a] = res[i]!;
    });
    return { labelsBy };
  });
}

/** Older daemons have no `/api/mailboxes`: assemble the same shape from per-account splits + labels. */
async function legacyMailboxes(): Promise<Mailboxes> {
  const accounts = state.status?.accounts ?? [];
  const splits = await Promise.all(accounts.map((a) => api.get<SplitWithCount[]>("/api/splits", { account: a.id }).catch(() => [] as SplitWithCount[])));
  const zero = (): MailboxCounts => ({ inbox: 0, inboxUnread: 0, important: 0, importantUnread: 0, other: 0, otherUnread: 0 });
  const unified = zero();
  const list: MailboxAccount[] = accounts.map((a, i) => {
    const imp = splits[i].find((x) => x.builtin === "important");
    const oth = splits[i].find((x) => x.builtin === "other");
    const counts: MailboxCounts = { inbox: a.inbox, inboxUnread: a.unread, important: imp?.count ?? 0, importantUnread: imp?.unread ?? 0, other: oth?.count ?? 0, otherUnread: oth?.unread ?? 0 };
    for (const k of ["inbox", "inboxUnread", "important", "importantUnread", "other", "otherUnread"] as const) unified[k] += counts[k];
    const labels = (state.labelsBy[a.id] ?? []).filter(userLabel).map((l) => ({ id: l.id, name: l.name, unread: l.messagesUnread ?? 0 }));
    return { id: a.id, email: a.email, name: a.name, color: a.color || ACCOUNT_COLORS[i % ACCOUNT_COLORS.length], provider: a.provider, error: null, counts, labels };
  });
  return { unified, accounts: list };
}

let mbSeq = 0;
/** Sidebar counts. Returns whether the daemon speaks the unified contract. */
export async function loadMailboxes(): Promise<boolean> {
  const seq = ++mbSeq;
  try {
    const mailboxes = await api.get<Mailboxes>("/api/mailboxes");
    if (seq === mbSeq) setState({ mailboxes, unified: true });
    return true;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) return state.unified;
    const mailboxes = await legacyMailboxes().catch(() => null);
    if (seq === mbSeq) setState({ mailboxes, unified: false });
    return false;
  }
}

let mbTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleMailboxes() {
  if (mbTimer) clearTimeout(mbTimer);
  mbTimer = setTimeout(() => void loadMailboxes(), 300);
}

const PAGE = 300;
/** A reload keeps what was already scrolled into view. */
function listLimit(keep: boolean): number {
  return keep ? Math.max(PAGE, state.threads.length) : PAGE;
}

function hideParams(route: Route): { hideLabels?: string; hideUnlabeled?: number } {
  if (route.view !== "all") return {};
  const labels = state.hiddenLabels.filter((l) => l !== NO_LABEL);
  return { hideLabels: labels.join("\n") || undefined, hideUnlabeled: state.hiddenLabels.includes(NO_LABEL) ? 1 : undefined };
}

/** Check or uncheck labels in All Mail (remembered). */
export function setHiddenLabels(hiddenLabels: string[]): void {
  try {
    localStorage.setItem(HIDDEN_LABELS_KEY, JSON.stringify(hiddenLabels));
  } catch {
    /* private mode */
  }
  setState({ hiddenLabels, selected: [] });
  void loadList(false);
}

/** Next page of the current list. */
let moreLoading = false;
export async function loadMoreList(): Promise<void> {
  const { route, filter, threads, total } = state;
  if (moreLoading || route.view === "search" || threads.length >= total) return;
  moreLoading = true;
  const seq = listSeq;
  try {
    const view = route.view === "inbox" ? (route.splitId ? "split" : "inbox") : route.view;
    const r = await api.get<{ threads: ThreadSummary[]; total: number }>("/api/threads", {
      account: route.account,
      view,
      split: route.view === "inbox" ? route.splitId : undefined,
      label: route.view === "label" ? route.labelId : undefined,
      filter,
      limit: PAGE,
      offset: threads.length,
      ...hideParams(route),
    });
    if (seq !== listSeq) return;
    const known = new Set(state.threads.map(keyOf));
    setState((s) => ({ threads: [...s.threads, ...r.threads.filter((t) => !known.has(keyOf(t)))], total: r.total }));
  } catch (e) {
    errorToast(e);
  } finally {
    moreLoading = false;
  }
}

let listSeq = 0;
export async function loadList(keepCursor = true): Promise<void> {
  const seq = ++listSeq;
  const { route, filter } = state;
  const account = route.account;
  const prev = state.threads[state.cursor];
  const prevKey = prev ? keyOf(prev) : null;
  try {
    let threads: ThreadSummary[];
    let total: number;
    if (route.view === "search") {
      threads = await api.get<ThreadSummary[]>("/api/search", { account, q: route.q, limit: 100 });
      if (filter === "unread") threads = threads.filter((t) => t.unread);
      if (filter === "starred") threads = threads.filter((t) => t.starred);
      total = threads.length;
    } else {
      const view = route.view === "inbox" ? (route.splitId ? "split" : "inbox") : route.view;
      const r = await api.get<{ threads: ThreadSummary[]; total: number }>("/api/threads", {
        account,
        view,
        split: route.view === "inbox" ? route.splitId : undefined,
        label: route.view === "label" ? route.labelId : undefined,
        filter,
        limit: listLimit(keepCursor),
        ...hideParams(route),
      });
      threads = r.threads;
      total = r.total;
      if (route.view === "all") {
        void api.get<MailboxLabels>("/api/mailbox/labels", { account }).then((mailboxLabels) => setState({ mailboxLabels }), () => undefined);
        void api.get<MailboxCoverage[]>("/api/mailbox/coverage", { account }).then((mailboxCoverage) => setState({ mailboxCoverage }), () => undefined);
      }
    }
    if (seq !== listSeq) return;
    threads = filterRemoved(threads);
    let cursor = 0;
    if (keepCursor && prevKey) {
      const i = threads.findIndex((t) => keyOf(t) === prevKey);
      cursor = i >= 0 ? i : Math.min(state.cursor, Math.max(0, threads.length - 1));
    }
    const keys = new Set(threads.map(keyOf));
    const selected = state.selected.filter((k) => keys.has(k));
    setState({ threads, total, loading: false, cursor, selected });
  } catch (e) {
    if (seq === listSeq) {
      setState({ loading: false });
      errorToast(e);
    }
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReload(threadIds?: string[], accountId?: string) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    void loadList();
    void loadSplits().catch(() => undefined);
  }, 150);
  const open = state.openId;
  if (open && (!accountId || accountId === state.openAccount) && (!threadIds || threadIds.includes(open))) void reloadThread();
}

export async function reloadThread(): Promise<void> {
  const id = state.openId;
  const account = state.openAccount ?? undefined;
  if (!id) return;
  try {
    const t = await api.get<Thread>(`/api/threads/${id}`, { account });
    if (state.openId === id && (state.openAccount ?? undefined) === account) setState({ thread: t });
  } catch {
    /* thread may be gone */
  }
}

export function handleEvent(e: IrisEvent): void {
  switch (e.type) {
    case "threads-changed":
    case "thread-updated":
    case "reminder": {
      const scope = state.route.account;
      if (!e.accountId || scope === ALL || e.accountId === scope) scheduleReload(e.threadIds, e.accountId);
      scheduleMailboxes();
      break;
    }
    case "sync":
      void refreshStatus().catch(() => undefined);
      scheduleMailboxes();
      break;
    case "account":
      void boot();
      break;
    case "outbox": {
      const d = e.data as { id: string; status: string; error?: string; threadId?: string };
      if (d.status === "sent") {
        setState((s) => ({ toasts: s.toasts.filter((t) => t.outboxId !== d.id) }));
        toast({ text: "Message sent.", kind: "success" }, 3000);
      } else if (d.status === "failed") {
        setState((s) => ({ toasts: s.toasts.filter((t) => t.outboxId !== d.id) }));
        toast({ text: `Send failed: ${d.error}`, kind: "error" }, 0);
      }
      scheduleReload();
      scheduleMailboxes();
      break;
    }
    case "calendar-changed":
      emit("calendarChanged", e.accountId);
      break;
    case "goals-changed":
      void loadGoals();
      break;
    case "research-changed":
      onResearchChanged(e.data as { id: string; status: string });
      break;
    case "notification": {
      const d = e.data as { title: string; body: string; kind: string; conferenceUrl?: string };
      if (d.kind === "error") return;
      if (d.kind === "meeting") return meetingNotification(d);
      if (d.kind === "meeting-research") return meetingResearchPrompt(e);
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification(d.title, { body: d.body, icon: "/icon.svg", silent: d.kind !== "reminder" });
        n.onclick = () => {
          window.focus();
          if (e.threadIds?.[0]) void openThread(e.threadIds[0], e.accountId);
        };
      } else if (d.kind === "reminder") {
        toast({ text: `${d.title}: ${d.body}`, icon: "alarm" }, 6000);
      }
      break;
    }
    case "error": {
      const d = e.data as { where: string; message: string };
      if (d.where === "login") toast({ text: `Login failed: ${d.message}`, kind: "error" }, 0);
      else if (d.where === "sync" && /invalid_grant|authExpired|401/.test(d.message)) {
        const who = e.accountId ? `${accountEmail(state, e.accountId)}: ` : "";
        toast({ text: `${who}Gmail session expired. Reconnect the account in Settings.`, kind: "error" }, 0);
      }
      break;
    }
  }
}

/** Calendar notifier: desktop notification (click = join) plus an in-app toast with a Join button. */
function meetingNotification(d: { title: string; body: string; conferenceUrl?: string }) {
  const join = d.conferenceUrl ? () => void window.open(d.conferenceUrl, "_blank", "noopener,noreferrer") : undefined;
  if ("Notification" in window && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
    const n = new Notification(d.title, { body: join ? `${d.body}\nClick to join` : d.body, icon: "/icon.svg", requireInteraction: !!join });
    n.onclick = () => {
      window.focus();
      join?.();
      n.close();
    };
  }
  toast({ text: `${d.title} · ${d.body}`, icon: "calendar", action: join ? { label: "Join", run: join } : undefined }, 120_000);
}

// ------------------------------------------------------------ navigation

/** Leaving the week page (any navigation) returns the right pane to what it was. */
function weekClosed(): Partial<AppState> {
  return state.calPane === "week" ? { calPane: state.calPrevPane, calAvail: null, calPopover: null } : {};
}

export function openGoals(opts: { create?: boolean } = {}): void {
  setState({ goalsOpen: true, goalsForm: !!opts.create, overlay: null, navPeek: false, searchOpen: false, ...weekClosed() });
}

export function closeGoals(): void {
  setState({ goalsOpen: false, goalsForm: false });
}

/** Link refs to a goal; a single thread that is already linked gets unlinked. */
export async function toggleGoalLink(goal: Goal, refs: Ref[]): Promise<void> {
  const linked = (r: Ref) => goal.threads.some((t) => t.accountId === r.account && t.threadId === r.threadId);
  const unlink = refs.length === 1 && linked(refs[0]);
  try {
    await Promise.all(
      refs.map((r) => (unlink ? api.del(`/api/goals/${goal.id}/threads/${encodeURIComponent(r.threadId)}`, { account: r.account }) : api.post(`/api/goals/${goal.id}/threads`, { account: r.account, threadId: r.threadId }))),
    );
    await loadGoals();
    toast({ text: unlink ? `Unlinked from ${goal.title}` : `Linked to ${goal.title}`, icon: "target" });
  } catch (e) {
    errorToast(e);
  }
}

export function navigate(input: RouteInput, opts: { splits?: SplitWithCount[] } = {}): void {
  const route = { ...input, account: input.account ?? state.route.account } as Route;
  const rescoped = route.account !== state.route.account;
  setState({
    route,
    cursor: 0,
    selected: [],
    openId: null,
    openAccount: null,
    thread: null,
    loading: true,
    navPeek: false,
    searchOpen: false,
    threads: [],
    overlay: null,
    goalsOpen: false,
    goalsForm: false,
    ...(opts.splits ? { splits: opts.splits } : rescoped ? { splits: splitCache.get(route.account) ?? [] } : {}),
    ...weekClosed(),
  });
  if (opts.splits) splitCache.set(route.account, opts.splits);
  else if (rescoped) void loadSplits();
  void loadList(false);
}

/** Inbox of an account (or `ALL`): its Important split by default. Per-account split ids are looked up first. */
export async function goInbox(account: string, which: "important" | "other" = "important"): Promise<void> {
  if (account === ALL && !state.unified) account = defaultAccount() ?? account;
  if (account === ALL) {
    const id = state.route.account === ALL ? (state.splits.find((x) => x.builtin === which)?.id ?? `builtin:${which}`) : `builtin:${which}`;
    return navigate({ view: "inbox", account, splitId: id });
  }
  const splits = account === state.route.account && state.splits.length ? state.splits : await api.get<SplitWithCount[]>("/api/splits", { account }).catch(() => [] as SplitWithCount[]);
  const split = splits.find((x) => x.builtin === which) ?? splits.find(splitOn);
  navigate({ view: "inbox", account, splitId: split?.id }, { splits });
}

export function setFilter(f: Filter): void {
  setState((s) => ({ filter: s.filter === f ? null : f, cursor: 0 }));
  void loadList(false);
}

export function cycleSplit(dir: 1 | -1): void {
  const splits = state.splits.filter(splitOn);
  if (!splits.length) return;
  const cur = state.route.view === "inbox" ? splits.findIndex((s) => s.id === (state.route as { splitId?: string }).splitId) : -1;
  const next = splits[(cur + dir + splits.length) % splits.length];
  navigate({ view: "inbox", splitId: next.id });
}

export function moveCursor(delta: number): void {
  if (state.openId) {
    // in thread view j/k move between conversations
    const i = state.threads.findIndex((t) => t.id === state.openId && t.accountId === state.openAccount);
    const next = state.threads[i + delta];
    if (next) {
      setState({ cursor: i + delta });
      void openThread(next.id, next.accountId);
    }
    return;
  }
  setState((s) => ({ cursor: Math.max(0, Math.min(s.threads.length - 1, s.cursor + delta)) }));
}

/** `account`: the thread's account; without it the list row (or the route's scope) decides. */
export async function openThread(id: string, account?: string): Promise<void> {
  const i = state.threads.findIndex((t) => t.id === id && (!account || t.accountId === account));
  const acc = account ?? state.threads[i]?.accountId ?? defaultAccount();
  setState({
    openId: id,
    openAccount: acc ?? null,
    thread: null,
    cursor: i >= 0 ? i : state.cursor,
    compose: state.compose?.popped ? state.compose : null,
    askOpen: false,
    navPeek: false,
    goalsOpen: false,
    goalsForm: false,
    ...(state.calAvail ? {} : weekClosed()),
  });
  try {
    const t = await api.get<Thread>(`/api/threads/${id}`, { account: acc });
    if (state.openId !== id || (state.openAccount ?? undefined) !== acc) return;
    setState({ thread: t });
    if (t.unread) {
      setState((s) => ({ threads: s.threads.map((x) => (x.id === id && x.accountId === t.accountId ? { ...x, unread: false } : x)) }));
      void api.post("/api/actions/read", { account: t.accountId ?? acc, threadIds: [id] }).catch(errorToast);
    }
  } catch (e) {
    errorToast(e);
    setState({ openId: null, openAccount: null });
  }
}

export function closeThread(): void {
  setState({ openId: null, openAccount: null, thread: null, compose: state.compose?.popped ? state.compose : null });
}

// ------------------------------------------------------------ actions

export type ActionName =
  | "done"
  | "undone"
  | "star"
  | "unstar"
  | "toggleStar"
  | "read"
  | "unread"
  | "toggleRead"
  | "important"
  | "unimportant"
  | "spam"
  | "notSpam"
  | "trash"
  | "untrash"
  | "mute"
  | "unmute"
  | "addLabel"
  | "removeLabel"
  | "removeAllLabels"
  | "move"
  | "cancelReminder";

function removes(action: ActionName, r: Route, label?: string): boolean {
  const inboxLike = r.view === "inbox";
  switch (action) {
    case "done":
    case "mute":
    case "move":
      return inboxLike || (r.view === "label" && action === "move" && r.name !== label);
    case "undone":
      return r.view === "done";
    case "trash":
      return r.view !== "trash";
    case "untrash":
      return r.view === "trash";
    case "spam":
      return r.view !== "spam";
    case "notSpam":
      return r.view === "spam";
    case "unstar":
      return r.view === "starred";
    case "cancelReminder":
      return r.view === "reminders";
    case "removeLabel":
      return r.view === "label" && r.name === label;
    case "removeAllLabels":
      return r.view === "label";
    default:
      return false;
  }
}

/** Threads an action applies to: selection, else the open thread, else the cursor row. */
export function targetRefs(s: AppState = state): Ref[] {
  if (s.selected.length) return s.selected.map(parseKey);
  if (s.openId) return [{ account: s.openAccount ?? defaultAccount(s) ?? "", threadId: s.openId }];
  const t = s.threads[s.cursor];
  return t ? [refOf(t)] : [];
}

/** Body for account-bound bulk endpoints: today's `{account, threadIds}` for one account, `{refs}` across accounts. */
export function refsBody(refs: Ref[]): { account?: string; threadIds?: string[]; refs?: Ref[] } {
  const accounts = new Set(refs.map((r) => r.account));
  if (accounts.size <= 1) return { account: refs[0]?.account || undefined, threadIds: refs.map((r) => r.threadId) };
  return { refs: refs.map((r) => ({ account: r.account, threadId: r.threadId })) };
}

function afterRemoval(refs: Ref[]) {
  const keys = new Set(refs.map((r) => refKey(r.account, r.threadId)));
  const openKey = state.openId ? refKey(state.openAccount ?? "", state.openId) : null;
  const openWasRemoved = !!openKey && keys.has(openKey);
  const idx = openKey ? state.threads.findIndex((t) => keyOf(t) === openKey) : state.cursor;
  const remaining = state.threads.filter((t) => !keys.has(keyOf(t)));
  const cursor = Math.max(0, Math.min(idx, remaining.length - 1));
  setState({ threads: remaining, total: Math.max(0, state.total - refs.length), cursor, selected: [] });
  if (openWasRemoved) {
    const adv = state.status?.settings.autoAdvance ?? "next";
    const next = adv === "list" ? undefined : adv === "previous" ? remaining[Math.max(0, idx - 1)] : remaining[cursor];
    if (next && remaining.length) void openThread(next.id, next.accountId);
    else closeThread();
  }
}

/** The server already marked these threads done (RSVP + Mark Done): update the list without another API call. */
export function markDoneLocally(refs: Ref[]): void {
  if (!removes("done", state.route)) return;
  markRemoved(refs);
  afterRemoval(refs);
}

export async function act(action: ActionName, opts: { refs?: Ref[]; label?: string; quiet?: boolean } = {}): Promise<void> {
  const refs = opts.refs ?? targetRefs();
  if (!refs.length) return;
  const keys = new Set(refs.map((r) => refKey(r.account, r.threadId)));
  const r = state.route;
  // optimistic local update
  if (removes(action, r, opts.label)) {
    markRemoved(refs);
    afterRemoval(refs);
  } else {
    setState((s) => ({
      threads: s.threads.map((t) => {
        if (!keys.has(keyOf(t))) return t;
        switch (action) {
          case "star":
            return { ...t, starred: true };
          case "unstar":
            return { ...t, starred: false };
          case "toggleStar":
            return { ...t, starred: !t.starred };
          case "read":
            return { ...t, unread: false };
          case "unread":
            return { ...t, unread: true };
          case "toggleRead":
            return { ...t, unread: !t.unread };
          default:
            return t;
        }
      }),
      selected: action === "toggleRead" || action === "toggleStar" ? s.selected : [],
    }));
    if (action === "unread" && state.openId && keys.has(refKey(state.openAccount ?? "", state.openId))) closeThread();
  }
  try {
    const res = await api.post<{ undoId?: string; description?: string; count?: number }>(`/api/actions/${action}`, { ...refsBody(refs), label: opts.label });
    if (!opts.quiet && res?.undoId) toast({ text: res.description ?? "Done", undoId: res.undoId }, 5000);
    scheduleMailboxes();
  } catch (e) {
    recentlyRemoved.clear();
    errorToast(e);
    void loadList();
  }
}

export async function undo(undoId?: string): Promise<void> {
  // undo send has priority while a send is pending
  const live = state.toasts.filter((t) => !t.leaving);
  const sending = [...live].reverse().find((t) => t.outboxId);
  if (!undoId && sending) return cancelSend(sending.outboxId!, sending.id);
  const last = [...live].reverse().find((t) => t.localUndo || t.undoId);
  if (!undoId && last?.localUndo) {
    dismissToast(last.id);
    try {
      await last.localUndo();
    } catch (e) {
      errorToast(e);
    }
    return;
  }
  // `z` undoes what the newest visible toast offers, not the daemon's newest entry (opening the next thread after
  // Done marks it read, which is undoable too); with no undo toast left it falls back to the daemon's last entry
  const id = undoId ?? last?.undoId;
  try {
    const r = await api.post<{ ok: boolean; description?: string }>("/api/undo", { undoId: id });
    recentlyRemoved.clear();
    setState((s) => ({ toasts: s.toasts.filter((t) => !t.undoId || (id && t.undoId !== id)) }));
    toast({ text: r.ok ? (r.description ?? "Undone") : "Nothing to undo" }, 2500);
    await loadList();
    scheduleMailboxes();
  } catch (e) {
    errorToast(e);
  }
}

export async function remind(refs: Ref[], when: string | number, ifNoReply: boolean): Promise<void> {
  if (removes("done", state.route)) {
    markRemoved(refs);
    afterRemoval(refs);
  }
  setState({ overlay: null });
  try {
    const r = await api.post<{ undoId: string; when: string }>("/api/remind", { ...refsBody(refs), when, ifNoReply });
    toast({ text: `Reminder set for ${r.when}${ifNoReply ? " if no reply" : ""}`, undoId: r.undoId }, 5000);
    scheduleMailboxes();
  } catch (e) {
    recentlyRemoved.clear();
    errorToast(e);
    void loadList();
  }
}

/** In All Inboxes: every account, one toast whose undo restores all of them. */
export async function getMeToZero(before: number): Promise<void> {
  setState({ overlay: null });
  const scope = state.route.account;
  const accounts = scope === ALL ? (state.status?.accounts.map((a) => a.id) ?? []) : [scope];
  try {
    const rs = await Promise.all(accounts.map((account) => api.post<{ count: number; undoId: string }>("/api/get-me-to-zero", { account, before })));
    const count = rs.reduce((n, r) => n + (r.count ?? 0), 0);
    const undoIds = rs.map((r) => r.undoId).filter(Boolean);
    const undoAll = async () => {
      for (const undoId of undoIds) await api.post("/api/undo", { undoId });
      toast({ text: "Undone" }, 2500);
      await loadList();
      scheduleMailboxes();
    };
    toast(undoIds.length === 1 ? { text: `Marked ${count} conversations done`, kind: "success", undoId: undoIds[0] } : { text: `Marked ${count} conversations done`, kind: "success", localUndo: undoAll }, 8000);
    await loadList(false);
    scheduleMailboxes();
  } catch (e) {
    errorToast(e);
  }
}

// ------------------------------------------------------------ selection

export function toggleSelect(t?: ThreadSummary): void {
  const row = t ?? state.threads[state.cursor];
  if (!row) return;
  const k = keyOf(row);
  setState((s) => ({ selected: s.selected.includes(k) ? s.selected.filter((x) => x !== k) : [...s.selected, k] }));
}

export function selectAll(fromCursor: boolean): void {
  const list = fromCursor ? state.threads.slice(state.cursor) : state.threads;
  setState({ selected: list.map(keyOf) });
}

// ------------------------------------------------------------ sidebar

export function toggleNavPinned(): void {
  setState((s) => ({ navPinned: !s.navPinned, navPeek: false }));
}

// ------------------------------------------------------------ compose

let composeSeq = 0;
const editors = new Map<string, () => string>();
export function registerEditor(key: string, getHtml: () => string): () => void {
  editors.set(key, getHtml);
  return () => editors.delete(key);
}
export function composeHtml(c: ComposeState): string {
  return editors.get(c.key)?.() ?? c.html;
}

/** Mounted composers register "insert HTML at the caret" (share availability). */
const inserters = new Map<string, (html: string) => void>();
export function registerInserter(key: string, fn: (html: string) => void): () => void {
  inserters.set(key, fn);
  return () => inserters.delete(key);
}
/** Insert at the composer's last caret position; falls back to prepending to the draft HTML. */
export function insertIntoCompose(html: string): boolean {
  const c = state.compose;
  if (!c) return false;
  const fn = inserters.get(c.key);
  if (fn) fn(html);
  else setState({ compose: { ...c, html: `<div>${html}</div>${composeHtml(c)}` } });
  return true;
}

/** New mail is sent from the route's account (the primary one in All Inboxes) unless `prefill.accountId` says otherwise. */
export function startCompose(prefill: Partial<ComposeState> = {}): void {
  setState({
    compose: {
      key: `c${++composeSeq}`,
      mode: "new",
      accountId: defaultAccount() ?? "",
      to: [],
      cc: [],
      bcc: [],
      showCc: false,
      showBcc: false,
      subject: "",
      html: "",
      attachments: [],
      popped: true,
      ...prefill,
    },
    overlay: null,
  });
}

/** Reply / forward from the thread's own account. */
export async function startReply(kind: "reply" | "replyAll" | "forward", popped = false): Promise<void> {
  const t = state.thread;
  if (!t) return;
  const account = t.accountId ?? state.openAccount ?? defaultAccount() ?? "";
  // reuse an existing draft in this thread
  const draftMsg = [...t.messages].reverse().find((m) => m.isDraft);
  try {
    const d = await api.post<{ to: Address[]; cc?: Address[]; subject: string; html?: string; threadId: string; inReplyToMessageId?: string }>("/api/compose", {
      account,
      threadId: t.id,
      kind,
    });
    setState({
      compose: {
        key: `c${++composeSeq}`,
        mode: kind,
        accountId: account,
        threadAccount: account,
        threadId: t.id,
        inReplyToMessageId: d.inReplyToMessageId,
        to: d.to ?? [],
        cc: d.cc ?? [],
        bcc: [],
        showCc: !!d.cc?.length,
        showBcc: false,
        subject: d.subject,
        html: draftMsg && kind !== "forward" ? stripQuote(draftMsg.bodyHtml) : (d.html ?? ""),
        attachments: [],
        popped,
        draftId: undefined,
      },
      overlay: null,
    });
  } catch (e) {
    errorToast(e);
  }
}

function stripQuote(html: string): string {
  return html.replace(/<div[^>]*data-iris-signature[\s\S]*$/i, "").replace(/<div class="gmail_quote"[\s\S]*$/i, "");
}

export function closeCompose(): void {
  setState({ compose: null });
}

/** Thread context only travels with the account it belongs to: another From starts a new conversation. */
export function composeKeepsThread(c: ComposeState): boolean {
  return !c.threadAccount || c.threadAccount === c.accountId;
}

/** Composer "From": switch the sending account. A draft saved under the old account is removed there. */
export function setComposeFrom(accountId: string): void {
  const c = state.compose;
  if (!c || c.accountId === accountId) return;
  if (c.draftId) void api.del(`/api/drafts/${c.draftId}`, { account: c.accountId, threadId: composeKeepsThread(c) ? c.threadId : undefined }).catch(() => undefined);
  // a new message's draft thread belonged to the old account: forget it
  const fresh = c.mode === "new" && c.threadAccount === c.accountId ? { threadId: undefined, threadAccount: undefined } : {};
  setState({ compose: { ...c, accountId, draftId: undefined, html: composeHtml(c), ...fresh } });
}

function draftPayload(c: ComposeState) {
  const keep = composeKeepsThread(c);
  return {
    accountId: c.accountId || undefined,
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject,
    html: composeHtml(c),
    threadId: keep ? c.threadId : undefined,
    inReplyToMessageId: keep ? c.inReplyToMessageId : undefined,
    attachments: c.attachments.map(({ filename, contentType, contentBase64 }) => ({ filename, contentType, contentBase64 })),
    draftId: c.draftId,
  };
}

export async function saveDraft(c: ComposeState): Promise<void> {
  const html = composeHtml(c);
  if (!c.to.length && !c.subject && !html.replace(/<[^>]+>/g, "").trim()) return;
  try {
    const d = await api.post<{ draftId: string; threadId: string }>("/api/drafts", draftPayload(c));
    setState((s) => {
      const cur = s.compose;
      if (cur?.key !== c.key || cur.accountId !== c.accountId) return {};
      const keep = composeKeepsThread(cur);
      return { compose: { ...cur, draftId: d.draftId, ...(keep ? { threadId: cur.threadId ?? d.threadId, threadAccount: cur.threadAccount ?? cur.accountId } : {}) } };
    });
  } catch {
    /* autosave is best effort */
  }
}

export async function discardCompose(): Promise<void> {
  const c = state.compose;
  if (!c) return;
  setState({ compose: null });
  if (c.draftId) await api.del(`/api/drafts/${c.draftId}`, { account: c.accountId, threadId: composeKeepsThread(c) ? c.threadId : undefined }).catch(() => undefined);
  toast({ text: "Draft discarded" }, 2500);
}

export async function sendCompose(opts: { markDone?: boolean; sendAt?: number; instant?: boolean } = {}): Promise<void> {
  const c = state.compose;
  if (!c) return;
  const draft = draftPayload(c);
  try {
    const v = await api.post<{ errors: string[]; warnings: string[] }>("/api/validate", draft);
    if (v.errors.length) return void toast({ text: v.errors.join("; "), kind: "error" });
    if (v.warnings.some((w) => /attachment/i.test(w)) && !confirm(`${v.warnings.join("\n")}\n\nSend anyway?`)) return;
    const item = await api.post<{ id: string; sendAt: number; status: string }>("/api/send", { draft, sendAt: opts.sendAt, markDone: opts.markDone, instant: opts.instant });
    setState({ compose: null, overlay: null });
    if (opts.markDone && c.threadId && composeKeepsThread(c) && state.openId === c.threadId) {
      const ref = { account: c.threadAccount ?? c.accountId, threadId: c.threadId };
      markRemoved([ref]);
      if (removes("done", state.route)) afterRemoval([ref]);
    }
    if (opts.sendAt) {
      toast({ text: `Scheduled for ${new Date(item.sendAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`, outboxId: item.id }, 6000);
    } else if (!opts.instant && item.sendAt > Date.now()) {
      toast({ text: "Sending…", kind: "send", outboxId: item.id, sendAt: item.sendAt }, Math.max(1000, item.sendAt - Date.now() + 1500));
    }
  } catch (e) {
    errorToast(e);
  }
}

export async function cancelSend(outboxId: string, toastId?: string): Promise<void> {
  try {
    const item = await api.post<{ status: string; accountId?: string; draft: ComposeState & { to: Address[] } } | null>(`/api/outbox/${outboxId}/cancel`);
    if (toastId) dismissToast(toastId);
    if (item?.status === "cancelled") {
      // reopen the composer with the message (undo send)
      const d = item.draft as unknown as { accountId?: string; to: Address[] | string; cc?: Address[] | string; bcc?: Address[] | string; subject: string; html?: string; threadId?: string; inReplyToMessageId?: string; draftId?: string };
      const arr = (v: Address[] | string | undefined): Address[] => (Array.isArray(v) ? v : v ? v.split(",").map((e) => ({ name: "", email: e.trim() })) : []);
      const account = item.accountId ?? d.accountId ?? defaultAccount() ?? "";
      startCompose({
        mode: d.threadId ? "reply" : "new",
        accountId: account,
        threadAccount: d.threadId ? account : undefined,
        to: arr(d.to),
        cc: arr(d.cc),
        bcc: arr(d.bcc),
        showCc: !!arr(d.cc).length,
        showBcc: !!arr(d.bcc).length,
        subject: d.subject,
        html: d.html ?? "",
        threadId: d.threadId,
        inReplyToMessageId: d.inReplyToMessageId,
        draftId: d.draftId,
        popped: !d.threadId || state.openId !== d.threadId,
      });
      toast({ text: "Send undone" }, 2500);
    } else toast({ text: "Too late: already sent", kind: "error" }, 3000);
  } catch (e) {
    errorToast(e);
  }
}
