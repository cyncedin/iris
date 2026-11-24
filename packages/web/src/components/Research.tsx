// Person research UI: the right-side panel (history, start form, report)
// and the meeting-start cards ("Research needed?").
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, ApiError } from "../api";
import { on } from "../bus";
import {
  closeResearch,
  deleteResearch,
  dismissResearchCard,
  displayName,
  historyAccount,
  newResearch,
  openResearch,
  personLabel,
  rerunResearch,
  researchPerson,
  startResearch,
  type Research,
  type ResearchCard,
  type ResearchDraft,
} from "../research";
import { accountEmail, setState, useApp } from "../state";
import { avatarColor, initials, relTime } from "../util";
import { Icon } from "./Icon";
import { Markdown, shortUrl } from "./Markdown";

const CONFIDENCE: Record<string, { label: string; title: string }> = {
  high: { label: "Confident", title: "The person found is very likely the one from the meeting" },
  medium: { label: "Likely", title: "Good match, but not clearly confirmed" },
  low: { label: "Uncertain", title: "Several candidates or little evidence: check the open questions" },
};

const NAME_SOURCE: Record<string, string> = {
  signature: "Name from signature",
  "mail-header": "Name from email sender",
  web: "Name from web search",
};

/** keys typed inside research surfaces never reach the global shortcut handler (App.tsx listens on window) */
function keepKeys(e: ReactKeyboardEvent) {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    closeResearch();
  }
}

function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "2-digit", minute: "2-digit" });
}

function Avatar({ r, size = "" }: { r: { name: string; email: string }; size?: string }) {
  const who = { name: r.name, email: r.email || r.name };
  return (
    <span className={`avatar rs-av ${size}`} style={{ background: avatarColor(who.email) }}>
      {initials(who)}
    </span>
  );
}

export function ConfidenceChip({ value }: { value: string }) {
  const c = CONFIDENCE[value];
  if (!c) return null;
  return (
    <span className={`rs-conf ${value}`} title={c.title}>
      <span className="rs-conf-dot" />
      {c.label}
    </span>
  );
}

// ------------------------------------------------------------ panel

export function ResearchPanel() {
  const pane = useApp((s) => s.research);
  if (!pane) return null;
  const back = pane.view !== "list";
  return (
    <aside className="ask research" aria-label="Research">
      <div className="ask-head">
        <span>
          {back ? (
            <button className="icon-btn sm rs-back" title="All reports" aria-label="All reports" onClick={() => openResearch({ view: "list" })}>
              <Icon name="chevron-left" />
            </button>
          ) : (
            <Icon name="user-search" className="sparkle" />
          )}
          Research
        </span>
        <span className="rs-head-actions">
          {pane.view !== "new" && (
            <button className="icon-btn sm" title="Research a person" aria-label="Research a person" onClick={() => newResearch()}>
              <Icon name="plus" />
            </button>
          )}
          <button className="icon-btn sm" title="Close (Esc)" aria-label="Close" onClick={closeResearch}>
            <Icon name="x" />
          </button>
        </span>
      </div>
      {pane.view === "list" && <ResearchHistory />}
      {pane.view === "new" && <ResearchForm key={pane.seq} draft={pane.draft} />}
      {pane.view === "report" && <ResearchReport key={pane.id} id={pane.id} />}
    </aside>
  );
}

function ResearchHistory() {
  const [rows, setRows] = useState<Research[] | null>(null);
  const [err, setErr] = useState("");
  const multi = useApp((s) => (s.status?.accounts.length ?? 0) > 1);
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      void api
        .get<Research[]>("/api/research", { account: historyAccount(), limit: 100 })
        .then((r) => alive && (setRows(r), setErr("")))
        .catch((e) => alive && setErr(e instanceof ApiError && e.status === 404 ? "The daemon doesn't support research yet. Restart Iris." : String(e instanceof Error ? e.message : e)));
    load();
    const off = on("researchChanged", () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 300);
    });
    return () => {
      alive = false;
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  return (
    <div className="ask-body rs-body">
      <button className="btn rs-new" onClick={() => newResearch()}>
        <Icon name="user-search" />
        Research a person
      </button>
      {err && <div className="rs-error">{err}</div>}
      {rows && !rows.length && !err && (
        <div className="ask-empty rs-empty">
          Know who you're meeting before the call: role, career, interests, how you're connected and good conversation starters.
          <div className="el small">Also starts from a calendar event, the contact panel or ⌘K "Research person…".</div>
        </div>
      )}
      {rows === null && !err && <div className="shimmer small">Loading…</div>}
      {rows && rows.length > 0 && (
        <div className="rs-list" role="list">
          <div className="contact-h">Reports</div>
          {rows.map((r) => (
            <button key={r.id} role="listitem" className="rs-row" onClick={() => openResearch({ view: "report", id: r.id })}>
              <Avatar r={r} />
              <span className="rs-row-main">
                <span className="rs-row-top">
                  <span className="rs-row-name">{displayName(r)}</span>
                  <span className="rs-row-date">{relTime(r.createdAt)}</span>
                </span>
                <span className={`rs-row-sub${r.status === "failed" ? " failed" : ""}`} title={r.tldr || r.eventTitle}>
                  {r.status === "running" ? (
                    <>
                      <span className="rs-live" />
                      {r.progress || "Researching…"}
                    </>
                  ) : r.status === "failed" ? (
                    "Failed"
                  ) : (
                    r.tldr || r.eventTitle || "Report"
                  )}
                </span>
                {multi && <span className="rs-row-acct">{r.accountId}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ResearchForm({ draft }: { draft: ResearchDraft }) {
  const available = useApp((s) => !!s.status?.ai.available);
  const [name, setName] = useState(draft.name);
  const [email, setEmail] = useState(draft.email);
  const [context, setContext] = useState(draft.context);
  const [event, setEvent] = useState(draft.eventId ? { eventId: draft.eventId, calendarId: draft.calendarId, eventTitle: draft.eventTitle } : null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const ctxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // first empty field: a prefilled person goes straight to "what do you know"
    (draft.name || draft.email ? ctxRef.current : nameRef.current)?.focus();
  }, []);
  const ok = !!(name.trim() || email.trim()) && available && !busy;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ok) return;
    setBusy(true);
    const nameSource = name.trim() === draft.name.trim() ? draft.nameSource : undefined; // edited → the daemon records "user"
    const r = await startResearch({ ...draft, name, email, context, nameSource, eventId: event?.eventId, calendarId: event?.calendarId });
    if (!r) setBusy(false);
  };
  return (
    <form className="ask-body rs-body rs-form" onSubmit={(e) => void submit(e)} onKeyDown={keepKeys}>
      <div className="rs-form-title">Who do you want to know about?</div>
      <label className="rs-field">
        <span>Name</span>
        <input ref={nameRef} value={name} placeholder="e.g. Elena Marsh" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="rs-field">
        <span>
          Email <span className="el">(optional)</span>
        </span>
        <input type="email" value={email} placeholder="name@company.com" onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="rs-field">
        <span>What do you already know?</span>
        <textarea
          ref={ctxRef}
          rows={3}
          value={context}
          placeholder="e.g. investor, Berlin, fintech"
          onChange={(e) => setContext(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <span className="rs-hint">Helps find the right person. People with the same name are never mixed up.</span>
      </label>
      {event && (
        <div className="rs-event">
          <Icon name="calendar" size={14} />
          <span className="rs-event-title">{event.eventTitle || "Calendar event"}</span>
          <button type="button" className="icon-btn sm" title="Don't link to this event" aria-label="Remove event" onClick={() => setEvent(null)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {!available && (
        <div className="rs-note">
          Research needs an Anthropic API key.{" "}
          <button type="button" className="link" onClick={() => setState({ overlay: { kind: "settings", section: "ai" } })}>
            Settings
          </button>
        </div>
      )}
      <div className="rs-actions">
        <button type="button" className="btn" onClick={() => openResearch({ view: "list" })}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!ok}>
          {busy ? "Starting…" : "Start research"}
          <kbd>↵</kbd>
        </button>
      </div>
      <div className="rs-hint">Searches the web and your mail. Public, professional info only. Takes 1 to 3 minutes.</div>
    </form>
  );
}

function ResearchReport({ id }: { id: string }) {
  const [r, setR] = useState<Research | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const multi = useApp((s) => (s.status?.accounts.length ?? 0) > 1);
  const acctEmail = useApp((s) => (r ? accountEmail(s, r.accountId) : ""));
  const now = useNow(1000, r?.status === "running");
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api
        .get<Research>("/api/research/" + encodeURIComponent(id))
        .then((x) => alive && (setR(x), setMissing(false)))
        .catch((e) => alive && e instanceof ApiError && e.status === 404 && setMissing(true));
    load();
    const off = on("researchChanged", (arg) => {
      const d = arg as { id: string; status: string };
      if (d.id === id) d.status === "deleted" ? setMissing(true) : load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [id]);
  if (missing)
    return (
      <div className="ask-body rs-body">
        <div className="ask-empty">This report no longer exists.</div>
        <button className="btn" onClick={() => openResearch({ view: "list" })}>
          All reports
        </button>
      </div>
    );
  if (!r) return <div className="ask-body rs-body shimmer small">Loading…</div>;
  const hint = NAME_SOURCE[r.nameSource];
  const secs = Math.max(0, Math.round((now - r.createdAt) / 1000));
  return (
    <div className="ask-body rs-body rs-report">
      <header className="rs-person">
        <Avatar r={r} size="lg" />
        <div className="rs-person-main">
          <h2 className="rs-name">{displayName(r)}</h2>
          {r.email && r.name && <div className="rs-email">{r.email}</div>}
          {hint && <div className="rs-name-source">{hint}</div>}
        </div>
      </header>
      <div className="rs-meta">
        {r.status === "done" && <ConfidenceChip value={r.confidence} />}
        {r.eventTitle && (
          <span className="rs-meta-item" title="Event">
            <Icon name="calendar" size={12} />
            {r.eventTitle}
          </span>
        )}
        <span className="rs-meta-item">{when(r.updatedAt || r.createdAt)}</span>
        {multi && acctEmail && <span className="rs-meta-item">{acctEmail}</span>}
      </div>
      {r.context && (
        <div className="rs-context">
          <span className="rs-k">Your context</span> {r.context}
        </div>
      )}
      {r.tldr && r.status !== "running" && (
        <div className="rs-tldr">
          <span className="rs-k">TL;DR</span>
          {r.tldr}
        </div>
      )}
      {r.status === "running" && (
        <div className="rs-running" role="status" aria-live="polite">
          <div className="rs-running-top">
            <span className="rs-live" />
            Researching
            <span className="rs-elapsed">
              {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
            </span>
          </div>
          <div className="rs-progress" title={r.progress}>
            {r.progress || "Reading mail and events…"}
          </div>
          <div className="rs-hint">You can close this panel. Iris will let you know when the report is ready.</div>
        </div>
      )}
      {r.status === "failed" && (
        <div className="rs-error">
          <strong>Research failed.</strong> {r.error || "Unknown error."}
        </div>
      )}
      {r.report && <Markdown source={r.report} className="rs-md" />}
      {r.sources.length > 0 && (
        <section className="rs-sources">
          <button className="rs-sources-toggle" aria-expanded={showSources} onClick={() => setShowSources((x) => !x)}>
            <Icon name={showSources ? "chevron-down" : "chevron-right"} size={14} />
            Sources <span className="el">{r.sources.length}</span>
          </button>
          {showSources && (
            <ol className="rs-source-list">
              {r.sources.map((s) => (
                <li key={s.url}>
                  <SourceLink url={s.url} title={s.title} />
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <div className="rs-actions rs-report-actions">
        {r.status !== "running" && (
          <button className="btn sm" onClick={() => void rerunResearch(r)} title="New search, ignores the saved report">
            <Icon name="refresh" size={14} />
            Research again
          </button>
        )}
        <span className="spacer" />
        {confirmDel ? (
          <>
            <button className="btn sm" onClick={() => setConfirmDel(false)}>
              Keep
            </button>
            <button className="btn sm btn-danger" onClick={() => void deleteResearch(r)}>
              Delete for good
            </button>
          </>
        ) : (
          <button className="btn sm" onClick={() => setConfirmDel(true)}>
            <Icon name="trash" size={14} />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function SourceLink({ url, title }: { url: string; title: string }) {
  let href: string | null = null;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") href = u.href;
  } catch {
    /* not a URL */
  }
  const host = href ? new URL(href).hostname.replace(/^www\./, "") : "";
  if (!href) return <span className="rs-source">{title || url}</span>;
  return (
    <a className="rs-source" href={href} target="_blank" rel="noopener noreferrer" title={href}>
      <span className="rs-source-title">{title || shortUrl(url)}</span>
      <span className="rs-source-host">{host}</span>
    </a>
  );
}

// ------------------------------------------------------------ meeting-start cards

export function ResearchCards() {
  const cards = useApp((s) => s.researchCards);
  const now = useNow(30_000, cards.length > 0);
  // a card stays until answered or the meeting ends
  useEffect(() => {
    for (const c of cards) if (c.end && c.end < now) dismissResearchCard(c.key);
  }, [now, cards]);
  if (!cards.length) return null;
  return (
    <div className="rs-cards" role="region" aria-label="Meeting research">
      {cards.slice(-3).map((c) => (
        <MeetingCard key={c.key} c={c} />
      ))}
    </div>
  );
}

function MeetingCard({ c }: { c: ResearchCard }) {
  const people = c.people;
  const [pick, setPick] = useState(0);
  const [name, setName] = useState(people[0]?.name ?? "");
  const [email, setEmail] = useState(people[0]?.email ?? "");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const done = c.existing.find((x) => x.status === "done");
  const running = c.existing.find((x) => x.status === "running");
  const report = done ?? running;
  useEffect(
    () =>
      on("researchCardFocus", (key) => {
        if (key !== c.key) return;
        if (report) root.current?.querySelector<HTMLButtonElement>(".btn-primary")?.focus();
        else nameRef.current?.focus();
      }),
    [c.key, report],
  );
  const choose = (i: number) => {
    setPick(i);
    setName(people[i]?.name ?? "");
    setEmail(people[i]?.email ?? "");
  };
  const ok = !!(name.trim() || email.trim()) && !busy;
  const start = async () => {
    if (!ok) return;
    setBusy(true);
    const picked = people[pick];
    const nameSource = picked && name.trim() === picked.name.trim() ? picked.nameSource : undefined; // edited → "user"
    const r = await startResearch({ name, email, context, nameSource, accountId: c.accountId, eventId: c.eventId, calendarId: c.calendarId, eventTitle: c.title });
    if (r) dismissResearchCard(c.key);
    else setBusy(false);
  };
  const primary = () => {
    if (report) {
      openResearch({ view: "report", id: report.id });
      dismissResearchCard(c.key);
    } else void start();
  };
  const title = `${c.title || "Meeting"} has started`;
  return (
    <div
      ref={root}
      className="rs-card"
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          dismissResearchCard(c.key);
        } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName !== "BUTTON" && (e.target as HTMLElement).tagName !== "SELECT") {
          e.preventDefault();
          primary();
        }
      }}
    >
      <div className="rs-card-head">
        <span className="rs-card-icon">
          <Icon name="user-search" />
        </span>
        <div className="rs-card-titles">
          <div className="rs-card-title" title={title}>
            {title}
          </div>
          <div className="rs-card-sub">{report ? (done ? "There's already a report." : "Research is already running.") : "Research needed?"}</div>
        </div>
        <button className="icon-btn sm" title="Not needed (Esc)" aria-label="Close" onClick={() => dismissResearchCard(c.key)}>
          <Icon name="x" />
        </button>
      </div>
      {report ? (
        done?.tldr && <div className="rs-card-tldr">{done.tldr}</div>
      ) : (
        <div className="rs-card-fields">
          {people.length > 1 && (
            <label className="rs-field">
              <span>Who?</span>
              <span className="select">
                <select value={pick} onChange={(e) => choose(Number(e.target.value))}>
                  {people.map((p, i) => (
                    <option key={i} value={i}>
                      {p.name && p.email ? `${p.name} (${p.email})` : personLabel(p)}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={14} />
              </span>
            </label>
          )}
          <label className="rs-field">
            <span>Name</span>
            <input ref={nameRef} value={name} placeholder={email ? "Name (optional)" : "Name"} onChange={(e) => setName(e.target.value)} />
          </label>
          {email && (
            <span className="rs-email-token" title={email}>
              <Icon name="mail" size={12} />
              <span>{email}</span>
              <button type="button" aria-label="Remove email" title="Search without email" onClick={() => setEmail("")}>
                <Icon name="x" size={12} />
              </button>
            </span>
          )}
          <label className="rs-field">
            <span>What do you already know?</span>
            <input value={context} placeholder="e.g. investor, Berlin, fintech" onChange={(e) => setContext(e.target.value)} />
          </label>
        </div>
      )}
      <div className="rs-actions">
        <button className="btn" onClick={() => dismissResearchCard(c.key)}>
          {report ? "Close" : "Not needed"}
          <kbd>esc</kbd>
        </button>
        <button className="btn-primary" disabled={!report && !ok} onClick={primary}>
          {report ? (done ? "Open report" : "View") : busy ? "Starting…" : "Start research"}
          <kbd>↵</kbd>
        </button>
      </div>
    </div>
  );
}

/** "Research" for the contact panel: opens the report if one exists, else the prefilled form */
export function ResearchDraftButton({ draft, className = "contact-all", label = "Research" }: { draft: Partial<ResearchDraft>; className?: string; label?: string }) {
  return (
    <button className={className} onClick={() => void researchPerson(draft)}>
      <Icon name="user-search" size={12} />
      {label}
    </button>
  );
}
