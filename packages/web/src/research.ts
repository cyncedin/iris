// Person research: panel state, meeting-start cards, finish toasts.
import type { IrisEvent, MeetingPerson, MeetingResearchPrompt, PersonResearch, ResearchNameSource } from "@iris/core/types.ts";
import { api } from "./api";
import { emit } from "./bus";
import { ALL, defaultAccount, errorToast, getState, setState, toast } from "./state";

/** `nameSource`: the backend may swap a guessed first name for the full one from a signature or From header */
export type Research = PersonResearch;

export interface ResearchDraft {
  name: string;
  email: string;
  context: string;
  accountId?: string;
  eventId?: string;
  calendarId?: string;
  eventTitle?: string;
  /** where the prefilled name came from (attendee, From header, title guess); dropped once the user edits the name */
  nameSource?: ResearchNameSource;
}

/** list = history + "new" button; report = one report; new = the start form (prefilled from an entry point) */
export type ResearchPane = { view: "list" } | { view: "report"; id: string } | { view: "new"; draft: ResearchDraft; seq: number };

export interface ResearchCard extends MeetingResearchPrompt {
  key: string;
}

const MONTH = 30 * 86_400_000;
let seq = 0;

/** account for a new run: the draft's, else the scoped account, else the primary one */
export function researchAccount(accountId?: string): string | undefined {
  if (accountId && accountId !== ALL) return accountId;
  const s = getState();
  return s.route.account !== ALL ? s.route.account : defaultAccount();
}

/** history scope: every account in unified mode */
export function historyAccount(): string | undefined {
  return getState().unified ? ALL : defaultAccount();
}

export function openResearch(pane: ResearchPane = { view: "list" }): void {
  setState({ research: pane, askOpen: false, overlay: null, navPeek: false });
}

export function closeResearch(): void {
  setState({ research: null });
}

export function toggleResearch(): void {
  if (getState().research) closeResearch();
  else openResearch();
}

/** the start form, prefilled; focus lands on the first empty field */
export function newResearch(draft: Partial<ResearchDraft> = {}): void {
  openResearch({ view: "new", draft: { name: "", email: "", context: "", ...draft }, seq: ++seq });
}

function samePerson(r: Research, d: { name: string; email: string }): boolean {
  const email = d.email.trim().toLowerCase();
  if (email) return r.email.toLowerCase() === email;
  return !r.email && r.name.trim().toLowerCase() === d.name.trim().toLowerCase();
}

/** Entry points (event popover, contact panel): an existing report for this person opens directly, otherwise the prefilled form. */
export async function researchPerson(draft: Partial<ResearchDraft>): Promise<void> {
  const d: ResearchDraft = { name: "", email: "", context: "", ...draft };
  if (d.name.trim() || d.email.trim()) {
    try {
      const rows = await api.get<Research[]>("/api/research", { account: d.accountId ?? historyAccount(), limit: 100 });
      const recent = rows.filter((r) => r.status !== "failed" && Date.now() - r.createdAt < MONTH && samePerson(r, d));
      const hit = (d.eventId ? recent.find((r) => r.eventId === d.eventId) : undefined) ?? recent[0];
      if (hit) return openResearch({ view: "report", id: hit.id });
    } catch {
      /* older daemon or offline: fall through to the form */
    }
  }
  newResearch(d);
}

/** POST /api/research; opens the report (running) in the panel. Without `force` the daemon may hand back a recent report. */
export async function startResearch(d: ResearchDraft, opts: { force?: boolean; open?: boolean } = {}): Promise<Research | null> {
  try {
    // 202 = new or running, 200 = a finished report reused: both open in the panel; 503 ai_unavailable → errorToast (Settings)
    const r = await api.post<Research>("/api/research", {
      account: researchAccount(d.accountId),
      name: d.name.trim() || undefined,
      email: d.email.trim() || undefined,
      nameSource: d.name.trim() ? d.nameSource || undefined : undefined,
      context: d.context.trim() || undefined,
      eventId: d.eventId || undefined,
      calendarId: d.calendarId || undefined,
      force: opts.force || undefined,
    });
    if (opts.open !== false) openResearch({ view: "report", id: r.id });
    return r;
  } catch (e) {
    errorToast(e);
    return null;
  }
}

/** "Research again": same person, same context, forced */
export function rerunResearch(r: Research): Promise<Research | null> {
  return startResearch({ name: r.name, email: r.email, context: r.context, accountId: r.accountId, eventId: r.eventId, calendarId: r.calendarId, nameSource: r.nameSource }, { force: true });
}

export async function deleteResearch(r: Research): Promise<void> {
  try {
    await api.del("/api/research/" + encodeURIComponent(r.id));
    const pane = getState().research;
    if (pane?.view === "report" && pane.id === r.id) openResearch({ view: "list" });
    emit("researchChanged", { id: r.id, status: "deleted" });
    toast({ text: `Deleted report on ${displayName(r)}`, icon: "trash" }, 3000);
  } catch (e) {
    errorToast(e);
  }
}

export function displayName(r: { name: string; email: string }): string {
  return r.name.trim() || r.email || "Unknown";
}

// ------------------------------------------------------------ live events

const finished = new Set<string>();

/** `research-changed` (data `{ id, status }`): mounted views refetch; a finished run the panel isn't showing gets a toast. */
export function onResearchChanged(d: { id: string; status: string } | undefined): void {
  if (!d?.id) return;
  emit("researchChanged", d);
  if (d.status === "deleted") {
    // deleted elsewhere (CLI, MCP, another window): leave the report; the history refetches on the event above
    const pane = getState().research;
    if (pane?.view === "report" && pane.id === d.id) openResearch({ view: "list" });
    return;
  }
  if (d.status !== "done" && d.status !== "failed") {
    finished.delete(d.id); // a forced re-run of the same row can finish again
    return;
  }
  if (finished.has(d.id)) return;
  finished.add(d.id);
  const pane = getState().research;
  if (pane?.view === "report" && pane.id === d.id && !document.hidden) return; // already on screen
  void api
    .get<Research>("/api/research/" + encodeURIComponent(d.id))
    .then((r) => {
      const who = displayName(r);
      const open = () => {
        window.focus();
        openResearch({ view: "report", id: r.id });
      };
      if (r.status === "failed") toast({ text: `Research on ${who} failed`, kind: "error", action: { label: "Open", run: open } }, 10_000);
      else toast({ text: `Report on ${who} is ready`, icon: "user-search", kind: "success", action: { label: "Open", run: open } }, 12_000);
      if (r.status === "done" && document.hidden && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification(`Report on ${who} is ready`, { body: r.tldr, icon: "/icon.svg" });
        n.onclick = () => {
          open();
          n.close();
        };
      }
    })
    .catch(() => undefined);
}

/** `notification` kind "meeting-research": queue a card (bottom right) and, while the window is in the background, a desktop notification. */
export function meetingResearchPrompt(e: IrisEvent): void {
  const d = e.data as MeetingResearchPrompt;
  const accountId = d.accountId || e.accountId || "";
  const key = `${accountId}/${d.calendarId}/${d.eventId}/${d.start}`;
  if (getState().researchCards.some((c) => c.key === key)) return;
  const card: ResearchCard = { ...d, accountId, people: d.people ?? [], existing: d.existing ?? [], key };
  setState((s) => ({ researchCards: [...s.researchCards, card] }));
  if ("Notification" in window && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
    const n = new Notification(`${d.title || "Meeting"} has started`, { body: `Research needed? ${personLabel(card.people[0])}`.trim(), icon: "/icon.svg", requireInteraction: true });
    n.onclick = () => {
      window.focus();
      emit("researchCardFocus", key);
      n.close();
    };
  }
}

export function dismissResearchCard(key: string): void {
  setState((s) => ({ researchCards: s.researchCards.filter((c) => c.key !== key) }));
}

export function personLabel(p: Pick<MeetingPerson, "name" | "email"> | undefined): string {
  return p ? p.name || p.email : "";
}

/** "Research Anna" for "Anna Weber": first name without honorifics; falls back to the mailbox name */
export function shortName(p: { name: string; email: string }): string {
  const words = p.name.replace(/^((dr|prof|mr|mrs|ms|herr|frau|med|dipl|ing)\.?\s+)+/i, "").trim().split(/\s+/).filter(Boolean);
  return words[0] || p.email.split("@")[0] || "";
}
