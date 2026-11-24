// Calendar actions: loading, day pane / week page, create / edit / delete, RSVP, invites, share availability.
import type { Address, Calendar, CalendarEvent, CalendarInvite, ResponseStatus, Thread, TimeRange } from "@iris/core/types.ts";
import { api, ApiError, TOKEN } from "./api";
import { on } from "./bus";
import {
  addDays,
  atTime,
  fmtRange,
  guests,
  hueOf,
  inviteView,
  isAllDayish,
  localTimeZone,
  MIN,
  renderAvailabilityText,
  snap,
  startOfDay,
  startOfWeek,
  type EventFormInit,
  type GridItem,
  type InviteView,
  type Rect,
} from "./calutil";
import { ALL, defaultAccount, errorToast, getState, insertIntoCompose, markDoneLocally, reloadThread, setState, startCompose, startReply, toast, type AppState } from "./state";

/**
 * Calendar scope: every account when the daemon speaks the unified contract (day pane + week show all accounts),
 * else the route's account. Reads use this; writes always use the event's / calendar's own `accountId`.
 */
export function calScope(s: AppState = getState()): string | undefined {
  return s.unified ? ALL : defaultAccount(s);
}
/** Account for calendar work that has no event yet (availability, new events): the route's, else the primary one. */
const acct = () => defaultAccount(getState());
export const evPath = (e: { calendarId: string; id: string }) => `/api/events/${encodeURIComponent(e.calendarId)}/${encodeURIComponent(e.id)}`;
/** Calendar and event ids are only unique per account (two accounts can share a holiday calendar or be invited to one event). */
export const evKey = (e: { accountId?: string; calendarId: string; id: string }) => `${e.accountId ?? ""}/${e.calendarId}/${e.id}`;
export const calKey = (c: { accountId?: string; id: string }) => `${c.accountId ?? ""}/${c.id}`;
export function calendarOf(calendars: Calendar[], e: { accountId?: string; calendarId: string }): Calendar | undefined {
  return calendars.find((c) => c.id === e.calendarId && (!e.accountId || !c.accountId || c.accountId === e.accountId));
}
const today = () => startOfDay(Date.now());

/** My addresses: one account's (`account`), else every connected account's. */
export function selfEmails(s: AppState = getState(), account?: string): string[] {
  const list = account ? (s.status?.accounts.filter((a) => a.id === account) ?? []) : (s.status?.accounts ?? []);
  const out = new Set<string>(account ? [account.toLowerCase()] : []);
  for (const a of list) {
    out.add(a.id.toLowerCase());
    out.add(a.email.toLowerCase());
  }
  return [...out];
}

export function writableCalendars(s: AppState = getState()): Calendar[] {
  return s.calendars.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
}
/** New events land in the primary calendar of `account` (default: the route's account, else the primary account). */
export function defaultCalendar(s: AppState = getState(), account = defaultAccount(s)): Calendar | undefined {
  const w = writableCalendars(s);
  const mine = w.filter((c) => !account || !c.accountId || c.accountId === account);
  return mine.find((c) => c.primary) ?? mine[0] ?? w.find((c) => c.primary) ?? w[0];
}


// ------------------------------------------------------------ loading

export function visibleRange(s: AppState): { from: number; to: number } | null {
  if (s.calPane === "week") {
    const from = startOfWeek(s.calDate, s.calSettings.weekStartsOn);
    return { from, to: addDays(from, 7) };
  }
  if (s.calPane === "day") return { from: s.calDate, to: addDays(s.calDate, 1) };
  return null;
}

let loadSeq = 0;
let lastError = "";

function calFail(e: unknown, quiet = false) {
  const message = e instanceof Error ? e.message : String(e);
  setState({ calError: { message, code: e instanceof ApiError ? e.code : undefined }, calLoading: false });
  // background loads toast an error once; the pane keeps an inline message
  if (!quiet && message !== lastError) errorToast(e);
  lastError = message;
}

/** Load events for the visible range; prefetches −7..+14 days around it and reuses that window. */
export async function ensureEvents(force = false): Promise<void> {
  const s = getState();
  const r = visibleRange(s);
  if (!r) return;
  const cur = s.calRange;
  const scope = calScope(s);
  const covered = !!cur && cur.account === scope && cur.from <= r.from && cur.to >= r.to;
  if (covered && !force) return;
  const win = covered && cur ? cur : { from: addDays(r.from, -7), to: addDays(r.to, 14) };
  const seq = ++loadSeq;
  setState({ calLoading: true });
  try {
    // /api/calendar/events, not /api/events: without a query that path is the SSE stream
    const events = await api.get<CalendarEvent[]>("/api/calendar/events", { account: scope, from: win.from, to: win.to });
    if (seq !== loadSeq) return;
    lastError = "";
    setState({ calEvents: Array.isArray(events) ? events : [], calRange: { from: win.from, to: win.to, account: scope }, calLoading: false, calError: null });
  } catch (e) {
    if (seq === loadSeq) calFail(e);
  }
}

export async function loadCalendars(): Promise<void> {
  try {
    const calendars = await api.get<Calendar[]>("/api/calendars", { account: calScope() });
    setState({ calendars: Array.isArray(calendars) ? calendars : [] });
  } catch (e) {
    calFail(e, true);
  }
}

export function retryCalendar(): void {
  lastError = "";
  setState({ calError: null, calRange: null });
  void loadCalendars();
  void ensureEvents(true);
}

let changedTimer: ReturnType<typeof setTimeout> | null = null;
on("calendarChanged", (accountId) => {
  const scope = calScope();
  if (accountId && scope !== ALL && accountId !== scope) return;
  if (changedTimer) clearTimeout(changedTimer);
  changedTimer = setTimeout(() => {
    const s = getState();
    if (visibleRange(s)) void ensureEvents(true);
    else if (s.calRange) setState({ calRange: null }); // stale: reload when a pane opens
    if (s.calPane === "week") void loadCalendars();
  }, 150);
});

function upsertLocal(e: CalendarEvent) {
  setState((s) => {
    const i = s.calEvents.findIndex((x) => evKey(x) === evKey(e));
    const calEvents = i >= 0 ? s.calEvents.map((x, j) => (j === i ? e : x)) : [...s.calEvents, e].sort((a, b) => a.start - b.start);
    return { calEvents };
  });
}

// ------------------------------------------------------------ panes

export function showDay(date: number, opts: { focus?: number; auto?: boolean } = {}): void {
  const s = getState();
  const calAuto = opts.auto ? s.calPane === null || s.calAuto : false;
  setState({
    calPane: s.calPane === "week" ? "week" : "day",
    calDate: startOfDay(date),
    calAuto,
    ...(opts.focus !== undefined ? { calFocus: { at: opts.focus, seq: (s.calFocus?.seq ?? 0) + 1 } } : {}),
  });
}

export function shiftDay(n: number): void {
  const s = getState();
  setState({ calDate: addDays(s.calDate, n), calAuto: false, calPane: s.calPane ?? "day" });
}

export function dayToday(): void {
  showDay(today(), { focus: Date.now() });
}

export function openWeek(date = today()): void {
  const s = getState();
  setState({ calPane: "week", calPrevPane: s.calPane === "day" ? "day" : s.calPane === "week" ? s.calPrevPane : null, calDate: startOfDay(date), calAuto: false, calPopover: null, goalsOpen: false, goalsForm: false });
}

export function closeWeek(toPrevious = true): void {
  const s = getState();
  if (s.calPane !== "week") return;
  setState({ calPane: toPrevious ? s.calPrevPane : null, calAvail: null, calPopover: null });
}

export function closeCalendar(): void {
  setState({ calPane: null, calAvail: null, calPopover: null, calAuto: false });
}

/** `0`: contact pane → Day → Week → contact pane. */
export function cycleCalendar(): void {
  const s = getState();
  if (s.calPane === null) showDay(s.calAuto ? s.calDate : today(), { focus: Date.now() });
  else if (s.calPane === "day") {
    setState({ calPane: "week", calPrevPane: null, calAuto: false, calPopover: null });
  } else closeWeek(false);
}

export function shiftWeek(n: number): void {
  setState((s) => ({ calDate: addDays(s.calDate, 7 * n), calPopover: null }));
}

export function weekToday(): void {
  setState({ calDate: today(), calFocus: { at: Date.now(), seq: (getState().calFocus?.seq ?? 0) + 1 } });
}

// ------------------------------------------------------------ invites in threads

/** last RSVP sent per message, so the highlighted button survives until the thread reloads */
const localAnswers = new Map<string, ResponseStatus>();

/** Thread opened/closed: show its invite as a pseudo-event and open the day pane on its date. */
export function syncInvite(thread: Thread | null): void {
  const s = getState();
  if (!thread?.invite) {
    if (s.calInvite || s.calAuto) setState({ calInvite: null, ...(s.calAuto && s.calPane === "day" ? { calPane: null, calAuto: false } : {}) });
    return;
  }
  const inv: InviteView = { ...inviteView(thread.invite as CalendarInvite, thread.id, localAnswers.get(thread.invite.messageId)), accountId: thread.accountId };
  const same = s.calInvite?.messageId === inv.messageId && s.calInvite.threadId === inv.threadId;
  setState({ calInvite: inv });
  if (!same && s.calPane !== "week") showDay(inv.start, { focus: inv.start, auto: true });
}

const ANSWER: Record<string, string> = { accepted: "Yes", tentative: "Maybe", declined: "No" };
type Answer = "accepted" | "tentative" | "declined";

export function rsvpAndDoneOn(s: AppState = getState()): boolean {
  return !!s.status?.settings.calendar?.rsvpAndDone;
}

export async function toggleRsvpAndDone(): Promise<void> {
  const s = getState();
  const cur = s.status?.settings.calendar ?? { notifyLeadSeconds: 120, defaultMeetingLink: null, rsvpAndDone: false };
  const next = { ...cur, rsvpAndDone: !cur.rsvpAndDone };
  try {
    await api.patch("/api/settings", { calendar: next });
    setState((st) => (st.status ? { status: { ...st.status, settings: { ...st.status.settings, calendar: next } } } : {}));
    toast({ text: next.rsvpAndDone ? "RSVP + Mark Done enabled" : "RSVP + Mark Done disabled" }, 2500);
  } catch (e) {
    errorToast(e);
  }
}

/** RSVP from the invite card (POST /api/threads/:id/invite/rsvp imports the event when it is not on the calendar yet). */
export async function rsvpInvite(inv: InviteView, response: Answer, opts: { scope?: "this" | "all"; markDone?: boolean } = {}): Promise<void> {
  if (inv.selfResponse === response) return; // clicking the current answer does nothing
  const markDone = opts.markDone ?? rsvpAndDoneOn();
  const prev = inv.selfResponse;
  localAnswers.set(inv.messageId, response);
  setState((s) => (s.calInvite?.messageId === inv.messageId ? { calInvite: { ...s.calInvite, selfResponse: response } } : {}));
  try {
    const account = inv.accountId ?? acct();
    const r = await api.post<{ event?: CalendarEvent; markedDone?: boolean }>(`/api/threads/${encodeURIComponent(inv.threadId)}/invite/rsvp`, {
      account,
      response,
      messageId: inv.messageId,
      scope: opts.scope,
      markDone,
    });
    if (r?.event) upsertLocal(r.event);
    const done = !!r?.markedDone;
    toast({ text: done ? `Responded ${ANSWER[response]} and Marked Done.` : `Responded ${ANSWER[response]}.` }, 3000);
    if (done && account) markDoneLocally([{ account, threadId: inv.threadId }]);
    else void reloadThread();
    void ensureEvents(true);
  } catch (e) {
    if (prev) localAnswers.set(inv.messageId, prev);
    else localAnswers.delete(inv.messageId);
    setState((s) => (s.calInvite?.messageId === inv.messageId ? { calInvite: { ...s.calInvite, selfResponse: prev } } : {}));
    errorToast(e);
  }
}

/** RSVP from the event popover. */
export async function rsvpEvent(e: CalendarEvent, response: Answer, scope?: "this" | "all"): Promise<void> {
  if (e.selfResponse === response) return;
  const optimistic = { ...e, selfResponse: response as ResponseStatus, attendees: e.attendees.map((a) => (a.self ? { ...a, responseStatus: response as ResponseStatus } : a)) };
  upsertLocal(optimistic);
  setState((s) => (s.calPopover && evKey(s.calPopover.event) === evKey(e) ? { calPopover: { ...s.calPopover, event: optimistic } } : {}));
  try {
    const updated = await api.post<CalendarEvent>(`${evPath(e)}/rsvp`, { account: e.accountId, response, scope, markDone: false });
    if (updated?.id) upsertLocal(updated);
    toast({ text: `Responded ${ANSWER[response]}.` }, 3000);
    void ensureEvents(true);
    const s = getState();
    if (s.calInvite && s.calInvite.iCalUID === e.iCalUID) void reloadThread();
  } catch (err) {
    upsertLocal(e);
    errorToast(err);
  }
}

/** Invite card "Add To Calendar" for invites without a calendar event (no guests, so nobody gets mail). */
export async function addInviteToCalendar(inv: InviteView): Promise<void> {
  try {
    const account = inv.accountId ?? acct();
    const created = await api.post<CalendarEvent>("/api/events", {
      account,
      calendarId: defaultCalendar(getState(), account)?.id,
      summary: inv.summary || "(No title)",
      start: inv.start,
      end: inv.end,
      allDay: inv.allDay,
      location: inv.location,
      description: inv.description,
      conference: false,
    });
    upsertLocal(created);
    toast({ text: "Event added to calendar.", localUndo: () => deleteNow(created, false) }, 5000);
    void reloadThread();
  } catch (e) {
    errorToast(e);
  }
}

// ------------------------------------------------------------ create / edit / delete

let formSeq = 0;

export function openEventForm(init: Omit<EventFormInit, "key">): void {
  const s = getState();
  if (!s.calendars.length) void loadCalendars();
  setState({
    calForm: { ...init, key: `f${++formSeq}` },
    calPopover: null,
    // show the day next to the form so conflicts are visible
    ...(s.calPane === null ? { calPane: "day" as const, calAuto: false } : {}),
  });
}

export function closeEventForm(): void {
  setState({ calForm: null, calDraft: null });
}

function cleanSubject(subject: string): string {
  let t = subject.replace(/^((re|fwd?|aw|wg|antw)\s*:\s*)+/i, "").trim();
  if (/^(updated )?invitation\s*:/i.test(t)) t = t.replace(/^(updated )?invitation\s*:\s*/i, "").replace(/\s+@\s+.*$/, "");
  return t.slice(0, 200);
}

/** Title = subject, guests = senders and visible recipients without self (no-AI fallback). */
export function threadPrefill(thread: Thread | null): { summary?: string; guests?: Address[] } {
  if (!thread) return {};
  const me = selfEmails();
  const seen = new Set<string>();
  const list: Address[] = [];
  for (const m of thread.messages) {
    if (m.isDraft) continue;
    for (const a of [m.from, ...m.to, ...m.cc]) {
      const email = a?.email?.toLowerCase();
      if (!email || seen.has(email) || me.includes(email) || /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon)@/i.test(email)) continue;
      seen.add(email);
      list.push({ name: a.name, email });
    }
  }
  return { summary: cleanSubject(thread.subject || ""), guests: list };
}

/** Active day at the current time, snapped to 15 min, 30 min long (week `b`, "Create" buttons). */
export function createAtNow(): void {
  const s = getState();
  const now = new Date();
  const start = snap(atTime(s.calDate, now.getHours(), now.getMinutes()), 15);
  openEventForm({ mode: "create", start, end: start + 30 * MIN, allDay: false });
}

/** `b`: in the week page create there; in a thread prefill from the thread; else an empty event. */
export function createFromContext(): void {
  const s = getState();
  if (s.calPane === "week") return createAtNow();
  if (s.openId && s.thread) return openEventForm({ mode: "create", ...threadPrefill(s.thread) });
  createEmpty();
}

/** `shift+b`: empty event (on the shown day when a calendar pane is open). */
export function createEmpty(): void {
  if (getState().calPane) return createAtNow();
  openEventForm({ mode: "create" });
}

export function createAt(start: number, end: number): void {
  openEventForm({ mode: "create", start, end, allDay: false });
}

export function editEvent(e: CalendarEvent): void {
  openEventForm({
    mode: "edit",
    event: e,
    summary: e.summary,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    guests: guests(e).map((a) => ({ name: a.name, email: a.email })),
    location: e.location,
    description: e.description,
    conference: !!e.conferenceUrl,
    calendarId: e.calendarId,
  });
}

export interface EventFields {
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  attendees: string[];
  location: string;
  description: string;
  conference: boolean;
  calendarId?: string;
  /** account of `calendarId` (new events) */
  accountId?: string;
}

function focusOn(start: number) {
  const s = getState();
  if (s.calPane === "day" || s.calPane === "week") setState({ calDate: startOfDay(start), calFocus: { at: start, seq: (s.calFocus?.seq ?? 0) + 1 } });
}

export async function saveEvent(init: EventFormInit, f: EventFields, opts: { notify?: boolean; scope?: "this" | "all" } = {}): Promise<boolean> {
  // edits go to the event's own account; new events to the chosen calendar's account
  const target = f.calendarId ? writableCalendars().find((c) => c.id === f.calendarId && (!f.accountId || c.accountId === f.accountId)) : defaultCalendar();
  const account = init.mode === "edit" && init.event ? init.event.accountId : (f.accountId ?? target?.accountId ?? acct());
  try {
    if (init.mode === "edit" && init.event) {
      const prev = init.event;
      const prevGuests = guests(prev).map((a) => a.email.toLowerCase());
      const changed: Record<string, unknown> = {};
      const undo: Record<string, unknown> = {};
      const put = (k: string, now: unknown, before: unknown) => {
        if (JSON.stringify(now) !== JSON.stringify(before)) {
          changed[k] = now;
          undo[k] = before;
        }
      };
      put("summary", f.summary, prev.summary);
      if (f.start !== prev.start || f.end !== prev.end || f.allDay !== prev.allDay) {
        Object.assign(changed, { start: f.start, end: f.end, allDay: f.allDay });
        Object.assign(undo, { start: prev.start, end: prev.end, allDay: prev.allDay });
      }
      put("location", f.location, prev.location);
      put("description", f.description, prev.description);
      const sortedNow = [...f.attendees].map((x) => x.toLowerCase()).sort();
      if (JSON.stringify(sortedNow) !== JSON.stringify([...prevGuests].sort())) {
        changed.attendees = f.attendees;
        undo.attendees = prevGuests;
      }
      if (f.conference && !prev.conferenceUrl) changed.conference = true;
      if (!Object.keys(changed).length) {
        closeEventForm();
        return true;
      }
      const updated = await api.patch<CalendarEvent>(evPath(prev), { account, ...changed, notify: opts.notify, scope: opts.scope });
      if (updated?.id) upsertLocal(updated);
      closeEventForm();
      focusOn(f.start);
      toast(
        {
          text: "Event updated.",
          localUndo: async () => {
            if (!Object.keys(undo).length) return;
            await api.patch(evPath(updated?.id ? updated : prev), { account, ...undo, notify: opts.notify, scope: opts.scope });
            toast({ text: "Undone" }, 2000);
            void ensureEvents(true);
          },
        },
        6000,
      );
    } else {
      const created = await api.post<CalendarEvent>("/api/events", {
        account,
        calendarId: f.calendarId ?? target?.id,
        summary: f.summary,
        start: f.start,
        end: f.end,
        allDay: f.allDay,
        attendees: f.attendees,
        location: f.location || undefined,
        description: f.description || undefined,
        conference: f.conference,
      });
      upsertLocal(created);
      closeEventForm();
      focusOn(created.start);
      toast({ text: "Event scheduled.", localUndo: () => deleteNow(created, guests(created).length > 0) }, 6000);
    }
    void ensureEvents(true);
    return true;
  } catch (e) {
    errorToast(e);
    return false;
  }
}

async function deleteNow(e: CalendarEvent, notify: boolean): Promise<void> {
  await api.del(evPath(e), { account: e.accountId, notify });
  setState((s) => ({ calEvents: s.calEvents.filter((x) => evKey(x) !== evKey(e)) }));
  toast({ text: "Undone" }, 2000);
  void ensureEvents(true);
}

// Deletes wait for the undo window, so Undo never has to re-create the event.
interface PendingDelete {
  events: CalendarEvent[];
  seriesId?: string;
  timer: ReturnType<typeof setTimeout>;
  flush: (keepalive?: boolean) => void;
}
const pendingDeletes = new Map<string, PendingDelete>();

export function isPendingDelete(e: CalendarEvent): boolean {
  for (const p of pendingDeletes.values()) {
    if (p.events.some((x) => evKey(x) === evKey(e))) return true;
    if (p.seriesId && (e.recurringEventId === p.seriesId || e.id === p.seriesId)) return true;
  }
  return false;
}

export function deleteEvent(e: CalendarEvent, opts: { notify?: boolean; scope?: "this" | "all" } = {}): void {
  const s = getState();
  const seriesId = opts.scope === "all" ? (e.recurringEventId ?? e.id) : undefined;
  const removed = s.calEvents.filter((x) => evKey(x) === evKey(e) || (!!seriesId && (x.recurringEventId === seriesId || x.id === seriesId)));
  const key = `${evKey(e)}#${Date.now()}`;
  const query = { account: e.accountId, notify: opts.notify, scope: opts.scope };
  const flush = (keepalive = false) => {
    const p = pendingDeletes.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    pendingDeletes.delete(key);
    if (keepalive) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      void fetch(`${evPath(e)}?${qs}`, { method: "DELETE", keepalive: true, headers: { "x-iris-token": TOKEN, "x-iris-client": "ui" } });
      return;
    }
    api
      .del(evPath(e), query)
      .then(() => void ensureEvents(true))
      .catch((err) => {
        setState((st) => ({ calEvents: [...st.calEvents, ...removed.filter((r) => !st.calEvents.some((x) => evKey(x) === evKey(r)))].sort((a, b) => a.start - b.start) }));
        errorToast(err);
      });
  };
  const timer = setTimeout(() => flush(), 5500);
  pendingDeletes.set(key, { events: removed.length ? removed : [e], seriesId, timer, flush });
  setState((st) => ({ calEvents: st.calEvents.filter((x) => !removed.includes(x)), calPopover: null }));
  toast(
    {
      text: "Event deleted.",
      localUndo: () => {
        const p = pendingDeletes.get(key);
        if (!p) return void toast({ text: "Too late: already deleted", kind: "error" }, 2500);
        clearTimeout(p.timer);
        pendingDeletes.delete(key);
        setState((st) => ({ calEvents: [...st.calEvents, ...p.events.filter((r) => !st.calEvents.some((x) => evKey(x) === evKey(r)))].sort((a, b) => a.start - b.start) }));
        toast({ text: "Undone" }, 2000);
      },
    },
    5000,
  );
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => [...pendingDeletes.values()].forEach((p) => p.flush(true)));

// ------------------------------------------------------------ calendars

export async function toggleCalendar(c: Calendar): Promise<void> {
  const selected = !c.selected;
  const k = calKey(c);
  setState((s) => ({ calendars: s.calendars.map((x) => (calKey(x) === k ? { ...x, selected } : x)) }));
  try {
    await api.patch(`/api/calendars/${encodeURIComponent(c.id)}`, { account: c.accountId, selected });
    await ensureEvents(true);
  } catch (e) {
    setState((s) => ({ calendars: s.calendars.map((x) => (calKey(x) === k ? { ...x, selected: c.selected } : x)) }));
    errorToast(e);
  }
}

// ------------------------------------------------------------ popover

export function openPopover(e: CalendarEvent, el: Element, invite = false): void {
  const r = el.getBoundingClientRect();
  setState({ calPopover: { event: e, rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom }, invite } });
}

export function closePopover(): void {
  setState({ calPopover: null });
}

// ------------------------------------------------------------ grid items

export type GridState = Pick<AppState, "calEvents" | "calInvite" | "calDraft" | "calAvail" | "calendars" | "calSettings">;

export function buildItems(s: GridState, from: number, to: number, now: number): GridItem[] {
  const cals = new Map(s.calendars.map((c) => [calKey(c), c]));
  const inv = s.calInvite && s.calInvite.kind !== "cancel" ? s.calInvite : null;
  let inviteMatched = false;
  const items: GridItem[] = [];
  for (const e of s.calEvents) {
    if (e.end <= from || e.start >= to || e.status === "cancelled" || isPendingDelete(e)) continue;
    const cal = cals.get(calKey({ accountId: e.accountId, id: e.calendarId })) ?? calendarOf(s.calendars, e);
    if (cal && !cal.selected) continue;
    const isInvite = !!inv && !!e.iCalUID && e.iCalUID === inv.iCalUID && e.start < inv.end + 1 && e.end > inv.start - 1;
    if (isInvite) inviteMatched = true;
    const response = isInvite && inv?.selfResponse ? inv.selfResponse : e.selfResponse;
    if (response === "declined" && !s.calSettings.showDeclined && !isInvite) continue;
    const ext = e as CalendarEvent & { allDayRow?: boolean; transparent?: boolean };
    items.push({
      key: evKey(e),
      kind: "event",
      start: e.start,
      end: e.end,
      allDay: ext.allDayRow ?? isAllDayish(e),
      title: e.summary || (cal?.accessRole === "freeBusyReader" ? "Busy" : "(No title)"),
      hue: hueOf({ hex: e.color || cal?.color }),
      // bordered = needsAction / declined / free (transparent), dashed = tentative
      style: response === "tentative" ? "dashed" : response === "needsAction" || response === "declined" || (ext.transparent && !ext.allDayRow) ? "bordered" : "filled",
      past: e.end < now,
      highlight: isInvite,
      event: e,
    });
  }
  if (inv && !inviteMatched && inv.end > from && inv.start < to) {
    const primary = s.calendars.find((c) => c.primary && (!inv.accountId || c.accountId === inv.accountId)) ?? s.calendars.find((c) => c.primary);
    items.push({
      key: `invite:${inv.messageId}`,
      kind: "invite",
      start: inv.start,
      end: inv.end,
      allDay: isAllDayish(inv),
      title: inv.summary || "(No title)",
      hue: hueOf({ hex: primary?.color }),
      style: "dashed",
      past: inv.end < now,
      highlight: true,
    });
  }
  if (s.calDraft && s.calDraft.end > from && s.calDraft.start < to)
    items.push({ key: "draft", kind: "draft", start: s.calDraft.start, end: s.calDraft.end, allDay: s.calDraft.allDay, title: s.calDraft.title || "New event", hue: "violet", style: "focused", past: false });
  s.calAvail?.slots.forEach((sl, i) => {
    if (sl.end > from && sl.start < to) items.push({ key: `slot:${i}`, kind: "slot", start: sl.start, end: sl.end, allDay: false, title: fmtRange(sl.start, sl.end), hue: "violet", style: "focused", past: false, slotIndex: i });
  });
  return items;
}

// ------------------------------------------------------------ share availability

export function startAvailability(): void {
  const s = getState();
  if (s.calAvail) return;
  const openedWeek = s.calPane !== "week";
  if (!s.calendars.length) void loadCalendars();
  setState({
    calAvail: { duration: 30, slots: [], openedWeek },
    calPopover: null,
    calForm: null,
    calDraft: null,
    ...(openedWeek ? { calPane: "week" as const, calPrevPane: s.calPane === "day" ? ("day" as const) : null, calDate: today() } : {}),
  });
}

export function cancelAvailability(): void {
  const s = getState();
  if (!s.calAvail) return;
  setState({ calAvail: null, ...(s.calAvail.openedWeek ? { calPane: s.calPrevPane } : {}) });
}

function patchAvail(fn: (slots: TimeRange[]) => TimeRange[], extra: Partial<NonNullable<AppState["calAvail"]>> = {}) {
  setState((s) => (s.calAvail ? { calAvail: { ...s.calAvail, ...extra, slots: fn(s.calAvail.slots) } } : {}));
}

export function addSlot(start: number, end?: number): void {
  const a = getState().calAvail;
  if (!a) return;
  if (start < snap(Date.now(), 15, "floor")) return void toast({ text: "Slots cannot be added in the past.", kind: "error" }, 2500);
  const e = end && end > start ? end : start + a.duration * MIN;
  patchAvail((slots) => [...slots, { start, end: e }].sort((x, y) => x.start - y.start));
}

export function removeSlot(i: number): void {
  patchAvail((slots) => slots.filter((_, j) => j !== i));
}

export function resizeSlot(i: number, end: number): void {
  patchAvail((slots) => slots.map((sl, j) => (j === i ? { ...sl, end: Math.max(sl.start + 15 * MIN, end) } : sl)));
}

export function setAvailDuration(duration: number): void {
  setState((s) => (s.calAvail ? { calAvail: { ...s.calAvail, duration } } : {}));
}

/** Iris extra: pre-fill with computed free time (09–18 Mon–Fri) via GET /api/availability. */
export async function suggestSlots(): Promise<void> {
  const s = getState();
  const a = s.calAvail;
  if (!a) return;
  setState({ calAvail: { ...a, suggesting: true } });
  try {
    const weekStart = startOfWeek(s.calDate, s.calSettings.weekStartsOn);
    const from = Math.max(Date.now(), weekStart);
    // free time of the account the reply goes out from (compose From), else the route's / primary account
    const r = await api.get<{ slots: TimeRange[] }>("/api/availability", { account: s.compose?.accountId || acct(), days: 5, duration: a.duration, from, maxRangesPerDay: 3 });
    const slots = (r.slots ?? []).filter((x) => x.end > Date.now());
    setState((st) => (st.calAvail ? { calAvail: { ...st.calAvail, slots, suggesting: false } } : {}));
    if (!slots.length) toast({ text: "No free time found in the next working days." }, 3000);
    else if (slots[0].start >= addDays(weekStart, 7)) setState({ calDate: startOfDay(slots[0].start) });
  } catch (e) {
    setState((st) => (st.calAvail ? { calAvail: { ...st.calAvail, suggesting: false } } : {}));
    errorToast(e);
  }
}

function textHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

/** POST /api/availability/text → { text, html }; falls back to the same template rendered locally. */
export async function availabilityText(slots: TimeRange[], duration: number): Promise<{ text: string; html: string }> {
  const timeZone = localTimeZone();
  try {
    const r = await api.post<{ text: string; html?: string }>("/api/availability/text", { account: getState().compose?.accountId || acct(), slots, duration, timeZone });
    if (r?.text) return { text: r.text, html: r.html || textHtml(r.text) };
  } catch {
    /* older daemon */
  }
  const text = renderAvailabilityText(slots, duration, timeZone);
  return { text, html: textHtml(text) };
}

/** Enter: render the template and insert it at the composer caret, or into a new Reply-All / message. */
export async function confirmAvailability(): Promise<void> {
  const a = getState().calAvail;
  if (!a) return;
  if (!a.slots.length) return void toast({ text: "Click the calendar to add time slots first." }, 2500);
  const { html } = await availabilityText(a.slots, a.duration);
  setState((s) => ({ calAvail: null, ...(a.openedWeek && s.calPane === "week" ? { calPane: s.calPrevPane } : {}) }));
  const s = getState();
  if (s.compose) {
    setTimeout(() => insertIntoCompose(html), 30);
  } else if (s.openId && s.thread) {
    await startReply("replyAll");
    setState((st) => (st.compose ? { compose: { ...st.compose, html: `<div>${html}</div>${st.compose.html}` } } : {}));
  } else startCompose({ html: `<div>${html}</div>` });
}
