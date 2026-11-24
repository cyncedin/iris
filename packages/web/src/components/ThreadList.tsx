import { useEffect, useRef } from "react";
import type { ThreadSummary } from "@iris/core/types.ts";
import { api } from "../api";
import { accountColor, accountEmail, act, ALL, errorToast, keyOf, loadMoreList, NO_LABEL, openThread, refOf, routeTitle, setHiddenLabels, setState, toggleSelect, useApp } from "../state";
import { futureTime, nameOf, relTime } from "../util";
import { Icon } from "./Icon";

function senders(t: ThreadSummary, me: string): string {
  const others = t.participants.filter((p) => p.email !== me);
  const list = others.length ? others : t.participants;
  if (t.labelIds.includes("SENT") && !others.length) return "me";
  const names = list.slice(0, 3).map((p) => nameOf(p).split(" ")[0]);
  return list.length === 1 ? nameOf(list[0]) : names.join(", ");
}

function Row({ t, i, active, selected, account }: { t: ThreadSummary; i: number; active: boolean; selected: boolean; account?: { color: string; email: string } }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const draft = t.hasDraft;
  const from = senders(t, t.accountId);
  const subject = t.subject || "(no subject)";
  return (
    <div
      ref={ref}
      className={`row${active ? " active" : ""}${selected ? " selected" : ""}${t.unread ? " unread" : ""}`}
      onMouseMove={() => !active && setState({ cursor: i })}
      onClick={(e) => {
        if (e.metaKey || e.shiftKey) toggleSelect(t);
        else void openThread(t.id, t.accountId);
      }}
    >
      <div
        className="row-check"
        title={selected ? "Deselect (X)" : "Select (X)"}
        onClick={(e) => {
          e.stopPropagation();
          toggleSelect(t);
        }}
      >
        {t.unread && !selected && <span className="dot" aria-label="Unread" />}
        <span className={`check${selected ? " on" : ""}`}>
          <Icon name="check" size={12} stroke={2} />
        </span>
      </div>
      <div className="row-from">
        <span className="row-from-name" title={from}>
          {from}
        </span>
        {t.messageCount > 1 && <span className="count">{t.messageCount}</span>}
      </div>
      <div className="row-main">
        {draft && <span className="tag draft">Draft</span>}
        {t.returnedAt && !t.reminder && <span className="tag returned">Reminder</span>}
        <span className="row-subject" title={subject}>
          {subject}
        </span>
        <span className="row-snippet">{t.snippet}</span>
      </div>
      <div className="row-meta">
        {t.aiLabels?.slice(0, 2).map((l) => (
          <span key={l} className="tag ai">
            {l}
          </span>
        ))}
        {t.hasAttachments && (
          <span className="clip" title="Attachment">
            <Icon name="paperclip" size={14} />
          </span>
        )}
        {t.starred && (
          <span className="star" title="Starred">
            <Icon name="star" size={14} filled />
          </span>
        )}
        {account && (
          // unified routes: which account the conversation lives in
          <span className="row-acct" style={{ "--acct": account.color } as React.CSSProperties} title={account.email} aria-label={account.email}>
            {(account.email[0] ?? "?").toUpperCase()}
          </span>
        )}
        {t.reminder ? (
          <span className="row-date reminder" title={`Reminder ${futureTime(t.reminder.remindAt)}`}>
            <Icon name="alarm" size={12} />
            {futureTime(t.reminder.remindAt)}
          </span>
        ) : (
          <span className="row-date">{relTime(t.lastDate)}</span>
        )}
      </div>
      <div className="row-hover">
        <button title="Done (E)" aria-label="Done" onClick={(e) => (e.stopPropagation(), void act("done", { refs: [refOf(t)] }))}>
          <Icon name="check" />
        </button>
        <button title="Remind me (H)" aria-label="Remind me" onClick={(e) => (e.stopPropagation(), setState({ overlay: { kind: "remind", refs: [refOf(t)] } }))}>
          <Icon name="alarm" />
        </button>
        <button title={t.starred ? "Unstar (S)" : "Star (S)"} aria-label="Star" className={t.starred ? "star" : undefined} onClick={(e) => (e.stopPropagation(), void act("toggleStar", { refs: [refOf(t)] }))}>
          <Icon name="star" filled={t.starred} />
        </button>
        <button title="Trash (#)" aria-label="Trash" onClick={(e) => (e.stopPropagation(), void act("trash", { refs: [refOf(t)] }))}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

/** All Mail: one checkbox per AI label. Unchecking hides mail that has only unchecked labels. */
function LabelFilter() {
  const data = useApp((s) => s.mailboxLabels);
  const hidden = useApp((s) => s.hiddenLabels);
  const account = useApp((s) => s.route.account);
  const shown = useApp((s) => s.total);
  const coverage = useApp((s) => s.mailboxCoverage);
  if (!data) return null;
  const rows = [...data.labels.map((l) => ({ id: l.name, name: l.name, count: l.count })), { id: NO_LABEL, name: "No label", count: data.unlabeled }].filter((r) => r.count > 0 || hidden.includes(r.id));
  const left = coverage.reduce((n, c) => n + c.left, 0);
  const loading = coverage.some((c) => c.backfill === "running");
  const missing = coverage.filter((c) => c.backfill === "idle").reduce((n, c) => n + Math.max(0, (c.gmail ?? c.local) - c.local), 0);
  return (
    <fieldset className="label-filter">
      <legend className="label-filter-head">
        <span className="tnum">
          {shown.toLocaleString()} of {data.total.toLocaleString()} shown
        </span>
        <button type="button" className="link small" onClick={() => setHiddenLabels([])}>
          All
        </button>
        <button type="button" className="link small" onClick={() => setHiddenLabels(rows.map((r) => r.id))}>
          None
        </button>
      </legend>
      <div className="label-filter-rows">
        {rows.map((r) => (
          <label key={r.id} className="label-check">
            <input
              type="checkbox"
              checked={!hidden.includes(r.id)}
              onChange={(e) => {
                setHiddenLabels(e.target.checked ? hidden.filter((h) => h !== r.id) : [...hidden, r.id]);
                e.target.blur(); // hand the keyboard back to the list
              }}
            />
            <span>{r.name}</span>
            <span className="label-check-count tnum">{r.count.toLocaleString()}</span>
          </label>
        ))}
      </div>
      {loading ? (
        <p className="label-filter-note">Loading older conversations{left ? `: ${left.toLocaleString()} left` : "…"}</p>
      ) : (
        missing > 0 && (
          <p className="label-filter-note">
            {missing.toLocaleString()} older conversations are only in Gmail.{" "}
            <button type="button" className="link small" onClick={() => void api.post("/api/mailbox/backfill", { account }).catch(errorToast)}>
              Load all
            </button>
          </p>
        )
      )}
    </fieldset>
  );
}

/** Loads the next page as the end of the list comes into view. */
function MoreSentinel() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting) void loadMoreList();
    });
    io.observe(el);
    return () => io.disconnect();
  });
  return <div ref={ref} className="list-more" aria-hidden />;
}

export function ThreadList() {
  const allMail = useApp((s) => s.route.view === "all");
  return (
    <>
      {allMail && <LabelFilter />}
      <Threads />
    </>
  );
}

function Threads() {
  const threads = useApp((s) => s.threads);
  const total = useApp((s) => s.total);
  const hiddenCount = useApp((s) => s.hiddenLabels.length);
  const cursor = useApp((s) => s.cursor);
  const selected = useApp((s) => s.selected);
  const loading = useApp((s) => s.loading);
  const route = useApp((s) => s.route);
  const splits = useApp((s) => s.splits);
  const filter = useApp((s) => s.filter);
  const unified = useApp((s) => s.route.account === ALL && (s.status?.accounts.length ?? 0) > 1);
  const acctOf = useApp((s) => (id: string) => ({ color: accountColor(s, id), email: accountEmail(s, id) }));

  if (!loading && !threads.length) {
    const inbox = route.view === "inbox";
    return (
      <div className={`empty${inbox && !filter ? " zero" : ""}`}>
        {inbox && !filter ? (
          <>
            <h2>
              You're done with {route.account === ALL && unified ? "All Inboxes · " : ""}
              {routeTitle(route, splits)}
            </h2>
            <p>Inbox Zero. Enjoy the calm.</p>
          </>
        ) : (
          <>
            <h2>Nothing here</h2>
            <p>{route.view === "all" && hiddenCount ? "No conversations with the checked labels." : filter ? `No ${filter} conversations in ${routeTitle(route, splits)}.` : `${routeTitle(route, splits)} is empty.`}</p>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="list" role="list">
      {selected.length > 0 && (
        <div className="bulkbar">
          <strong>{selected.length} selected</strong> · <kbd>E</kbd> done · <kbd>H</kbd> remind · <kbd>#</kbd> trash · <kbd>L</kbd> label ·{" "}
          <button className="link" onClick={() => setState({ selected: [] })}>
            Clear <kbd>Esc</kbd>
          </button>
        </div>
      )}
      {threads.map((t, i) => (
        <Row key={keyOf(t)} t={t} i={i} active={i === cursor} selected={selected.includes(keyOf(t))} account={unified ? acctOf(t.accountId) : undefined} />
      ))}
      {threads.length < total && <MoreSentinel />}
      {loading && !threads.length && <div className="loading-rows">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" />)}</div>}
    </div>
  );
}
