// Command registry: one list feeds the keyboard dispatcher, the Cmd+K palette and the shortcut sheet.
import { api } from "./api";
import {
  act,
  ALL,
  closeGoals,
  closeThread,
  cycleSplit,
  errorToast,
  getState,
  goInbox,
  moveCursor,
  navigate,
  openGoals,
  openThread,
  refsBody,
  selectAll,
  setFilter,
  setState,
  startCompose,
  startReply,
  targetRefs,
  toast,
  toggleNavPinned,
  toggleSelect,
  undo,
  type AppState,
} from "./state";
import { emit } from "./bus";
import { newResearch, researchPerson, toggleResearch } from "./research";
import {
  cancelAvailability,
  closeCalendar,
  closeWeek,
  confirmAvailability,
  createAtNow,
  createEmpty,
  createFromContext,
  cycleCalendar,
  dayToday,
  openWeek,
  rsvpInvite,
  shiftDay,
  shiftWeek,
  showDay,
  startAvailability,
  suggestSlots,
  toggleRsvpAndDone,
  weekToday,
} from "./cal";
import { setCalSettings } from "./state";

/** "calendar" = the week page, which replaces the list. */
/** "goals" = the goals page, which also replaces the list. */
export type Region = "list" | "thread" | "any" | "calendar" | "goals";

export interface Command {
  id: string;
  title: string;
  keys?: string[];
  region?: Region; // where the shortcut is live (default any)
  section: "Actions" | "Navigation" | "Compose" | "AI" | "Views" | "Calendar" | "App";
  palette?: boolean; // show in Cmd+K (default true)
  enabled?: (s: AppState) => boolean;
  run: () => void | Promise<void>;
}

const hasTarget = (s: AppState) => !!(s.selected.length || s.openId || s.threads[s.cursor]);
const inThread = (s: AppState) => !!s.openId;
const aiOn = (s: AppState) => !!s.status?.ai.available;
const dayOpen = (s: AppState) => s.calPane === "day";
const canRsvp = (s: AppState) => !!s.calInvite?.canRsvp && s.openId === s.calInvite.threadId;
const noAvail = (s: AppState) => !s.calAvail;
const todayMs = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

function rsvpCmd(id: string, title: string, response: "accepted" | "tentative" | "declined", markDone: boolean): Command {
  return { id, title, section: "Calendar", enabled: canRsvp, run: () => void rsvpInvite(getState().calInvite!, response, { markDone }) };
}

function currentLabelName(s: AppState): string | undefined {
  return s.route.view === "label" ? s.route.name : undefined;
}

/** ⌃T: light ↔ dark. Glass (and Paper) go to Graphite, Graphite goes back to Glass. Paper stays reachable in Settings. */
function toggleTheme() {
  const theme = getState().theme === "graphite" ? "glass" : "graphite";
  setState({ theme });
  void api.patch("/api/settings", { theme }).catch(() => undefined);
}

export const COMMANDS: Command[] = [
  // ---- triage
  { id: "done", title: "Mark Done", keys: ["e"], section: "Actions", enabled: hasTarget, run: () => act("done") },
  { id: "undone", title: "Mark Not Done (move to Inbox)", keys: ["shift+e"], section: "Actions", enabled: hasTarget, run: () => act("undone") },
  { id: "remind", title: "Remind Me", keys: ["h", "mod+shift+h"], section: "Actions", enabled: hasTarget, run: () => openTargetOverlay("remind") },
  { id: "star", title: "Star / Unstar", keys: ["s"], section: "Actions", enabled: hasTarget, run: () => act("toggleStar") },
  { id: "read", title: "Mark Read or Unread", keys: ["u"], section: "Actions", enabled: hasTarget, run: () => act("toggleRead") },
  { id: "trash", title: "Trash", keys: ["#", "mod+backspace"], section: "Actions", enabled: hasTarget, run: () => act(getState().route.view === "trash" ? "untrash" : "trash") },
  { id: "spam", title: "Mark as Spam", keys: ["!"], section: "Actions", enabled: hasTarget, run: () => act(getState().route.view === "spam" ? "notSpam" : "spam") },
  { id: "mute", title: "Mute", keys: ["shift+m"], section: "Actions", enabled: hasTarget, run: () => act(getState().route.view === "muted" ? "unmute" : "mute") },
  { id: "label", title: "Add or Remove Label", keys: ["l"], section: "Actions", enabled: hasTarget, run: () => openTargetOverlay("label") },
  { id: "move", title: "Move (Label + Done)", keys: ["v"], section: "Actions", enabled: hasTarget, run: () => openTargetOverlay("move") },
  {
    id: "removeLabel",
    title: "Remove Label (current view)",
    keys: ["y"],
    section: "Actions",
    enabled: (s) => hasTarget(s) && !!currentLabelName(s),
    run: () => act("removeLabel", { label: currentLabelName(getState()) }),
  },
  { id: "removeAllLabels", title: "Remove All Labels", keys: ["shift+y"], section: "Actions", enabled: hasTarget, run: () => act("removeAllLabels") },
  { id: "important", title: "Mark Important", section: "Actions", enabled: hasTarget, run: () => act("important") },
  { id: "unimportant", title: "Mark Not Important", section: "Actions", enabled: hasTarget, run: () => act("unimportant") },
  { id: "undo", title: "Undo", keys: ["z"], section: "Actions", run: () => undo() },
  { id: "select", title: "Select Conversation", keys: ["x"], region: "list", section: "Actions", run: () => toggleSelect() },
  { id: "selectFrom", title: "Select All from Here", keys: ["mod+a"], region: "list", section: "Actions", run: () => selectAll(true) },
  { id: "selectAll", title: "Select All", keys: ["mod+shift+a"], region: "list", section: "Actions", run: () => selectAll(false) },
  { id: "zero", title: "Get Me To Zero", section: "Actions", run: () => setState({ overlay: { kind: "zero" } }) },
  {
    id: "unsubscribe",
    title: "Unsubscribe",
    keys: ["mod+shift+u"],
    region: "any",
    section: "Actions",
    enabled: (s) => !!targetThread(s)?.listId,
    run: () => unsubscribe(),
  },
  { id: "linkGoal", title: "Link to Goal", keys: ["shift+g"], section: "Actions", enabled: hasTarget, run: () => void linkToGoal() },
  { id: "block", title: "Block Sender", section: "Actions", enabled: (s) => !!targetThread(s), run: () => blockSender() },

  // ---- navigation
  { id: "next", title: "Next Conversation", keys: ["j", "down"], section: "Navigation", palette: false, run: () => moveCursor(1) },
  { id: "prev", title: "Previous Conversation", keys: ["k", "up"], section: "Navigation", palette: false, run: () => moveCursor(-1) },
  {
    id: "open",
    title: "Open Conversation",
    keys: ["enter", "o"],
    region: "list",
    section: "Navigation",
    palette: false,
    run: () => {
      const t = getState().threads[getState().cursor];
      if (t) void openThread(t.id, t.accountId);
    },
  },
  { id: "back", title: "Back to List", keys: ["esc"], region: "thread", section: "Navigation", palette: false, run: () => closeThread() },
  { id: "top", title: "Jump to Top", keys: ["mod+up"], region: "list", section: "Navigation", palette: false, run: () => setState({ cursor: 0 }) },
  { id: "bottom", title: "Jump to Bottom", keys: ["mod+down"], region: "list", section: "Navigation", palette: false, run: () => setState((s) => ({ cursor: Math.max(0, s.threads.length - 1) })) },
  { id: "nextSplit", title: "Next Split", keys: ["tab"], region: "list", section: "Navigation", run: () => cycleSplit(1) },
  { id: "prevSplit", title: "Previous Split", keys: ["shift+tab"], region: "list", section: "Navigation", run: () => cycleSplit(-1) },
  { id: "search", title: "Search", keys: ["/"], section: "Navigation", run: () => setState({ searchOpen: true, openId: null, thread: null }) },
  { id: "palette", title: "Command Palette", keys: ["mod+k", "mod+shift+k"], section: "App", palette: false, run: () => setState({ overlay: { kind: "palette" } }) },
  { id: "filterUnread", title: "Filter: Unread", keys: ["shift+u"], region: "list", section: "Views", run: () => setFilter("unread") },
  { id: "filterStarred", title: "Filter: Starred", keys: ["shift+s"], region: "list", section: "Views", run: () => setFilter("starred") },
  { id: "filterImportant", title: "Filter: Important", keys: ["shift+i"], region: "list", section: "Views", run: () => setFilter("important") },
  { id: "expandAll", title: "Expand All Messages", keys: ["shift+o"], region: "thread", section: "Navigation", run: () => emit("expandAll") },
  { id: "expandOne", title: "Expand Message", keys: ["o"], region: "thread", section: "Navigation", palette: false, run: () => emit("expandFocused") },
  { id: "nextMsg", title: "Next Message in Thread", keys: ["n"], region: "thread", section: "Navigation", palette: false, run: () => emit("focusMessage", 1) },
  { id: "prevMsg", title: "Previous Message in Thread", keys: ["p"], region: "thread", section: "Navigation", palette: false, run: () => emit("focusMessage", -1) },
  { id: "scroll", title: "Scroll Down", keys: ["space"], region: "thread", section: "Navigation", palette: false, run: () => emit("scroll", 1) },
  { id: "scrollUp", title: "Scroll Up", keys: ["shift+space"], region: "thread", section: "Navigation", palette: false, run: () => emit("scroll", -1) },

  // ---- views (g sequences)
  // g i = All Inboxes (every account); ⌃1 / ⌃2 … = one account's Inbox (accountCommands below)
  { id: "goInbox", title: "Go to All Inboxes", keys: ["g i"], section: "Views", run: () => goInbox(ALL) },
  { id: "goOther", title: "Go to Other", keys: ["g o"], section: "Views", run: () => goInbox(getState().route.account, "other") },
  { id: "goStarred", title: "Go to Starred", keys: ["g s"], section: "Views", run: () => navigate({ view: "starred" }) },
  { id: "goDrafts", title: "Go to Drafts", keys: ["g d"], section: "Views", run: () => navigate({ view: "drafts" }) },
  { id: "goSent", title: "Go to Sent", keys: ["g t"], section: "Views", run: () => navigate({ view: "sent" }) },
  { id: "goDone", title: "Go to Done", keys: ["g e"], section: "Views", run: () => navigate({ view: "done" }) },
  { id: "goReminders", title: "Go to Reminders", keys: ["g h"], section: "Views", run: () => navigate({ view: "reminders" }) },
  { id: "goScheduled", title: "Go to Scheduled (Send Later)", section: "Views", run: () => navigate({ view: "scheduled" }) },
  { id: "goAll", title: "Go to All Mail", keys: ["g a"], section: "Views", run: () => navigate({ view: "all" }) },
  { id: "goSpam", title: "Go to Spam", keys: ["g !"], section: "Views", run: () => navigate({ view: "spam" }) },
  { id: "goTrash", title: "Go to Trash", keys: ["g #"], section: "Views", run: () => navigate({ view: "trash" }) },
  { id: "goMuted", title: "Go to Muted", keys: ["g m"], section: "Views", run: () => navigate({ view: "muted" }) },
  { id: "goLabel", title: "Go to Label…", keys: ["g l"], section: "Views", run: () => setState({ overlay: { kind: "goLabel" } }) },
  { id: "goGoals", title: "Go to Goals (Progress)", keys: ["g g"], section: "Views", run: () => (getState().goalsOpen ? closeGoals() : openGoals()) },
  { id: "goResearch", title: "Go to Research (person reports)", keys: ["g p"], section: "Views", run: () => toggleResearch() },
  { id: "goalNew", title: "New Goal", keys: ["n"], region: "goals", section: "Views", run: () => openGoals({ create: true }) },
  { id: "goSnippets", title: "Snippets", keys: ["g ;"], section: "Views", run: () => setState({ overlay: { kind: "settings", section: "snippets" } }) },

  // ---- compose
  { id: "compose", title: "Compose", keys: ["c", "shift+c"], section: "Compose", run: () => startCompose() },
  { id: "replyAll", title: "Reply All", keys: ["enter", "a"], region: "thread", section: "Compose", enabled: inThread, run: () => startReply("replyAll") },
  { id: "reply", title: "Reply", keys: ["r"], region: "thread", section: "Compose", enabled: inThread, run: () => startReply("reply") },
  { id: "forward", title: "Forward", keys: ["f"], region: "thread", section: "Compose", enabled: inThread, run: () => startReply("forward") },
  { id: "replyPop", title: "Reply, Pop Out Draft", keys: ["shift+r"], region: "thread", section: "Compose", enabled: inThread, run: () => startReply("reply", true) },
  { id: "replyAllPop", title: "Pop Out Reply-all", keys: ["shift+enter"], region: "thread", section: "Compose", enabled: inThread, run: () => startReply("replyAll", true) },
  { id: "forwardPop", title: "Pop Out Forward", keys: ["shift+f"], region: "thread", section: "Compose", enabled: inThread, run: () => startReply("forward", true) },

  // ---- AI
  { id: "summarize", title: "Summarize", keys: ["i"], region: "thread", section: "AI", enabled: inThread, run: () => emit("summarize") },
  { id: "translate", title: "Translate Message", keys: ["shift+t"], region: "thread", section: "AI", enabled: (s) => inThread(s) && aiOn(s), run: () => emit("translate") },
  { id: "aiWrite", title: "Write with AI", keys: ["mod+j"], section: "AI", run: () => aiWrite() },
  { id: "ask", title: "Ask AI", keys: ["?", "mod+shift+/"], section: "AI", run: () => setState((s) => ({ askOpen: !s.askOpen, research: null })) },
  { id: "researchPerson", title: "Research person…", section: "AI", run: () => newResearch() },
  { id: "researchSender", title: "Research Sender (who is this?)", section: "AI", enabled: (s) => !!targetPerson(s), run: () => researchSender() },
  { id: "autoLabel", title: "Auto-label inbox with AI", section: "AI", enabled: aiOn, run: () => autoLabelInbox() },

  // ---- calendar: inbox / thread
  { id: "calCycle", title: "Calendar: Day → Week → Close", keys: ["0", "mod+shift+0"], section: "Calendar", palette: false, run: () => cycleCalendar() },
  { id: "calOpenDay", title: "Open Day (Day View, See My Day)", section: "Calendar", run: () => showDay(todayMs(), { focus: Date.now() }) },
  { id: "calOpenWeek", title: "Open Week (Open Calendar, Week View)", keys: ["2"], section: "Calendar", run: () => openWeek() },
  { id: "calClose", title: "Close Calendar", section: "Calendar", enabled: (s) => !!s.calPane, run: () => closeCalendar() },
  { id: "calPrevDay", title: "Previous Day", keys: ["-", "mod+shift+-"], section: "Calendar", palette: false, enabled: dayOpen, run: () => shiftDay(-1) },
  { id: "calNextDay", title: "Next Day", keys: ["=", "+", "mod+shift+="], section: "Calendar", palette: false, enabled: dayOpen, run: () => shiftDay(1) },
  { id: "calToday", title: "Day Pane: Today", keys: ["t"], section: "Calendar", palette: false, run: () => dayToday() },
  { id: "calCreate", title: "Create Event (Instant Event, Create Meeting, Send Invitation)", keys: ["b"], section: "Calendar", run: () => createFromContext() },
  { id: "calCreateEmpty", title: "Create Empty Event", keys: ["shift+b"], section: "Calendar", run: () => createEmpty() },
  { id: "calAvail", title: "Share Availability", keys: ["mod+shift+a"], section: "Calendar", enabled: noAvail, run: () => startAvailability() },
  {
    id: "calFindTime",
    title: "Find Time (suggest free slots)",
    section: "Calendar",
    run: () => {
      startAvailability();
      setTimeout(() => void suggestSlots(), 0);
    },
  },
  { id: "calFocusInvite", title: "Focus Invite", keys: ["tab"], region: "thread", section: "Calendar", palette: false, enabled: (s) => !!s.calInvite && s.openId === s.calInvite.threadId, run: () => emit("focusInvite") },
  rsvpCmd("rsvpYes", "RSVP: Yes (Accept, Going)", "accepted", false),
  rsvpCmd("rsvpMaybe", "RSVP: Maybe (Tentative)", "tentative", false),
  rsvpCmd("rsvpNo", "RSVP: No (Decline, Not going)", "declined", false),
  rsvpCmd("rsvpYesDone", "RSVP: Yes and Mark Done", "accepted", true),
  rsvpCmd("rsvpMaybeDone", "RSVP: Maybe and Mark Done", "tentative", true),
  rsvpCmd("rsvpNoDone", "RSVP: No and Mark Done", "declined", true),
  { id: "calRsvpDone", title: "Enable/Disable RSVP + Mark Done", section: "Calendar", run: () => toggleRsvpAndDone() },
  { id: "calWeekends", title: "Show/Hide Weekends", section: "Calendar", run: () => setCalSettings({ showWeekends: !getState().calSettings.showWeekends }) },
  { id: "calDeclined", title: "Show/Hide Declined Events", section: "Calendar", run: () => setCalSettings({ showDeclined: !getState().calSettings.showDeclined }) },
  { id: "calWeekStart", title: "Start Week on Monday / Sunday", section: "Calendar", run: () => setCalSettings({ weekStartsOn: getState().calSettings.weekStartsOn === 1 ? 0 : 1 }) },

  // ---- calendar: week page (region "calendar")
  { id: "weekNext", title: "Next Week", keys: ["j", "n", "right", "=", "+", "shift+=", "mod+shift+="], region: "calendar", section: "Calendar", palette: false, run: () => shiftWeek(1) },
  { id: "weekPrev", title: "Previous Week", keys: ["k", "p", "left", "-", "shift+-", "mod+shift+-"], region: "calendar", section: "Calendar", palette: false, run: () => shiftWeek(-1) },
  { id: "weekToday", title: "Week: Today", keys: ["t", "space"], region: "calendar", section: "Calendar", palette: false, run: () => weekToday() },
  { id: "weekClose", title: "Close Week", keys: ["0", "mod+shift+0"], region: "calendar", section: "Calendar", palette: false, run: () => (getState().calAvail ? cancelAvailability() : closeWeek(false)) },
  { id: "weekBack", title: "Close Week (back)", keys: ["1"], region: "calendar", section: "Calendar", palette: false, run: () => (getState().calAvail ? cancelAvailability() : closeWeek(true)) },
  { id: "weekCreate", title: "Create Event in Week", keys: ["b", "shift+b"], region: "calendar", section: "Calendar", palette: false, enabled: noAvail, run: () => createAtNow() },
  { id: "availInsert", title: "Insert Availability", keys: ["enter", "mod+enter"], region: "calendar", section: "Calendar", palette: false, enabled: (s) => !!s.calAvail, run: () => confirmAvailability() },

  // ---- app
  { id: "settings", title: "Settings", keys: ["mod+,"], section: "App", run: () => setState({ overlay: { kind: "settings" } }) },
  { id: "theme", title: "Toggle Theme (Glass / Graphite)", keys: ["ctrl+t"], section: "App", run: () => toggleTheme() },
  { id: "shortcuts", title: "Keyboard Shortcuts", keys: ["mod+/"], section: "App", run: () => setState({ overlay: { kind: "shortcuts" } }) },
  { id: "nav", title: "Pin / Unpin Sidebar", keys: ["mod+\\"], section: "App", run: () => toggleNavPinned() },
  { id: "navFocus", title: "Show Navigation (focus the sidebar)", keys: ["mod+shift+m"], section: "App", run: () => emit("navFocus") },
  { id: "sync", title: "Sync Now", section: "App", run: () => syncNow() },
  {
    id: "notifications",
    title: "Enable Desktop Notifications",
    section: "App",
    enabled: () => "Notification" in window && Notification.permission !== "granted",
    run: () => void Notification.requestPermission(),
  },
];

function targetThread(s: AppState) {
  if (s.thread && s.openId) return s.thread;
  return s.threads[s.cursor];
}

/** the other person of the targeted conversation (not the account itself) */
function targetPerson(s: AppState) {
  const t = targetThread(s);
  if (!t) return null;
  return t.participants.find((p) => p.email !== t.accountId) ?? t.participants[0] ?? null;
}

function researchSender() {
  const s = getState();
  const p = targetPerson(s);
  if (p) void researchPerson({ name: p.name, email: p.email, nameSource: p.name ? "mail-header" : undefined, accountId: targetThread(s)?.accountId });
}

function openTargetOverlay(kind: "remind" | "label" | "move") {
  const refs = targetRefs();
  if (!refs.length) return;
  if (kind === "remind") setState({ overlay: { kind: "remind", refs } });
  else setState({ overlay: { kind: "label", mode: kind === "move" ? "move" : "add", refs } });
}

/** One "Go to <email> Inbox" per account (⌃1 … ⌃9), for ⌘K and the shortcut sheet. */
export function accountCommands(s: AppState): Command[] {
  return (s.status?.accounts ?? []).map((a, i) => ({
    id: `goAccount:${a.id}`,
    title: `Go to ${a.email} Inbox`,
    keys: i < 9 ? [`ctrl+${i + 1}`] : undefined,
    section: "Views" as const,
    run: () => goInbox(a.id),
  }));
}

function linkToGoal() {
  const refs = targetRefs();
  if (refs.length) setState({ overlay: { kind: "goal", refs } });
}

async function unsubscribe() {
  const t = targetThread(getState());
  if (!t) return;
  try {
    const r = await api.post<{ ok: boolean; method: string; url?: string; sender?: string }>("/api/unsubscribe", { account: t.accountId, threadId: t.id, then: "done" });
    if (r.ok) toast({ text: `Unsubscribed from ${r.sender}` });
    else if (r.url) {
      window.open(r.url, "_blank", "noopener,noreferrer");
      toast({ text: "Opened the unsubscribe page" });
    } else toast({ text: "This sender does not support unsubscribe", kind: "error" });
  } catch (e) {
    errorToast(e);
  }
}

async function blockSender() {
  const t = targetThread(getState());
  const sender = t?.lastFrom?.email ?? t?.participants[0]?.email;
  if (!sender || !confirm(`Block ${sender}? Future mail goes to Trash.`)) return;
  try {
    const r = await api.post<{ trashed: number }>("/api/block", { account: t?.accountId, value: sender });
    toast({ text: `Blocked ${sender} (${r.trashed} trashed)` });
  } catch (e) {
    errorToast(e);
  }
}

async function autoLabelInbox() {
  const s = getState();
  const refs = s.threads.slice(0, 60).map((t) => ({ account: t.accountId, threadId: t.id }));
  toast({ text: `Labelling ${refs.length} conversations…` }, 3000);
  try {
    // the AI endpoint is per account: one call per account in unified lists
    const byAccount = new Map<string, typeof refs>();
    for (const r of refs) byAccount.set(r.account, [...(byAccount.get(r.account) ?? []), r]);
    await Promise.all([...byAccount.values()].map((group) => api.post("/api/ai/autolabel", refsBody(group))));
    toast({ text: "AI labels updated" });
  } catch (e) {
    errorToast(e);
  }
}

async function syncNow() {
  try {
    const scope = getState().route.account;
    await api.post("/api/sync", { account: scope === ALL ? undefined : scope });
    toast({ text: "Synced" }, 2000);
  } catch (e) {
    errorToast(e);
  }
}

function aiWrite() {
  const s = getState();
  if (s.compose) return emit("aiPrompt");
  if (s.openId) {
    void startReply("replyAll").then(() => setTimeout(() => emit("aiPrompt"), 50));
    return;
  }
  startCompose();
  setTimeout(() => emit("aiPrompt"), 50);
}

/** Global commands that stay live on the week page; everything else there is region "calendar". */
const CAL_PASSTHROUGH = new Set(["palette", "search", "compose", "undo", "ask", "aiWrite", "settings", "theme", "shortcuts", "nav", "navFocus", "calAvail"]);

export function regionOf(s: AppState): Region {
  return s.goalsOpen ? "goals" : s.calPane === "week" ? "calendar" : s.openId ? "thread" : "list";
}

/** Resolve a combo for the current region. Thread-region bindings win over list-region ones in thread view. */
export function findCommand(combo: string, s: AppState): Command | undefined {
  const region = regionOf(s);
  const live = (c: Command) =>
    region === "calendar" || region === "goals" ? c.region === region || CAL_PASSTHROUGH.has(c.id) || c.id.startsWith("go") || (region === "goals" && c.id === "calOpenWeek") : !c.region || c.region === "any" || c.region === region;
  const candidates = COMMANDS.filter((c) => c.keys?.includes(combo) && live(c));
  candidates.sort((a, b) => Number(b.region === region) - Number(a.region === region));
  return candidates.find((c) => !c.enabled || c.enabled(s));
}

export const SEQUENCE_PREFIXES = ["g"];
