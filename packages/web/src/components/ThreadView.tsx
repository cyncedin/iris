import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, Thread } from "@iris/core/types.ts";
import { api, attachmentUrl } from "../api";
import { on } from "../bus";
import { accountColor, accountEmail, act, closeThread, errorToast, openGoals, refOf, setState, startReply, useApp, type ComposeState, type Theme } from "../state";
import { avatarColor, fmtSize, fullTime, futureTime, initials, nameOf } from "../util";
import { syncInvite } from "../cal";
import { Composer } from "./Composer";
import { EmailFrame } from "./EmailFrame";
import { Icon } from "./Icon";
import { InviteCard } from "./InviteCard";

interface Summary {
  tldr: string;
  bullets: string[];
  action_items: string[];
  needs_reply: boolean;
}

interface Translation {
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
}

function Avatar({ m, size = 32 }: { m: { name: string; email: string }; size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, background: avatarColor(m.email), fontSize: size * 0.38 }}>
      {initials(m)}
    </div>
  );
}

function MessageItem({ m, expanded, focused, onToggle, theme, blockImages, me, aiAvailable }: { m: Message; expanded: boolean; focused: boolean; onToggle: () => void; theme: Theme; blockImages: boolean; me: string; aiAvailable: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const translate = async () => {
    if (translating) return;
    if (translation) return setShowTranslation((v) => !v);
    setTranslating(true);
    try {
      setTranslation(await api.post<Translation>("/api/ai/translate", { account: m.accountId, threadId: m.threadId, messageId: m.id }));
      setShowTranslation(true);
    } catch (e) {
      errorToast(e);
    } finally {
      setTranslating(false);
    }
  };
  useEffect(() => on("translate", () => void (focused && translate())), [focused, translation, translating]);
  // the translation is plain text, rendered through the same sandboxed frame as the original
  const shown = useMemo(() => (showTranslation && translation ? { ...m, bodyHtml: "", bodyText: translation.text } : m), [m, showTranslation, translation]);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  const atts = m.attachments.filter((a) => !a.inline);
  const recipients = [...m.to, ...m.cc].map((a) => (a.email === me ? "me" : nameOf(a))).join(", ");
  if (!expanded) {
    return (
      <div ref={ref} className={`msg collapsed${focused ? " focused" : ""}`} onClick={onToggle}>
        <Avatar m={m.from} size={24} />
        <span className="msg-from">{m.from.email === me ? "me" : nameOf(m.from)}</span>
        <span className="msg-snippet">{m.isDraft ? <em className="draft-label">Draft</em> : m.snippet}</span>
        <span className="msg-date">{fullTime(m.date)}</span>
      </div>
    );
  }
  return (
    <div ref={ref} className={`msg${focused ? " focused" : ""}`}>
      <div className="msg-head" onClick={onToggle}>
        <Avatar m={m.from} />
        <div className="msg-who">
          <div>
            <span className="msg-from">{m.from.email === me ? "me" : nameOf(m.from)}</span>
            {m.from.email !== me && (
              <span className="msg-email" title={m.from.email}>
                {m.from.email}
              </span>
            )}
            {m.isDraft && <span className="tag draft">Draft</span>}
          </div>
          <div className="msg-to" title={recipients}>
            to {recipients || "—"}
          </div>
        </div>
        <span className="msg-date">{fullTime(m.date)}</span>
        {aiAvailable && !m.isDraft && (
          <button
            className={`icon-btn sm msg-translate${showTranslation ? " on" : ""}`}
            title={showTranslation ? "Show original (⇧T)" : "Translate (⇧T)"}
            aria-label={showTranslation ? "Show original" : "Translate message"}
            aria-pressed={showTranslation}
            disabled={translating}
            onClick={(e) => {
              e.stopPropagation();
              void translate();
            }}
          >
            <Icon name="languages" size={14} />
          </button>
        )}
      </div>
      {translating && <div className="msg-translation shimmer">Translating…</div>}
      {showTranslation && translation && (
        <div className="msg-translation">
          <Icon name="languages" size={14} />
          <span>
            {translation.sourceLanguage.toLowerCase() === translation.targetLanguage.toLowerCase() ? `Already in ${translation.targetLanguage}` : `Translated from ${translation.sourceLanguage}`}
          </span>
          <button className="link small" onClick={() => setShowTranslation(false)}>
            Show original
          </button>
        </div>
      )}
      <div className="msg-body">
        <EmailFrame message={shown} theme={theme} blockImages={blockImages} />
      </div>
      {atts.length > 0 && (
        <div className="atts">
          {atts.map((a) => (
            <a key={a.id} className="att" href={attachmentUrl(m.id, a.id, !/^(image|application\/pdf)/.test(a.mimeType), m.accountId)} target="_blank" rel="noreferrer">
              <span className="att-icon">{/pdf/.test(a.mimeType) ? "PDF" : /image/.test(a.mimeType) ? "IMG" : (a.filename.split(".").pop() ?? "FILE").slice(0, 4).toUpperCase()}</span>
              <span className="att-name">{a.filename}</span>
              <span className="att-size">{fmtSize(a.size)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ thread, aiAvailable }: { thread: Thread; aiAvailable: boolean }) {
  const [state, setLocal] = useState<{ loading: boolean; data?: Summary; error?: string }>({ loading: false });
  const run = async (force = false) => {
    setLocal({ loading: true });
    try {
      const data = await api.post<Summary>("/api/ai/summarize", { account: thread.accountId, threadId: thread.id, force });
      setLocal({ loading: false, data });
    } catch (e) {
      setLocal({ loading: false });
      errorToast(e);
    }
  };
  useEffect(() => on("summarize", () => void run(!!state.data)), [thread.id, state.data]);
  useEffect(() => setLocal({ loading: false }), [thread.id]);
  if (!state.loading && !state.data) {
    return aiAvailable ? (
      <button className="btn sm ai-hint" onClick={() => void run()}>
        <Icon name="sparkles" size={14} className="sparkle" />
        Summarize <kbd>I</kbd>
      </button>
    ) : null;
  }
  return (
    <div className="summary">
      {state.loading ? (
        <div className="shimmer">Summarizing…</div>
      ) : (
        state.data && (
          <>
            <div className="summary-tldr">
              <Icon name="sparkles" size={14} className="sparkle" />
              <span>{state.data.tldr}</span>
            </div>
            {state.data.bullets.length > 0 && (
              <ul>
                {state.data.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
            {state.data.action_items.length > 0 && (
              <div className="summary-todo">
                {state.data.action_items.map((b, i) => (
                  <div key={i}>
                    <Icon name="square" size={14} />
                    <span>{b}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

function InstantReplies({ thread, compose }: { thread: Thread; compose: ComposeState | null }) {
  const [opts, setOpts] = useState<{ label: string; html: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => setOpts(null), [thread.id]);
  if (compose) return null;
  const load = async () => {
    setLoading(true);
    try {
      setOpts(await api.post<{ label: string; html: string }[]>("/api/ai/replies", { account: thread.accountId, threadId: thread.id }));
    } catch (e) {
      errorToast(e);
    } finally {
      setLoading(false);
    }
  };
  const use = async (html: string) => {
    await startReply("replyAll");
    setState((s) => (s.compose ? { compose: { ...s.compose, html } } : {}));
  };
  return (
    <div className="instant">
      {opts ? (
        opts.map((o) => (
          <button key={o.label} className="chip" onClick={() => void use(o.html)}>
            <Icon name="sparkles" size={12} className="sparkle" />
            {o.label}
          </button>
        ))
      ) : (
        <button className="chip ghost" disabled={loading} onClick={() => void load()}>
          <Icon name="sparkles" size={12} className="sparkle" />
          {loading ? "Thinking…" : "Suggest replies"}
        </button>
      )}
    </div>
  );
}

export function ThreadView() {
  const thread = useApp((s) => s.thread);
  const openId = useApp((s) => s.openId);
  const theme = useApp((s) => s.theme);
  const compose = useApp((s) => s.compose);
  const blockImages = useApp((s) => !!s.status?.settings.blockRemoteImages);
  const aiAvailable = useApp((s) => !!s.status?.ai.available);
  // "me" is the thread's own account (unified lists mix accounts)
  const me = useApp((s) => s.thread?.accountId ?? s.openAccount ?? "");
  const acct = useApp((s) => ((s.status?.accounts.length ?? 0) > 1 && s.thread ? { color: accountColor(s, s.thread.accountId), email: accountEmail(s, s.thread.accountId) } : null));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const goals = useApp((s) => s.goals);
  const scroller = useRef<HTMLDivElement>(null);

  const msgs = thread?.messages.filter((m) => !m.isDraft || !compose || compose.threadId !== thread.id) ?? [];

  // an invite opens the day pane on its date and shows up there as a pseudo-event
  useEffect(() => {
    if (thread) syncInvite(thread);
  }, [thread]);
  useEffect(() => () => syncInvite(null), []);

  useEffect(() => {
    if (!thread) return;
    // unread + latest expanded, others collapsed
    const ex = new Set<string>();
    thread.messages.forEach((m, i) => {
      if (i === thread.messages.length - 1 || m.labelIds.includes("UNREAD")) ex.add(m.id);
    });
    setExpanded(ex);
    setFocus(thread.messages.length - 1);
    scroller.current?.scrollTo({ top: 0 });
  }, [thread?.id]);

  useEffect(() => {
    if (!thread) return;
    const offs = [
      on("expandAll", () => setExpanded((ex) => (ex.size === thread.messages.length ? new Set([thread.messages[thread.messages.length - 1].id]) : new Set(thread.messages.map((m) => m.id))))),
      on("expandFocused", () => {
        const m = msgs[focus];
        if (m) setExpanded((ex) => (ex.has(m.id) ? new Set([...ex].filter((x) => x !== m.id)) : new Set([...ex, m.id])));
      }),
      on("translate", () => {
        const m = msgs[focus];
        if (m) setExpanded((ex) => new Set([...ex, m.id]));
      }),
      on("focusMessage", (d) => setFocus((f) => Math.max(0, Math.min(msgs.length - 1, f + (d as number))))),
      on("scroll", (d) => scroller.current?.scrollBy({ top: (d as number) * scroller.current.clientHeight * 0.8, behavior: "smooth" })),
    ];
    return () => offs.forEach((o) => o());
  }, [thread, focus, msgs.length]);

  if (!openId) return null;
  if (!thread) return <div className="thread loading"><div className="shimmer">Loading…</div></div>;

  const labels = thread.labelIds.filter((l) => !["INBOX", "UNREAD", "IMPORTANT", "SENT", "DRAFT", "STARRED", "CATEGORY_PERSONAL", "CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"].includes(l));
  const linkedGoals = goals.filter((g) => g.threads.some((t) => t.accountId === thread.accountId && t.threadId === thread.id));
  return (
    <div className="thread" ref={scroller}>
      <div className="thread-inner">
        <div className="thread-top">
          <button className="icon-btn back" title="Back (Esc)" aria-label="Back" onClick={closeThread}>
            <Icon name="arrow-left" />
          </button>
          <div className="thread-actions">
            <button className="icon-btn" title="Done (E)" aria-label="Done" onClick={() => void act("done")}>
              <Icon name="check" />
            </button>
            <button className="icon-btn" title="Remind me (H)" aria-label="Remind me" onClick={() => setState({ overlay: { kind: "remind", refs: [refOf(thread)] } })}>
              <Icon name="alarm" />
            </button>
            <button className={`icon-btn${thread.starred ? " star" : ""}`} title={thread.starred ? "Unstar (S)" : "Star (S)"} aria-label="Star" aria-pressed={thread.starred} onClick={() => void act("toggleStar")}>
              <Icon name="star" filled={thread.starred} />
            </button>
            <button className="icon-btn" title="Label (L)" aria-label="Label" onClick={() => setState({ overlay: { kind: "label", mode: "add", refs: [refOf(thread)] } })}>
              <Icon name="tag" />
            </button>
            <button className="icon-btn" title="Link to goal (⇧G)" aria-label="Link to goal" onClick={() => setState({ overlay: { kind: "goal", refs: [refOf(thread)] } })}>
              <Icon name="target" />
            </button>
            <button className="icon-btn" title="Trash (#)" aria-label="Trash" onClick={() => void act("trash")}>
              <Icon name="trash" />
            </button>
          </div>
        </div>
        <h1 className="subject">{thread.subject || "(no subject)"}</h1>
        <div className="thread-labels">
          {acct && (
            <span className="tag acct-tag" title={`In ${acct.email}`}>
              <span className="acct-dot" style={{ "--acct": acct.color } as React.CSSProperties} />
              {acct.email}
            </span>
          )}
          {thread.starred && (
            <span className="tag star-tag">
              <Icon name="star" size={12} filled />
              Starred
            </span>
          )}
          {thread.reminder && (
            <span className="tag remind">
              <Icon name="alarm" size={12} />
              {futureTime(thread.reminder.remindAt)}
              {thread.reminder.ifNoReply ? " if no reply" : ""}
            </span>
          )}
          {linkedGoals.map((g) => (
            <button key={g.id} className="tag goal-tag" title={`${g.progress.percent}% done. Open goals`} onClick={() => openGoals()}>
              <Icon name="target" size={12} />
              {g.title}
            </button>
          ))}
          {labels.map((l) => (
            <LabelChip key={l} id={l} account={thread.accountId} />
          ))}
          {thread.aiLabels?.map((l) => (
            <span key={l} className="tag ai">
              <Icon name="sparkles" size={12} className="sparkle" />
              {l}
            </span>
          ))}
          {thread.listId && (
            <button className="btn sm" onClick={() => document.dispatchEvent(new CustomEvent("iris-command", { detail: "unsubscribe" }))}>
              Unsubscribe
            </button>
          )}
        </div>
        <SummaryCard thread={thread} aiAvailable={aiAvailable} />
        {thread.invite && <InviteCard thread={thread} />}
        <div className="messages">
          {msgs.map((m, i) => (
            <MessageItem
              key={m.id}
              m={m}
              me={me}
              expanded={expanded.has(m.id)}
              focused={i === focus}
              theme={theme}
              blockImages={blockImages}
              aiAvailable={aiAvailable}
              onToggle={() => {
                setFocus(i);
                setExpanded((ex) => (ex.has(m.id) ? new Set([...ex].filter((x) => x !== m.id)) : new Set([...ex, m.id])));
              }}
            />
          ))}
        </div>
        {compose && !compose.popped && compose.threadId === thread.id && (compose.threadAccount ?? compose.accountId) === thread.accountId ? (
          <Composer compose={compose} inline />
        ) : (
          <div className="reply-bar">
            <button className="btn" onClick={() => void startReply("replyAll")}>
              <Icon name="reply-all" />
              Reply all <kbd>↵</kbd>
            </button>
            <button className="btn" onClick={() => void startReply("reply")}>
              <Icon name="reply" />
              Reply <kbd>R</kbd>
            </button>
            <button className="btn" onClick={() => void startReply("forward")}>
              <Icon name="forward" />
              Forward <kbd>F</kbd>
            </button>
            {aiAvailable && <InstantReplies thread={thread} compose={compose} />}
          </div>
        )}
      </div>
    </div>
  );
}

function LabelChip({ id, account }: { id: string; account: string }) {
  const label = useApp((s) => s.labelsBy[account]?.find((l) => l.id === id));
  if (!label || label.name.startsWith("Iris/")) return null;
  return <span className="tag label">{label.name}</span>;
}
