// Sidebar:
// an always-visible icon rail, plus a panel with "All Inboxes" on top and one collapsible section per account.
// The panel is pinned next to the rail (⌘\, remembered) or, unpinned, flies out over the content on hover / ⌘⇧M.
// Keyboard: ↑ ↓ move between rows, ← → fold an account, ↵ opens, Esc returns to the mail.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { emit, on } from "../bus";
import { closeWeek, openWeek } from "../cal";
import { keyCaps } from "../keys";
import {
  accountColor,
  ALL,
  getState,
  closeGoals,
  goInbox,
  navigate,
  openGoals,
  setState,
  toggleNavPinned,
  useApp,
  userLabel,
  type AppState,
  type MailboxCounts,
  type Route,
} from "../state";
import { Icon, type IconName } from "./Icon";
import { toggleResearch } from "../research";

type BoxView = Exclude<Route["view"], "inbox" | "label" | "search">;
interface Box {
  view: BoxView;
  label: string;
  icon: IconName;
  keys?: string;
  count?: (c: MailboxCounts) => number | undefined;
}

const BOXES: Box[] = [
  { view: "starred", label: "Starred", icon: "star", keys: "g s", count: (c) => c.starred },
  { view: "drafts", label: "Drafts", icon: "file", keys: "g d", count: (c) => c.drafts },
  { view: "sent", label: "Sent", icon: "send", keys: "g t" },
  { view: "done", label: "Done", icon: "circle-check", keys: "g e" },
  { view: "reminders", label: "Reminders", icon: "alarm", keys: "g h", count: (c) => c.reminders },
  { view: "scheduled", label: "Scheduled", icon: "clock", count: (c) => c.scheduled },
  { view: "muted", label: "Muted", icon: "bell-off", keys: "g m" },
  { view: "spam", label: "Spam", icon: "octagon-alert", keys: "g !" },
  { view: "trash", label: "Trash", icon: "trash", keys: "g #" },
  { view: "all", label: "All Mail", icon: "archive", keys: "g a" },
];
const RAIL_BOXES = BOXES.slice(0, 6);
const MORE_BOXES = BOXES.slice(6).filter((b) => b.view !== "all");

const EXPANDED_KEY = "iris.nav.expanded";
function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

const fmt = (n: number | undefined) => (n ? n.toLocaleString() : "");
const fine = () => typeof matchMedia !== "undefined" && matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Compact key hint for rows and tooltips: "g i" → G I, "ctrl+1" → ⌃ 1 (no "then"). */
function Hint({ combo }: { combo: string }) {
  return (
    <span className="nav-keys" aria-hidden>
      {keyCaps(combo)
        .filter((k) => k !== "then")
        .map((k, i) => (
          <kbd key={i}>{k}</kbd>
        ))}
    </span>
  );
}

/** Built-in split of the route (unified: `builtin:*`; per account: looked up in the loaded splits). */
function routeBuiltin(s: AppState): "important" | "other" | null {
  const r = s.route;
  if (r.view !== "inbox") return null;
  if (r.splitId === "builtin:important" || r.splitId === "builtin:other") return r.splitId.slice(8) as "important" | "other";
  return s.splits.find((x) => x.id === r.splitId)?.builtin ?? null;
}

function blurNav() {
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest(".sidebar")) el.blur();
}

/** Navigate, then hand the keyboard back to the mail (j/k, ↵ act on the list again). */
function go(fn: () => void | Promise<void>) {
  blurNav();
  void fn();
}

// ------------------------------------------------------------ rail

function RailButton({
  icon,
  label,
  keys,
  on,
  onClick,
  children,
  className = "",
  ...rest
}: {
  icon?: IconName;
  label: string;
  keys?: string;
  on?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`rail-btn${on ? " on" : ""} ${className}`} aria-label={label} aria-current={on ? "page" : undefined} data-nav onClick={onClick} {...rest}>
      {children ?? (icon && <Icon name={icon} size={18} />)}
      <span className="rail-tip" role="tooltip">
        <span>{label}</span>
        {keys && <Hint combo={keys} />}
      </span>
    </button>
  );
}

function RailMore() {
  const [open, setOpen] = useState(false);
  const route = useApp((s) => s.route);
  const ref = useRef<HTMLDivElement>(null);
  const items: { label: string; icon: IconName; keys?: string; run: () => void; on?: boolean }[] = [
    ...MORE_BOXES.map((b) => ({ label: b.label, icon: b.icon, keys: b.keys, on: route.view === b.view, run: () => navigate({ view: b.view }) })),
    { label: "Labels…", icon: "tag" as IconName, keys: "g l", on: route.view === "label", run: () => setState({ overlay: { kind: "goLabel" } }) },
  ];
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLButtonElement>(".rail-menu button")?.focus();
  }, [open]);
  return (
    <div
      className="rail-more"
      ref={ref}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Enter" || e.key === " " || e.key === "Tab") e.stopPropagation(); // native activation, not the list's bindings
        else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          ref.current?.querySelector<HTMLButtonElement>(".rail-btn")?.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".rail-menu button") ?? [])];
          const i = list.indexOf(document.activeElement as HTMLButtonElement);
          list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
        }
      }}
    >
      <RailButton
        icon="more"
        label="More mailboxes"
        on={MORE_BOXES.some((b) => b.view === route.view) || route.view === "label"}
        aria-haspopup="menu"
        aria-expanded={open}
        className={open ? "menu-open" : ""}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="rail-menu" role="menu" aria-label="More mailboxes">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.on ? "on" : ""}
              onClick={() => {
                setOpen(false);
                go(it.run);
              }}
            >
              <Icon name={it.icon} />
              <span className="nav-label">{it.label}</span>
              {it.keys && <Hint combo={it.keys} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Rail() {
  const route = useApp((s) => s.route);
  const unified = useApp((s) => s.unified);
  const week = useApp((s) => s.calPane === "week");
  const goalsOpen = useApp((s) => s.goalsOpen);
  const researchOpen = useApp((s) => !!s.research);
  const accounts = useApp((s) => s.status?.accounts ?? []);
  const errors = useApp((s) => new Map((s.mailboxes?.accounts ?? []).map((a) => [a.id, a.error])));
  const colorOf = useApp((s) => (id: string) => accountColor(s, id));
  const inboxOn = route.view === "inbox" && (route.account === ALL || !unified);
  return (
    <div className="rail" role="toolbar" aria-orientation="vertical" aria-label="Mailboxes">
      <RailButton icon="inbox" label={unified ? "All Inboxes" : "Inbox"} keys="g i" on={inboxOn} onClick={() => go(() => goInbox(ALL))} />
      {RAIL_BOXES.map((b) => (
        <RailButton key={b.view} icon={b.icon} label={b.label} keys={b.keys} on={route.view === b.view} onClick={() => go(() => navigate({ view: b.view }))} />
      ))}
      <RailButton icon="archive" label="All Mail" keys="g a" on={route.view === "all"} onClick={() => go(() => navigate({ view: "all" }))} />
      <RailButton icon="calendar" label="Calendar" keys="2" on={week} onClick={() => go(() => (week ? closeWeek() : openWeek()))} />
      <RailButton icon="target" label="Goals" keys="g g" on={goalsOpen} onClick={() => go(() => (goalsOpen ? closeGoals() : openGoals()))} />
      <RailButton icon="user-search" label="Research" keys="g p" on={researchOpen} onClick={() => go(toggleResearch)} />
      <RailMore />
      <span className="rail-spacer" />
      {accounts.length > 1 &&
        accounts.map((a, i) => (
          <RailButton
            key={a.id}
            label={`${a.email} Inbox`}
            keys={i < 9 ? `ctrl+${i + 1}` : undefined}
            on={route.account === a.id}
            className="rail-acct-btn"
            onClick={() => go(() => goInbox(a.id))}
          >
            <span className="rail-acct" style={{ "--acct": colorOf(a.id) } as CSSProperties}>
              {(a.email[0] ?? "?").toUpperCase()}
            </span>
            {errors.get(a.id) && <span className="rail-acct-alert" title={errors.get(a.id) ?? ""} />}
          </RailButton>
        ))}
      <RailButton icon="settings" label="Settings" keys="mod+," onClick={() => go(() => setState({ overlay: { kind: "settings" } }))} />
    </div>
  );
}

// ------------------------------------------------------------ panel

function NavRow({
  icon,
  label,
  count,
  keys,
  on,
  sub,
  onClick,
  title,
}: {
  icon?: IconName;
  label: string;
  count?: number;
  keys?: string;
  on?: boolean;
  sub?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button type="button" className={`nav-row${sub ? " sub" : ""}`} aria-current={on ? "page" : undefined} data-nav onClick={onClick} title={title}>
      {icon ? <Icon name={icon} /> : <span className="nav-bullet" />}
      <span className="nav-label">{label}</span>
      {keys && <Hint combo={keys} />}
      {!!count && <span className="nav-count">{fmt(count)}</span>}
    </button>
  );
}

function AccountSection({ id, index, open, onToggle }: { id: string; index: number; open: boolean; onToggle: () => void }) {
  const route = useApp((s) => s.route);
  const builtin = useApp(routeBuiltin);
  const a = useApp((s) => s.status?.accounts.find((x) => x.id === id));
  const mb = useApp((s) => s.mailboxes?.accounts.find((x) => x.id === id));
  const color = useApp((s) => accountColor(s, id));
  const fallbackLabels = useApp((s) => s.labelsBy[id]);
  if (!a) return null;
  const c: MailboxCounts = mb?.counts ?? { inbox: a.inbox, inboxUnread: a.unread, important: 0, importantUnread: 0, other: 0, otherUnread: 0 };
  const labels = (mb?.labels ?? (fallbackLabels ?? []).filter(userLabel).map((l) => ({ id: l.id, name: l.name, unread: l.messagesUnread ?? 0 }))).filter((l) => !l.name.startsWith("Iris/"));
  const here = route.account === id;
  // g-sequences act on the current scope, so they are only hinted where they lead
  const hint = (k?: string) => (here ? k : undefined);
  const inbox = here && route.view === "inbox";
  return (
    <section className={`nav-acct${open ? " open" : ""}`} style={{ "--acct": color } as CSSProperties} aria-label={a.email}>
      <button type="button" className="nav-row nav-acct-head" data-nav data-acct={id} aria-expanded={open} onClick={onToggle} title={mb?.error ?? a.email}>
        <Icon name="chevron-right" size={14} className="nav-chev" />
        <span className="acct-dot" />
        <span className="nav-label">{a.email}</span>
        {mb?.error && <Icon name="alert" size={14} className="nav-error" title={mb.error} />}
        {index < 9 && <Hint combo={`ctrl+${index + 1}`} />}
        {!open && !!c.inboxUnread && <span className="nav-count">{fmt(c.inboxUnread)}</span>}
      </button>
      {open && (
        <div className="nav-acct-body">
          <NavRow icon="inbox" label="Inbox" count={c.inboxUnread} on={inbox && !builtin} onClick={() => go(() => goInbox(id))} />
          <NavRow sub label="Important" count={c.importantUnread} on={inbox && builtin === "important"} onClick={() => go(() => goInbox(id, "important"))} />
          <NavRow sub label="Other" count={c.otherUnread} keys={hint("g o")} on={inbox && builtin === "other"} onClick={() => go(() => goInbox(id, "other"))} />
          {BOXES.map((b) => (
            <NavRow key={b.view} icon={b.icon} label={b.label} count={b.count?.(c)} keys={hint(b.keys)} on={here && route.view === b.view} onClick={() => go(() => navigate({ view: b.view, account: id }))} />
          ))}
          {labels.length > 0 && <div className="nav-sub-h">Labels</div>}
          {labels.map((l) => (
            <NavRow
              key={l.id}
              icon="tag"
              label={l.name}
              count={l.unread}
              on={here && route.view === "label" && route.labelId === l.id}
              onClick={() => go(() => navigate({ view: "label", labelId: l.id, name: l.name, account: id }))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Panel({ flyout }: { flyout: boolean }) {
  const route = useApp((s) => s.route);
  const builtin = useApp(routeBuiltin);
  const unified = useApp((s) => s.unified);
  const pinned = useApp((s) => s.navPinned);
  const accounts = useApp((s) => s.status?.accounts ?? []);
  const u = useApp((s) => s.mailboxes?.unified);
  const week = useApp((s) => s.calPane === "week");
  const goalsOpen = useApp((s) => s.goalsOpen);
  const researchOpen = useApp((s) => !!s.research);
  const [expanded, setExpanded] = useState(loadExpanded);
  const isOpen = (id: string, i: number) => expanded[id] ?? (i === 0 || route.account === id || accounts.length === 1);
  const toggle = (id: string, i: number, to?: boolean) => {
    const next = { ...expanded, [id]: to ?? !isOpen(id, i) };
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  useEffect(() => on("navToggleAccount", (arg) => {
    const { id, open } = arg as { id: string; open: boolean };
    const i = accounts.findIndex((a) => a.id === id);
    if (i >= 0 && isOpen(id, i) !== open) toggle(id, i, open);
  }), [expanded, accounts, route.account]);
  const all = route.view === "inbox" && route.account === ALL;
  const panel = useRef<HTMLDivElement>(null);
  // keep the current mailbox visible (instant: it follows keyboard navigation, E1)
  useEffect(() => void panel.current?.querySelector('.nav-scroll [aria-current="page"]')?.scrollIntoView({ block: "nearest" }), [route, builtin]);
  return (
    <div ref={panel} className={`nav-panel${flyout ? " flyout" : ""}`} role="navigation" aria-label="Mailboxes">
      <div className="nav-head">
        <span className="nav-title">Mailboxes</span>
        <button
          type="button"
          className={`icon-btn sm nav-pin${pinned ? " on" : ""}`}
          data-nav
          aria-pressed={pinned}
          title={pinned ? "Unpin sidebar (⌘\\)" : "Pin sidebar (⌘\\)"}
          aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"}
          onClick={() => toggleNavPinned()}
        >
          <Icon name="pin" size={14} />
        </button>
        <Hint combo={"mod+\\"} />
      </div>
      <div className="nav-scroll">
        {unified && (
          <section className="nav-all" aria-label="All Inboxes">
            <NavRow icon="inbox" label="All Inboxes" keys="g i" count={u?.inboxUnread} on={all && !builtin} onClick={() => go(() => goInbox(ALL))} />
            <NavRow sub label="Important" count={u?.importantUnread} on={all && builtin === "important"} onClick={() => go(() => goInbox(ALL, "important"))} />
            <NavRow sub label="Other" count={u?.otherUnread} keys={route.account === ALL ? "g o" : undefined} on={all && builtin === "other"} onClick={() => go(() => goInbox(ALL, "other"))} />
          </section>
        )}
        {accounts.map((a, i) => (
          <AccountSection key={a.id} id={a.id} index={i} open={isOpen(a.id, i)} onToggle={() => toggle(a.id, i)} />
        ))}
        <div className="nav-sep" />
        <NavRow icon="calendar" label="Calendar" keys="2" on={week} onClick={() => go(() => (week ? closeWeek() : openWeek()))} />
        <NavRow icon="target" label="Goals" keys="g g" on={goalsOpen} onClick={() => go(() => (goalsOpen ? closeGoals() : openGoals()))} />
        <NavRow icon="user-search" label="Research" keys="g p" on={researchOpen} onClick={() => go(toggleResearch)} />
        <NavRow icon="settings" label="Settings" keys="mod+," onClick={() => go(() => setState({ overlay: { kind: "settings" } }))} />
      </div>
      <div className="nav-foot">
        {accounts.length > 1 && (
          <span>
            <Hint combo="ctrl+1" />
            <span className="nav-foot-sep">/</span>
            <Hint combo="ctrl+2" /> Accounts
          </span>
        )}
        <button type="button" className="link small" onClick={() => go(() => setState({ overlay: { kind: "shortcuts" } }))}>
          <Hint combo="mod+/" /> Shortcuts
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ sidebar

export function Sidebar() {
  const pinned = useApp((s) => s.navPinned);
  const peek = useApp((s) => s.navPeek);
  const root = useRef<HTMLElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  useEffect(() => clear, []);

  const focusActive = () =>
    requestAnimationFrame(() => {
      const panel = root.current?.querySelector(".nav-panel");
      (panel?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel?.querySelector<HTMLElement>(".nav-scroll [data-nav]"))?.focus();
    });

  // ⌘⇧M: show the panel (flyout when unpinned) and put the keyboard in it; again: back to the mail
  useEffect(
    () =>
      on("navFocus", () => {
        const inside = !!(document.activeElement as HTMLElement | null)?.closest(".sidebar");
        if (inside) {
          blurNav();
          setState({ navPeek: false });
          return;
        }
        if (!getState().navPinned) setState({ navPeek: true });
        focusActive();
      }),
    [],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest(".rail-menu")) return; // the More menu handles its own keys
    const scope = t.closest(".nav-panel, .rail");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!scope) return;
      e.preventDefault();
      e.stopPropagation();
      const list = [...scope.querySelectorAll<HTMLElement>("[data-nav]")];
      const i = list.indexOf(t);
      list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && t.dataset.acct) {
      e.preventDefault();
      e.stopPropagation();
      emitToggle(t.dataset.acct, e.key === "ArrowRight");
    } else if (e.key === "Enter" || e.key === " " || e.key === "Tab") {
      e.stopPropagation(); // native button activation / focus order, not the list's ↵ / Space / Tab bindings
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      blurNav();
      setState({ navPeek: false });
    }
  };

  return (
    <nav
      ref={root}
      className={`sidebar${pinned ? " pinned" : ""}${!pinned && peek ? " peek" : ""}`}
      aria-label="Sidebar"
      onKeyDown={onKeyDown}
      onPointerEnter={() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }}
      onPointerLeave={() => {
        if (openTimer.current) clearTimeout(openTimer.current);
        openTimer.current = null;
        if (getState().navPinned || !getState().navPeek) return;
        if ((document.activeElement as HTMLElement | null)?.closest(".sidebar .nav-panel")) return; // opened from the keyboard
        closeTimer.current = setTimeout(() => setState({ navPeek: false }), 250);
      }}
      onBlur={(e) => {
        if (!getState().navPeek || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (!e.currentTarget.matches(":hover")) setState({ navPeek: false });
      }}
    >
      <div
        className="rail-wrap"
        onPointerEnter={() => {
          if (getState().navPinned || getState().navPeek || !fine()) return;
          openTimer.current = setTimeout(() => setState({ navPeek: true }), 300);
        }}
      >
        <Rail />
      </div>
      {(pinned || peek) && <Panel flyout={!pinned} />}
    </nav>
  );
}

function emitToggle(id: string, open: boolean) {
  emit("navToggleAccount", { id, open });
}
