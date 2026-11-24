import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Goal, Label } from "@iris/core/types.ts";
import { accountCommands, COMMANDS, type Command } from "../commands";
import { keyCaps } from "../keys";
import {
  accountColor,
  accountEmail,
  act,
  ALL,
  errorToast,
  getMeToZero,
  getState,
  labelsOf,
  loadLabels,
  navigate,
  openGoals,
  refKey,
  remind,
  sendCompose,
  setState,
  toggleGoalLink,
  useApp,
  userLabel,
  type AppState,
  type Ref,
} from "../state";
import { futureTime, fuzzy } from "../util";
import { Icon } from "./Icon";

export function Keys({ combo }: { combo: string }) {
  return (
    <span className="keys">
      {keyCaps(combo).map((k, i) => (k === "then" ? <span key={i} className="then">then</span> : <kbd key={i}>{k}</kbd>))}
    </span>
  );
}

function close() {
  setState({ overlay: null });
}

/** Shared list-with-input surface: arrows, enter, esc. Keyboard-first, so it mounts instantly (E1):
 *  "palette" = the dark ⌘K surface (no scrim), "picker" = theme surface on a transparent backdrop. */
function PickerModal<T>({
  title,
  placeholder,
  items,
  render,
  onPick,
  onEnterText,
  footer,
  header,
  initialQuery = "",
  filter,
  variant = "picker",
  onKey,
}: {
  variant?: "palette" | "picker";
  /** extra key handling before the defaults; return true when handled */
  onKey?: (e: React.KeyboardEvent<HTMLInputElement>) => boolean;
  title?: string;
  placeholder: string;
  items: T[];
  render: (item: T, active: boolean) => React.ReactNode;
  onPick: (item: T, q: string) => void;
  onEnterText?: (q: string) => void;
  footer?: React.ReactNode;
  header?: React.ReactNode;
  initialQuery?: string;
  filter: (item: T, q: string) => number;
}) {
  const [q, setQ] = useState(initialQuery);
  const [idx, setIdx] = useState(0);
  const shown = useMemo(
    () =>
      items
        .map((it) => ({ it, s: filter(it, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.it),
    [items, q],
  );
  useEffect(() => setIdx(0), [q]);
  return (
    <div className={variant === "palette" ? "palette-backdrop" : "picker-backdrop"} onMouseDown={close}>
      <div className={variant} role="dialog" aria-label={title ?? placeholder} onMouseDown={(e) => e.stopPropagation()}>
        {title && <div className="modal-title">{title}</div>}
        {header}
        <input
          className="modal-input"
          autoFocus
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (onKey?.(e)) return;
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              setIdx((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (shown[idx] !== undefined && !(onEnterText && e.metaKey)) onPick(shown[idx], q);
              else onEnterText?.(q);
            }
          }}
        />
        <div className="modal-list" role="listbox">
          {shown.map((it, i) => (
            <div key={i} role="option" aria-selected={i === idx} className={`modal-item${i === idx ? " on" : ""}`} onMouseMove={() => i !== idx && setIdx(i)} onClick={() => onPick(it, q)}>
              {render(it, i === idx)}
            </div>
          ))}
        </div>
        {footer}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Cmd+K

/** User labels of the route's scope, each with its account (unified: every account's). */
function scopedLabels(s: AppState): { label: Label; account: string }[] {
  const scope = s.route.account;
  const accounts = scope === ALL ? Object.keys(s.labelsBy) : [scope];
  return accounts.flatMap((account) => (s.labelsBy[account] ?? []).filter(userLabel).map((label) => ({ label, account })));
}

/** Small account color dot (sidebar, pickers, popovers). */
export function AccountDot({ id, size }: { id: string; size?: number }) {
  const color = useApp((s) => accountColor(s, id));
  return <span className="acct-dot" style={{ "--acct": color, ...(size ? { width: size, height: size } : {}) } as React.CSSProperties} aria-hidden />;
}

export function CommandPalette() {
  const s = getState();
  const items = COMMANDS.filter((c) => c.palette !== false && (!c.enabled || c.enabled(s)));
  const labels = useApp(scopedLabels);
  const multi = (s.status?.accounts.length ?? 0) > 1;
  const all: (Command | { id: string; title: string; section: string; run: () => void; keys?: string[] })[] = [
    ...items,
    ...accountCommands(s),
    ...labels.map(({ label: l, account }) => ({
      id: `label:${account}:${l.id}`,
      title: multi ? `Go to ${l.name} · ${accountEmail(s, account)}` : `Go to ${l.name}`,
      section: "Labels",
      run: () => navigate({ view: "label", labelId: l.id, name: l.name, account }),
    })),
  ];
  return (
    <PickerModal
      variant="palette"
      placeholder="Type a command…"
      items={all}
      filter={(c, q) => fuzzy(q, `${c.title} ${c.section}`)}
      render={(c) => (
        <>
          <span className="cmd-title">{c.title}</span>
          <span className="cmd-section">{c.section}</span>
          {c.keys?.[0] && <Keys combo={c.keys[0]} />}
        </>
      )}
      onPick={(c) => {
        close();
        setTimeout(() => void c.run(), 0);
      }}
    />
  );
}

// ------------------------------------------------------------ link to goal

function GoalDialog({ refs }: { refs: Ref[] }) {
  const goals = useApp((s) => s.goals);
  const active = goals.filter((g) => g.status === "active");
  const linked = (g: Goal) => refs.every((r) => g.threads.some((t) => t.accountId === r.account && t.threadId === r.threadId));
  return (
    <PickerModal
      title={refs.length > 1 ? `Link ${refs.length} conversations to a goal` : "Link to goal"}
      placeholder={active.length ? "Search goals…" : "No active goals yet"}
      items={active}
      filter={(g, q) => fuzzy(q, g.title)}
      render={(g) => (
        <>
          <Icon name={linked(g) ? "check" : "target"} />
          <span className="cmd-title">{g.title}</span>
          <span className="cmd-section tnum">{g.progress.percent}%</span>
        </>
      )}
      onPick={(g) => {
        close();
        void toggleGoalLink(g, refs);
      }}
      footer={
        <button type="button" className="link small goal-picker-new" onClick={() => openGoals({ create: true })}>
          New goal…
        </button>
      }
    />
  );
}

// ------------------------------------------------------------ time picker (Remind Me + Send Later)

interface Preset {
  id: string;
  label: string;
  at: number;
}

function TimePicker({ title, onChoose, extra }: { title: string; onChoose: (at: number, label: string) => void; extra?: React.ReactNode }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [parsed, setParsed] = useState<{ q: string; at: number | null } | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    void api.get<{ presets: Preset[] }>("/api/when").then((r) => setPresets(r.presets));
  }, []);
  useEffect(() => {
    if (!q.trim()) return setParsed(null);
    const t = setTimeout(async () => {
      const r = await api.get<{ at: number | null }>("/api/when", { input: q });
      setParsed({ q, at: r.at && r.at > Date.now() ? r.at : null });
    }, 60);
    return () => clearTimeout(t);
  }, [q]);
  const items: Preset[] = parsed?.at ? [{ id: "custom", label: q, at: parsed.at }, ...presets] : presets;
  return (
    <div className="picker-backdrop" onMouseDown={close}>
      <div className="picker" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <TimeList items={items} q={q} setQ={setQ} onChoose={onChoose} parsedFail={!!q.trim() && parsed?.q === q && !parsed.at} />
        {extra}
      </div>
    </div>
  );
}

function TimeList({ items, q, setQ, onChoose, parsedFail }: { items: Preset[]; q: string; setQ: (s: string) => void; onChoose: (at: number, label: string) => void; parsedFail: boolean }) {
  const [idx, setIdx] = useState(0);
  const shown = q.trim() ? items.filter((p) => p.id === "custom" || fuzzy(q, p.label) > 0) : items;
  useEffect(() => setIdx(0), [q, items.length]);
  return (
    <>
      <input
        className="modal-input"
        autoFocus
        placeholder="Try: tomorrow 9am, fri, in 3 days, next month…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
          else if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(shown.length - 1, i + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
          else if (e.key === "Enter" && shown[idx]) (e.preventDefault(), onChoose(shown[idx].at, shown[idx].label));
        }}
      />
      <div className="modal-list" role="listbox">
        {shown.map((p, i) => (
          <div key={p.id + p.at} role="option" aria-selected={i === idx} className={`modal-item${i === idx ? " on" : ""}`} onMouseMove={() => i !== idx && setIdx(i)} onClick={() => onChoose(p.at, p.label)}>
            <span className="cmd-title">{p.id === "custom" ? `“${p.label}”` : p.label}</span>
            <span className="cmd-section">{futureTime(p.at)}</span>
          </div>
        ))}
        {parsedFail && <div className="modal-item muted">Can't read that time yet…</div>}
      </div>
    </>
  );
}

export function RemindDialog({ refs }: { refs: Ref[] }) {
  const [ifNoReply, setIfNoReply] = useState(false);
  return (
    <TimePicker
      title={`Remind me${refs.length > 1 ? ` (${refs.length} conversations)` : ""}`}
      onChoose={(at) => void remind(refs, at, ifNoReply)}
      extra={
        <label className="modal-check">
          <input type="checkbox" checked={ifNoReply} onChange={(e) => setIfNoReply(e.target.checked)} />
          Only if nobody replies
        </label>
      }
    />
  );
}

export function SendLaterDialog() {
  return <TimePicker title="Send later" onChoose={(at) => void sendCompose({ sendAt: at })} />;
}

// ------------------------------------------------------------ labels

/** Labels are per account: the picker lists the target threads' accounts (by name; the action resolves names per account). */
export function LabelDialog({ mode, refs }: { mode: "add" | "move"; refs: Ref[] }) {
  const accounts = [...new Set(refs.map((r) => r.account))];
  const labels = useApp((s) => {
    const seen = new Set<string>();
    return accounts.flatMap((a) => labelsOf(s, a).filter(userLabel)).filter((l) => (seen.has(l.name) ? false : (seen.add(l.name), true)));
  });
  const threads = useApp((s) => s.threads);
  const thread = useApp((s) => s.thread);
  const labelsBy = useApp((s) => s.labelsBy);
  const keys = new Set(refs.map((r) => refKey(r.account, r.threadId)));
  const has = (name: string) => {
    const t = thread && keys.has(refKey(thread.accountId, thread.id)) ? thread : threads.find((x) => keys.has(refKey(x.accountId, x.id)));
    const id = t && labelsBy[t.accountId]?.find((l) => l.name === name)?.id;
    return !!id && !!t?.labelIds.includes(id);
  };
  const apply = async (name: string, isNew: boolean) => {
    close();
    if (mode === "move") await act("move", { refs, label: name });
    else await act(!isNew && has(name) ? "removeLabel" : "addLabel", { refs, label: name });
    if (isNew) void loadLabels(accounts);
  };
  return (
    <PickerModal
      title={mode === "move" ? "Move to…" : "Label"}
      placeholder={mode === "move" ? "Move to label…" : "Add or remove label…"}
      items={labels}
      filter={(l, q) => fuzzy(q, l.name)}
      render={(l) => (
        <>
          {mode === "add" && (
            <span className={`check${has(l.name) ? " on" : ""}`}>
              <Icon name="check" size={12} stroke={2} />
            </span>
          )}
          <span className="cmd-title">{l.name}</span>
        </>
      )}
      onPick={(l) => void apply(l.name, false)}
      onEnterText={(q) => q.trim() && void apply(q.trim(), true)}
      footer={<div className="modal-foot">↵ to apply · type a new name and ⌘↵ to create</div>}
    />
  );
}

/** g l: labels of the current scope; in All Inboxes every account's, with its color dot. */
export function GoLabelDialog() {
  const items = useApp(scopedLabels);
  const multi = useApp((s) => (s.status?.accounts.length ?? 0) > 1);
  const emailOf = useApp((s) => (id: string) => accountEmail(s, id));
  return (
    <PickerModal
      title="Go to label"
      placeholder="Label…"
      items={items}
      filter={(x, q) => fuzzy(q, multi ? `${x.label.name} ${emailOf(x.account)}` : x.label.name)}
      render={(x) => (
        <span className="acct-item">
          {multi && <AccountDot id={x.account} />}
          <span className="cmd-title">{x.label.name}</span>
          {multi && <span className="cmd-section">{emailOf(x.account)}</span>}
        </span>
      )}
      onPick={(x) => navigate({ view: "label", labelId: x.label.id, name: x.label.name, account: x.account })}
    />
  );
}

// ------------------------------------------------------------ get me to zero

export function ZeroDialog() {
  const day = 86_400_000;
  const opts = [
    { label: "Older than 1 day", before: Date.now() - day },
    { label: "Older than 1 week", before: Date.now() - 7 * day },
    { label: "Older than 1 month", before: Date.now() - 30 * day },
    { label: "Everything", before: Date.now() + 1000 },
  ];
  return (
    <PickerModal
      title="Get Me To Zero: mark done all conversations in the inbox…"
      placeholder="Choose…"
      items={opts}
      filter={(o, q) => fuzzy(q, o.label)}
      render={(o) => <span className="cmd-title">{o.label}</span>}
      onPick={(o) => void getMeToZero(o.before)}
    />
  );
}

// ------------------------------------------------------------ shortcuts sheet

export function ShortcutsSheet() {
  const sections = ["Actions", "Navigation", "Views", "Compose", "AI", "Calendar", "App"] as const;
  const accountRows = accountCommands(getState()).filter((c) => c.keys?.length);
  const calendarKeys: [string, string][] = [
    ["mod+enter", "Event editor: Save"],
    ["esc", "Event editor: Discard"],
    ["right", "Invite card: next button"],
    ["enter", "Invite card / availability: choose"],
  ];
  const composeKeys: [string, string][] = [
    ["mod+enter", "Send"],
    ["mod+shift+enter", "Send + Mark Done"],
    ["mod+shift+l", "Send Later"],
    ["mod+shift+z", "Send Instantly"],
    ["mod+shift+,", "Discard Draft"],
    ["mod+j", "Write with AI"],
    ["mod+;", "Use Snippet  (or type ;)"],
    ["mod+shift+c", "Cc"],
    ["mod+shift+b", "Bcc"],
    ["mod+shift+u", "Attach"],
    ["mod+shift+s", "Edit Subject"],
    ["mod+shift+a", "Share Availability"],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal wide sheet" onMouseDown={(e) => e.stopPropagation()} tabIndex={-1} ref={(el) => {
          el?.focus();
        }} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-title">Keyboard shortcuts</div>
        <div className="sheet-grid">
          {sections.map((sec) => (
            <div key={sec}>
              <h4>{sec}</h4>
              {COMMANDS.filter((c) => c.section === sec && c.keys?.length).map((c) => (
                <div key={c.id} className="sheet-row">
                  <span>{c.title}</span>
                  <Keys combo={c.keys![0]} />
                </div>
              ))}
              {sec === "Views" &&
                accountRows.map((c) => (
                  <div key={c.id} className="sheet-row">
                    <span>{c.title}</span>
                    <Keys combo={c.keys![0]} />
                  </div>
                ))}
              {sec === "Calendar" &&
                calendarKeys.map(([k, t]) => (
                  <div key={k + t} className="sheet-row">
                    <span>{t}</span>
                    <Keys combo={k} />
                  </div>
                ))}
              {sec === "Compose" &&
                composeKeys.map(([k, t]) => (
                  <div key={k} className="sheet-row">
                    <span>{t}</span>
                    <Keys combo={k} />
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Overlay() {
  const o = useApp((s) => s.overlay);
  if (!o) return null;
  switch (o.kind) {
    case "palette":
      return <CommandPalette />;
    case "remind":
      return <RemindDialog refs={o.refs} />;
    case "sendLater":
      return <SendLaterDialog />;
    case "label":
      return <LabelDialog mode={o.mode} refs={o.refs} />;
    case "goLabel":
      return <GoLabelDialog />;
    case "goal":
      return <GoalDialog refs={o.refs} />;
    case "zero":
      return <ZeroDialog />;
    case "shortcuts":
      return <ShortcutsSheet />;
    default:
      return null;
  }
}

export { errorToast };
