import { useEffect, useRef, useState } from "react";
import type { Contact, ThreadSummary } from "@iris/core/types.ts";
import { api, DEMO } from "../api";
import {
  accountEmail,
  ALL,
  cancelSend,
  dismissToast,
  errorToast,
  getState,
  navigate,
  openThread,
  pauseToasts,
  resumeToasts,
  routeTitle,
  setState,
  splitOn,
  toggleNavPinned,
  undo,
  useApp,
} from "../state";
import { avatarColor, initials, nameOf, relTime } from "../util";
import { AccountDot } from "./Overlays";
import { closeCalendar, closeWeek, dayToday, openWeek } from "../cal";
import { Icon } from "./Icon";
import { ResearchDraftButton } from "./Research";
import { shortName } from "../research";

// ------------------------------------------------------------ top bar: split tabs + search

export function TopBar() {
  const route = useApp((s) => s.route);
  const splits = useApp((s) => s.splits);
  const filter = useApp((s) => s.filter);
  const searchOpen = useApp((s) => s.searchOpen);
  const total = useApp((s) => s.total);
  const connected = useApp((s) => s.connected);
  const pinned = useApp((s) => s.navPinned);
  const multi = useApp((s) => (s.status?.accounts.length ?? 0) > 1);
  const scopeEmail = useApp((s) => (s.route.account === ALL ? "" : accountEmail(s, s.route.account)));
  const enabled = splits.filter(splitOn);
  // which mailbox the list shows: nothing extra for All Inboxes; an account chip when scoped to one account
  const scope =
    multi && route.account !== ALL ? (
      <span className="scope-chip" title={`Only ${scopeEmail}`}>
        <AccountDot id={route.account} />
        <span className="scope-email">{scopeEmail}</span>
      </span>
    ) : multi && route.view !== "inbox" ? (
      <span className="scope-chip all">All accounts</span>
    ) : null;
  return (
    <header className="topbar">
      <button
        className={`icon-btn burger${pinned ? " on" : ""}`}
        title={pinned ? "Hide sidebar (⌘\\)" : "Show sidebar (⌘\\)"}
        aria-label="Sidebar"
        aria-pressed={pinned}
        onClick={() => toggleNavPinned()}
      >
        <Icon name="menu" />
      </button>
      {searchOpen ? (
        <SearchBar />
      ) : (
        <>
          {route.view === "inbox" && scope}
          {route.view === "inbox" ? (
            <nav className="splits">
              {enabled.map((s) => (
                <button key={`${s.accountId}/${s.id}`} className={route.splitId === s.id ? "on" : ""} onClick={() => navigate({ view: "inbox", splitId: s.id })}>
                  {/* unified: custom splits belong to one account */}
                  {multi && route.account === ALL && s.accountId && s.accountId !== ALL && <AccountDot id={s.accountId} />}
                  {s.name}
                  {s.unread > 0 && <span className="split-count">{s.unread}</span>}
                </button>
              ))}
            </nav>
          ) : (
            <div className="view-title">
              {routeTitle(route, splits)} <span className="el">{total}</span>
            </div>
          )}
          {route.view !== "inbox" && scope}
          {filter && (
            <button className="filter-pill" title="Clear filter" onClick={() => setState({ filter: null })}>
              {filter}
              <Icon name="x" size={12} stroke={2} />
            </button>
          )}
          <span className="spacer" />
          {!connected && <span className="offline">Reconnecting…</span>}
          {DEMO && <span className="demo-pill">Demo</span>}
          <button className="icon-btn" title="Search (/)" aria-label="Search" onClick={() => setState({ searchOpen: true, openId: null, thread: null })}>
            <Icon name="search" />
          </button>
          <AskButton />
          <CalendarButtons />
          <button className="compose-btn" title="Compose (C)" onClick={() => document.dispatchEvent(new CustomEvent("iris-command", { detail: "compose" }))}>
            <Icon name="pen" size={14} />
            Compose
          </button>
        </>
      )}
    </header>
  );
}

function CalendarButtons() {
  const pane = useApp((s) => s.calPane);
  return (
    <>
      <button
        className={`icon-btn cal-toggle${pane === "day" ? " on" : ""}`}
        title="Calendar: today (0)"
        aria-label="Calendar: today"
        aria-pressed={pane === "day"}
        onClick={() => (pane === "day" ? closeCalendar() : (closeWeek(false), dayToday()))}
      >
        <Icon name="calendar" />
      </button>
      <button
        className={`icon-btn cal-toggle${pane === "week" ? " on" : ""}`}
        title="Calendar: week (2)"
        aria-label="Calendar: week"
        aria-pressed={pane === "week"}
        onClick={() => (pane === "week" ? closeWeek() : openWeek())}
      >
        <Icon name="calendar-week" />
      </button>
    </>
  );
}

function AskButton() {
  const on = useApp((s) => s.askOpen);
  return (
    <button className={`icon-btn${on ? " on" : ""}`} title="Ask AI (?)" aria-label="Ask AI" aria-pressed={on} onClick={() => setState((s) => ({ askOpen: !s.askOpen, research: null }))}>
      <Icon name="sparkles" />
    </button>
  );
}

function SearchBar() {
  const route = useApp((s) => s.route);
  const [q, setQ] = useState(route.view === "search" ? route.q : "");
  const [people, setPeople] = useState<Contact[]>([]);
  useEffect(() => {
    if (!q.trim() || q.includes(":")) return setPeople([]);
    const account = getState().unified ? ALL : undefined; // merged contacts of every account
    const t = setTimeout(() => void api.get<Contact[]>("/api/contacts", { account, q, limit: 4 }).then(setPeople).catch(() => undefined), 80);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="searchbar">
      <Icon name="search" />
      <input
        autoFocus
        placeholder="Search mail  (from:  to:  subject:  has:attachment  newer_than:7d …)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") setState({ searchOpen: false });
          if (e.key === "Enter" && q.trim()) {
            navigate({ view: "search", q: q.trim() });
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {people.length > 0 && (
        <div className="suggest search-suggest">
          {people.map((p) => (
            <div key={p.email} className="sugg" onMouseDown={(e) => (e.preventDefault(), navigate({ view: "search", q: `from:${p.email} OR to:${p.email}` }))}>
              <span className="avatar sm" style={{ background: avatarColor(p.email) }}>
                {initials(p)}
              </span>
              <span className="sugg-name">{p.name || p.email}</span>
              <span className="sugg-email">{p.email}</span>
            </div>
          ))}
        </div>
      )}
      <button className="btn sm" onClick={() => setState({ searchOpen: false })}>
        Esc
      </button>
    </div>
  );
}

// ------------------------------------------------------------ right sidebar: the person

interface Person {
  email: string;
  contact: { name: string; score: number; lastContacted: number } | null;
  recentThreads: ThreadSummary[];
  domain: string;
}

export function ContactPanel() {
  const thread = useApp((s) => (s.openId ? s.thread : null));
  const listThread = useApp((s) => (!s.openId ? s.threads[s.cursor] : null));
  const t = thread ?? listThread;
  // the person is "not me" from the thread's own account
  const me = t?.accountId ?? "";
  const person = t ? (t.participants.find((p) => p.email !== me) ?? t.participants[0]) : null;
  const [info, setInfo] = useState<Person | null>(null);
  useEffect(() => {
    if (!person) return setInfo(null);
    const h = setTimeout(() => void api.get<Person>(`/api/people/${encodeURIComponent(person.email)}`, { account: me || undefined }).then(setInfo).catch(() => setInfo(null)), 120);
    return () => clearTimeout(h);
  }, [person?.email, me]);
  if (!person) return <aside className="contact" />;
  return (
    <aside className="contact">
      <div className="avatar xl" style={{ background: avatarColor(person.email) }}>
        {initials(person)}
      </div>
      <div className="contact-name">{nameOf(person)}</div>
      <div className="contact-email">{person.email}</div>
      {info?.domain && !/gmail|googlemail|outlook|hotmail|yahoo|icloud|gmx|web\.de/.test(info.domain) && (
        <a className="contact-domain" href={`https://${info.domain}`} target="_blank" rel="noreferrer">
          <Icon name="link" size={12} />
          {info.domain}
        </a>
      )}
      {info?.contact?.lastContacted ? <div className="contact-el">Last emailed {relTime(info.contact.lastContacted)}</div> : null}
      {info && info.recentThreads.length > 0 && (
        <div className="contact-threads">
          <div className="contact-h">Recent conversations</div>
          {info.recentThreads
            .filter((x) => x.id !== t?.id)
            .slice(0, 6)
            .map((x) => (
              <button key={x.id} className="contact-thread" title={x.subject || "(no subject)"} onClick={() => void openThread(x.id, x.accountId ?? me)}>
                <span>{x.subject || "(no subject)"}</span>
                <span className="el">{relTime(x.lastDate)}</span>
              </button>
            ))}
        </div>
      )}
      <button className="contact-all" onClick={() => navigate({ view: "search", q: `from:${person.email} OR to:${person.email}`, account: getState().route.account === ALL ? ALL : me || undefined })}>
        <Icon name="mail" size={12} />
        All mail with {nameOf(person).split(" ")[0]}
      </button>
      <ResearchDraftButton draft={{ name: person.name, email: person.email, nameSource: person.name ? "mail-header" : undefined, accountId: me || undefined }} label={`Research ${shortName(person)}`} />
    </aside>
  );
}

// ------------------------------------------------------------ Ask AI

interface Turn {
  role: "user" | "assistant";
  content: string;
  threadIds?: string[];
}

export function AskPanel() {
  const open = useApp((s) => s.askOpen);
  const available = useApp((s) => !!s.status?.ai.available);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [subjects, setSubjects] = useState<Record<string, string>>({});
  const [owners, setOwners] = useState<Record<string, string>>({});
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => void end.current?.scrollIntoView({ behavior: "smooth" }), [turns.length, busy]);
  if (!open) return null;
  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setQ("");
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: question }]);
    setBusy(true);
    try {
      const r = await api.post<{ answer: string; threadIds: string[] }>("/api/ai/ask", { question, history });
      setTurns((t) => [...t, { role: "assistant", content: r.answer, threadIds: r.threadIds }]);
      if (r.threadIds.length) {
        const res = await api.get<{ threads: ThreadSummary[] }>("/api/threads", { account: getState().unified ? ALL : undefined, view: "all", limit: 500 });
        const map: Record<string, string> = {};
        const acc: Record<string, string> = {};
        for (const th of res.threads)
          if (r.threadIds.includes(th.id) && !map[th.id]) {
            map[th.id] = th.subject;
            acc[th.id] = th.accountId;
          }
        setSubjects((s) => ({ ...s, ...map }));
        setOwners((s) => ({ ...s, ...acc }));
      }
    } catch (e) {
      errorToast(e);
      setTurns((t) => t.slice(0, -1));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="ask">
      <div className="ask-head">
        <span>
          <Icon name="sparkles" className="sparkle" />
          Ask AI
        </span>
        <button className="icon-btn sm" title="Close (Esc)" aria-label="Close" onClick={() => setState({ askOpen: false })}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ask-body">
        {!turns.length && (
          <div className="ask-empty">
            {available ? (
              <>
                Ask anything about your email.
                <div className="ask-examples">
                  {["What do I need to reply to today?", "When is my next flight?", "Summarize what Jonas wants", "Which invoices did I get this month?"].map((x) => (
                    <button key={x} className="chip ghost" onClick={() => setQ(x)}>
                      {x}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                Add your Anthropic API key to use Ask AI.{" "}
                <button className="link" onClick={() => setState({ overlay: { kind: "settings", section: "ai" } })}>
                  Settings
                </button>
              </>
            )}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
            <div className="turn-text">{t.content}</div>
            {t.threadIds?.map((id) => (
              <button key={id} className="chip" title={subjects[id] ?? id} onClick={() => void openThread(id, owners[id])}>
                <Icon name="arrow-up-right" size={14} />
                <span className="cmd-title">{subjects[id] ?? id}</span>
              </button>
            ))}
          </div>
        ))}
        {busy && <div className="turn assistant shimmer">Searching your mail…</div>}
        <div ref={end} />
      </div>
      <input
        className="ask-input"
        placeholder="Ask about your mail…"
        value={q}
        autoFocus
        disabled={!available}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void ask();
          if (e.key === "Escape") setState({ askOpen: false });
        }}
      />
    </aside>
  );
}

// ------------------------------------------------------------ toasts

function Countdown({ until }: { until: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, []);
  return <span className="toast-count">{Math.max(0, Math.ceil((until - Date.now()) / 1000))}s</span>;
}

/** Sonner-style stack: bottom-left, newest at the bottom, timers pause on hover. */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const live = toasts.filter((t) => !t.leaving);
  // --i: 0 = newest. Live toasts count among live ones (so the rest glide down while one leaves);
  // a leaving toast keeps its slot among all toasts.
  const slot = (t: (typeof toasts)[number], all: number) => (t.leaving ? toasts.length - 1 - all : live.length - 1 - live.indexOf(t));
  return (
    <div className="toasts" role="region" aria-label="Notifications" onPointerEnter={() => pauseToasts()} onPointerLeave={() => resumeToasts()}>
      {toasts.map((t, n) => (
        <div
          key={t.id}
          className={`toast ${t.kind ?? "info"}`}
          role={t.kind === "error" ? "alert" : "status"}
          data-leaving={t.leaving ? "" : undefined}
          style={{ "--i": slot(t, n) } as React.CSSProperties}
        >
          {t.icon && <Icon name={t.icon} />}
          <span className="toast-text" title={t.text}>
            {t.text}
          </span>
          {t.kind === "send" && t.sendAt && <Countdown until={t.sendAt} />}
          {(t.undoId || t.outboxId) && (
            <button className="toast-action primary-action" onClick={() => (t.outboxId ? void cancelSend(t.outboxId, t.id) : void undo(t.undoId))}>
              <Icon name="undo" size={14} />
              Undo <kbd>Z</kbd>
            </button>
          )}
          {t.localUndo && (
            <button
              className="toast-action primary-action"
              onClick={() => {
                dismissToast(t.id);
                void Promise.resolve(t.localUndo!()).catch(errorToast);
              }}
            >
              <Icon name="undo" size={14} />
              Undo <kbd>Z</kbd>
            </button>
          )}
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" title="Dismiss" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ onboarding

export function Onboarding() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ loginId: string; url: string }>("/api/accounts/gmail", {});
      for (let i = 0; i < 300; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const s = await api.get<{ status: string; error?: string }>(`/api/accounts/login/${r.loginId}`);
        if (s.status === "done") return void location.reload();
        if (s.status === "error") throw new Error(s.error);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="onboarding">
      <img src="/icon.svg" width={72} height={72} alt="" />
      <h1>Iris</h1>
      <p>The fastest email experience, on your Mac. Your mail stays between your Mac and Gmail.</p>
      <button className="primary big" disabled={busy} onClick={() => void connect()}>
        {busy ? "Finish in your browser…" : "Connect Gmail"}
      </button>
      {err && <p className="error">{err}</p>}
      <p className="el small">
        Needs a Google OAuth client first: <code>iris auth client ~/Downloads/client_secret_….json</code>
      </p>
    </div>
  );
}
