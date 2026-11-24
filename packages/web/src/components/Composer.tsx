import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Address, Contact, Snippet } from "@iris/core/types.ts";
import { api, streamWrite } from "../api";
import { on } from "../bus";
import { startAvailability } from "../cal";
import { comboOf, isMac, keyCaps } from "../keys";
import {
  ALL,
  closeCompose,
  composeHtml,
  composeKeepsThread,
  discardCompose,
  errorToast,
  getState,
  registerEditor,
  registerInserter,
  saveDraft,
  sendCompose,
  setComposeFrom,
  setState,
  useApp,
  type ComposeState,
} from "../state";
import { avatarColor, escapeHtml, fileToBase64, fmtSize, fuzzy, initials, isEmail, nameOf, parseAddresses } from "../util";
import { Icon } from "./Icon";
import { AccountDot } from "./Overlays";

function patch(c: ComposeState, p: Partial<ComposeState>) {
  setState((s) => (s.compose?.key === c.key ? { compose: { ...s.compose, ...p } } : {}));
}

export function RecipientInput({ label, value, onChange, autoFocus, inputRef }: { label: string; value: Address[]; onChange: (v: Address[]) => void; autoFocus?: boolean; inputRef?: React.RefObject<HTMLInputElement | null> }) {
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [idx, setIdx] = useState(0);
  const local = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? local;
  useEffect(() => {
    if (!text.trim()) return setSugg([]);
    const t = setTimeout(async () => {
      try {
        // unified daemons merge every account's contacts
        const r = await api.get<Contact[]>("/api/contacts", { account: getState().unified ? ALL : undefined, q: text.trim(), limit: 6 });
        setSugg(r.filter((c) => !value.some((v) => v.email === c.email)));
        setIdx(0);
      } catch {
        /* ignore */
      }
    }, 80);
    return () => clearTimeout(t);
  }, [text]);
  const add = (a: Address[]) => {
    const fresh = a.filter((x) => x.email && !value.some((v) => v.email === x.email));
    if (fresh.length) onChange([...value, ...fresh]);
    setText("");
    setSugg([]);
  };
  const commitText = () => {
    const parsed = parseAddresses(text).filter((a) => isEmail(a.email));
    if (parsed.length) add(parsed);
  };
  return (
    <div className="field" onClick={() => ref.current?.focus()}>
      <span className="field-label">{label}</span>
      <div className="chips">
        {value.map((a) => (
          <span key={a.email} className={`rchip${isEmail(a.email) ? "" : " bad"}`} title={a.email}>
            {nameOf(a)}
            <button tabIndex={-1} aria-label={`Remove ${a.email}`} onClick={() => onChange(value.filter((v) => v.email !== a.email))}>
              <Icon name="x" size={12} stroke={2} />
            </button>
          </span>
        ))}
        <input
          ref={ref}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) {
              setText(v.replace(/[,;]\s*$/, ""));
              const parsed = parseAddresses(v).filter((a) => isEmail(a.email));
              if (parsed.length) add(parsed);
            } else setText(v);
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (/[,;\n]/.test(t)) {
              e.preventDefault();
              add(parseAddresses(t).filter((a) => isEmail(a.email)));
            }
          }}
          onBlur={() => setTimeout(commitText, 120)}
          onKeyDown={(e) => {
            if (sugg.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + sugg.length) % sugg.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && sugg.length && text) {
              e.preventDefault();
              const c = sugg[idx];
              add([{ name: c.name, email: c.email }]);
            } else if ((e.key === "Enter" || e.key === "Tab") && text) {
              if (isEmail(text.replace(/.*</, "").replace(/>.*/, ""))) {
                e.preventDefault();
                commitText();
              }
            } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
        />
      </div>
      {sugg.length > 0 && text && (
        <div className="suggest" role="listbox">
          {sugg.map((c, i) => (
            <div key={c.email} className={`sugg${i === idx ? " on" : ""}`} onMouseDown={(e) => (e.preventDefault(), add([{ name: c.name, email: c.email }]))}>
              <span className="avatar sm" style={{ background: avatarColor(c.email) }}>
                {initials(c)}
              </span>
              <span className="sugg-name">{c.name || c.email}</span>
              <span className="sugg-email">{c.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "From" (Apple Mail's From field): which account sends. Only shown with more than one account.
 * Replies default to the thread's account; picking another one starts a new conversation from there.
 */
function FromField({ compose }: { compose: ComposeState }) {
  const accounts = useApp((s) => s.status?.accounts ?? []);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  if (accounts.length < 2) return null;
  const curIdx = Math.max(0, accounts.findIndex((a) => a.id === compose.accountId));
  const cur = accounts[curIdx];
  const moved = !composeKeepsThread(compose);
  const pick = (id: string) => {
    setOpen(false);
    setComposeFrom(id);
    btn.current?.focus();
  };
  const show = () => {
    setIdx(curIdx);
    setOpen(true);
  };
  return (
    <div className="field from-field">
      <span className="field-label">From</span>
      <div
        className="from-wrap"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <button
          ref={btn}
          type="button"
          className="from-btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Send from another account"
          onClick={() => (open ? setOpen(false) : show())}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              if (!open) return show();
              setIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + accounts.length) % accounts.length);
            } else if (open && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              e.stopPropagation();
              pick(accounts[idx].id);
            } else if (open && e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <AccountDot id={cur.id} />
          <span className="from-name">{cur.name ? `${cur.name} – ${cur.email}` : cur.email}</span>
          <Icon name="chevron-down" size={12} />
        </button>
        {moved && <span className="from-note">New conversation from this account</span>}
        {open && (
          <div className="from-menu" role="listbox" aria-label="From">
            {accounts.map((a, i) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={a.id === cur.id}
                tabIndex={-1}
                className={`from-item${i === idx ? " on" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== idx && setIdx(i)}
                onClick={() => pick(a.id)}
              >
                <AccountDot id={a.id} />
                <span className="from-name">{a.email}</span>
                {a.id === cur.id && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function textToParagraphs(t: string): string {
  return t
    .split(/\n{2,}/)
    .map((p) => `<div>${escapeHtml(p).replace(/\n/g, "<br>")}</div>`)
    .join("<div><br></div>");
}

export function Composer({ compose, inline }: { compose: ComposeState; inline?: boolean }) {
  const editor = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [ai, setAi] = useState<{ open: boolean; text: string; busy: boolean }>({ open: false, text: "", busy: false });
  const aiAbort = useRef<AbortController | null>(null);
  const [snip, setSnip] = useState<{ q: string; items: Snippet[]; idx: number; inline: boolean } | null>(null);
  const [showSubject, setShowSubject] = useState(compose.mode === "new" || compose.mode === "forward");
  const [dirty, setDirty] = useState(0);
  const aiAvailable = useApp((s) => !!s.status?.ai.available);
  const undoSecs = useApp((s) => s.status?.settings.undoSendSeconds ?? 10);

  // editor content is uncontrolled; seed it once per compose (and when AI / instant reply replaces it)
  useLayoutEffect(() => {
    if (editor.current && editor.current.innerHTML !== compose.html) editor.current.innerHTML = compose.html;
  }, [compose.key, compose.html]);
  useEffect(() => registerEditor(compose.key, () => editor.current?.innerHTML ?? ""), [compose.key]);

  // remember the caret so "Share availability" (⌘⇧A) inserts where the user was typing
  const lastRange = useRef<Range | null>(null);
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (sel?.rangeCount && editor.current?.contains(sel.anchorNode)) lastRange.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);
  useEffect(
    () =>
      registerInserter(compose.key, (html) => {
        const el = editor.current;
        if (!el) return;
        el.focus();
        const sel = window.getSelection();
        const r = lastRange.current;
        if (sel && r && el.contains(r.startContainer)) {
          sel.removeAllRanges();
          sel.addRange(r);
        } else placeCaretAtStart(el);
        document.execCommand("insertHTML", false, html);
        setDirty((d) => d + 1);
      }),
    [compose.key],
  );
  useEffect(() => {
    const needsTo = !compose.to.length && compose.mode !== "reply" && compose.mode !== "replyAll";
    if (needsTo) toRef.current?.focus();
    else {
      editor.current?.focus();
      placeCaretAtStart(editor.current);
    }
  }, [compose.key]);

  // autosave as a Gmail draft
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      const cur = getState().compose;
      if (cur?.key === compose.key) void saveDraft(cur);
    }, 2500);
    return () => clearTimeout(t);
  }, [dirty, compose.to, compose.cc, compose.bcc, compose.subject, compose.accountId]);

  useEffect(() => on("aiPrompt", () => setAi((a) => ({ ...a, open: true }))), []);

  const runAi = async () => {
    if (!ai.text.trim() && !compose.threadId) return;
    const current = editor.current?.innerText.trim() ?? "";
    aiAbort.current = new AbortController();
    setAi((a) => ({ ...a, busy: true }));
    let acc = "";
    try {
      const r = await streamWrite(
        {
          account: compose.accountId || undefined,
          instruction: ai.text,
          threadId: compose.mode === "forward" || !composeKeepsThread(compose) ? undefined : compose.threadId,
          draft: current || undefined,
          to: compose.to.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ") || undefined,
        },
        (d) => {
          acc += d;
          if (editor.current) editor.current.innerHTML = textToParagraphs(acc.replace(/^subject:.*\n+/i, ""));
        },
        aiAbort.current.signal,
      );
      if (editor.current) editor.current.innerHTML = r.html;
      if (r.subject && !compose.subject) {
        patch(compose, { subject: r.subject });
        setShowSubject(true);
      }
      setAi({ open: false, text: "", busy: false });
      setDirty((d) => d + 1);
      editor.current?.focus();
    } catch (e) {
      setAi((a) => ({ ...a, busy: false }));
      if ((e as Error).name !== "AbortError") errorToast(e);
    }
  };

  const openSnippets = async (inline: boolean, q = "") => {
    try {
      const items = await api.get<Snippet[]>("/api/snippets");
      if (!items.length) {
        setState({ overlay: { kind: "settings", section: "snippets" } });
        return;
      }
      setSnip({ q, items, idx: 0, inline });
    } catch (e) {
      errorToast(e);
    }
  };

  const insertSnippet = async (s: Snippet) => {
    try {
      const to = compose.to.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
      const x = await api.post<Snippet>(`/api/snippets/${s.id}/expand`, { to });
      editor.current?.focus();
      if (snip?.inline) deleteBeforeCaret(snip.q.length + 1);
      document.execCommand("insertHTML", false, x.html);
      if (x.subject && !compose.subject) {
        patch(compose, { subject: x.subject });
        setShowSubject(true);
      }
      const extra = { to: parseAddresses(x.to), cc: parseAddresses(x.cc), bcc: parseAddresses(x.bcc) };
      if (extra.to.length || extra.cc.length || extra.bcc.length)
        patch(compose, {
          to: [...compose.to, ...extra.to.filter((a) => !compose.to.some((b) => b.email === a.email))],
          cc: [...compose.cc, ...extra.cc],
          bcc: [...compose.bcc, ...extra.bcc],
          showCc: compose.showCc || !!extra.cc.length,
          showBcc: compose.showBcc || !!extra.bcc.length,
        });
      setDirty((d) => d + 1);
    } catch (e) {
      errorToast(e);
    }
    setSnip(null);
  };

  const filteredSnips = snip ? snip.items.map((s) => ({ s, score: fuzzy(snip.q, s.name) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.s) : [];

  const onKeyDown = (e: React.KeyboardEvent) => {
    const combo = comboOf(e.nativeEvent);
    if (!combo) return;
    if (snip && ["up", "down", "enter", "tab", "esc"].includes(combo)) {
      e.preventDefault();
      e.stopPropagation();
      if (combo === "esc") setSnip(null);
      else if (combo === "up" || combo === "down") setSnip({ ...snip, idx: (snip.idx + (combo === "down" ? 1 : -1) + filteredSnips.length) % Math.max(1, filteredSnips.length) });
      else if (filteredSnips[snip.idx]) void insertSnippet(filteredSnips[snip.idx]);
      return;
    }
    const run = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    switch (combo) {
      case "mod+enter":
        return run(() => void sendCompose());
      case "mod+shift+enter":
        return run(() => void sendCompose({ markDone: true }));
      case "mod+shift+z":
        return run(() => void sendCompose({ instant: true }));
      case "mod+shift+l":
        return run(() => setState({ overlay: { kind: "sendLater" } }));
      case "mod+shift+,":
      case "mod+shift+.":
        return run(() => void discardCompose());
      case "mod+j":
        return run(() => setAi((a) => ({ ...a, open: !a.open })));
      case "mod+;":
        return run(() => void openSnippets(false));
      case "mod+shift+c":
        return run(() => patch(compose, { showCc: true }));
      case "mod+shift+b":
        return run(() => patch(compose, { showBcc: true }));
      case "mod+shift+o":
        return run(() => toRef.current?.focus());
      case "mod+shift+s":
        return run(() => {
          setShowSubject(true);
          setTimeout(() => subjectRef.current?.focus(), 0);
        });
      case "mod+shift+u":
        return run(() => fileRef.current?.click());
      case "mod+k":
        return run(() => setState({ overlay: { kind: "palette" } }));
      case "mod+shift+a":
        return run(() => {
          const cur = getState().compose;
          if (cur) void saveDraft({ ...cur, html: composeHtml(cur) });
          startAvailability();
        });
      case "esc":
        return run(() => {
          if (ai.busy) aiAbort.current?.abort();
          else if (ai.open) setAi((a) => ({ ...a, open: false }));
          else {
            const cur = getState().compose;
            if (cur) void saveDraft({ ...cur, html: composeHtml(cur) });
            if (inline) (document.activeElement as HTMLElement | null)?.blur();
            else closeCompose();
          }
        });
    }
    // keep single-key shortcuts from leaking to the list while typing
    e.stopPropagation();
  };

  const onEditorInput = () => {
    setDirty((d) => d + 1);
    const before = textBeforeCaret();
    const m = before.match(/(?:^|\s);([\w-]*)$/);
    if (m) {
      if (!snip) void openSnippets(true, m[1]);
      else setSnip((s) => (s ? { ...s, q: m[1], idx: 0 } : s));
    } else if (snip?.inline) setSnip(null);
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files];
    const atts = await Promise.all(list.map(async (f) => ({ filename: f.name, contentType: f.type || "application/octet-stream", contentBase64: await fileToBase64(f), size: f.size })));
    const cur = getState().compose;
    if (cur?.key === compose.key) patch(cur, { attachments: [...cur.attachments, ...atts] });
  };

  const title = compose.mode === "new" ? "New message" : compose.mode === "forward" ? "Forward" : compose.mode === "reply" ? "Reply" : "Reply all";
  return (
    <div
      className={`composer${inline ? " inline" : " popped"}`}
      onKeyDown={onKeyDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {!inline && (
        <div className="composer-title">
          <span>{title}</span>
          <button className="icon-btn sm" onClick={() => void discardCompose()} title="Discard (⌘⇧,)" aria-label="Discard">
            <Icon name="x" />
          </button>
        </div>
      )}
      <RecipientInput label="To" value={compose.to} onChange={(to) => (patch(compose, { to }), setDirty((d) => d + 1))} inputRef={toRef} />
      {(compose.showCc || compose.cc.length > 0) && <RecipientInput label="Cc" value={compose.cc} onChange={(cc) => patch(compose, { cc })} />}
      {(compose.showBcc || compose.bcc.length > 0) && <RecipientInput label="Bcc" value={compose.bcc} onChange={(bcc) => patch(compose, { bcc })} />}
      {!compose.showCc && !compose.cc.length && (
        <div className="cc-toggles">
          <button className="link small" onClick={() => patch(compose, { showCc: true })}>
            Cc
          </button>
          <button className="link small" onClick={() => patch(compose, { showBcc: true })}>
            Bcc
          </button>
        </div>
      )}
      {showSubject && (
        <div className="field">
          <span className="field-label">Subject</span>
          <input ref={subjectRef} className="subject-input" value={compose.subject} onChange={(e) => patch(compose, { subject: e.target.value })} />
        </div>
      )}
      <FromField compose={compose} />
      <div className="editor-wrap">
        <div
          ref={editor}
          className="editor"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={aiAvailable ? "Write, or press ⌘J to write with AI…  ; for snippets" : "Write…  ; for snippets"}
          onInput={onEditorInput}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
        />
        {snip && (
          <div className="snippet-pop">
            {filteredSnips.length ? (
              filteredSnips.slice(0, 8).map((s, i) => (
                <div key={s.id} className={`sugg${i === snip.idx ? " on" : ""}`} onMouseDown={(e) => (e.preventDefault(), void insertSnippet(s))}>
                  <span className="sugg-name">{s.name}</span>
                  <span className="sugg-email">{s.html.replace(/<[^>]+>/g, " ").slice(0, 60)}</span>
                </div>
              ))
            ) : (
              <div className="sugg muted">No snippet matches “{snip.q}”</div>
            )}
          </div>
        )}
      </div>
      {compose.attachments.length > 0 && (
        <div className="atts">
          {compose.attachments.map((a, i) => (
            <span key={i} className="att">
              <Icon name="paperclip" size={14} className="att-clip" />
              <span className="att-name" title={a.filename}>
                {a.filename}
              </span>
              <span className="att-size">{fmtSize(a.size)}</span>
              <button aria-label={`Remove ${a.filename}`} title="Remove" onClick={() => patch(compose, { attachments: compose.attachments.filter((_, j) => j !== i) })}>
                <Icon name="x" size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      {ai.open && (
        <div className="ai-bar">
          <Icon name="sparkles" className="sparkle" />
          <input
            autoFocus
            placeholder={compose.threadId ? "Tell AI what to reply… (e.g. 'say yes, propose Tuesday')" : "Tell AI what to write…"}
            value={ai.text}
            disabled={ai.busy}
            onChange={(e) => setAi((a) => ({ ...a, text: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void runAi();
              }
            }}
          />
          {ai.busy ? <span className="shimmer">Writing…</span> : <kbd>↵</kbd>}
        </div>
      )}
      <div className="composer-bar">
        <button className="btn-primary send" onClick={() => void sendCompose()} title={`Send (⌘↵), ${undoSecs}s to undo`}>
          Send <kbd>{keyCaps("mod+enter").join(isMac ? "" : "+")}</kbd>
        </button>
        <button className="icon-btn" onClick={() => setState({ overlay: { kind: "sendLater" } })} title="Send later (⌘⇧L)" aria-label="Send later">
          <Icon name="clock" />
        </button>
        <button className="icon-btn" onClick={() => fileRef.current?.click()} title="Attach (⌘⇧U)" aria-label="Attach">
          <Icon name="paperclip" />
        </button>
        <button className="icon-btn" onClick={() => void openSnippets(false)} title="Snippets (⌘;)" aria-label="Snippets">
          <Icon name="snippet" />
        </button>
        <button className={`icon-btn${ai.open ? " on" : ""}`} onClick={() => setAi((a) => ({ ...a, open: !a.open }))} title="Write with AI (⌘J)" aria-label="Write with AI" aria-pressed={ai.open}>
          <Icon name="sparkles" />
        </button>
        <span className="spacer" />
        {compose.draftId && <span className="saved">Draft saved</span>}
        <button className="icon-btn" onClick={() => void discardCompose()} title="Discard (⌘⇧,)" aria-label="Discard">
          <Icon name="trash" />
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
      </div>
    </div>
  );
}

function placeCaretAtStart(el: HTMLElement | null) {
  if (!el) return;
  const r = document.createRange();
  r.setStart(el, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function textBeforeCaret(): string {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  const r = sel.getRangeAt(0);
  if (r.startContainer.nodeType !== Node.TEXT_NODE) return "";
  return (r.startContainer.textContent ?? "").slice(0, r.startOffset);
}

function deleteBeforeCaret(n: number) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (r.startContainer.nodeType !== Node.TEXT_NODE) return;
  const start = Math.max(0, r.startOffset - n);
  const del = document.createRange();
  del.setStart(r.startContainer, start);
  del.setEnd(r.startContainer, r.startOffset);
  del.deleteContents();
}
