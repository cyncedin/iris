// Calendar surfaces: Day pane (right pane), Week page (replaces the list),
// the shared 44 px/hour grid, and the event detail popover.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { EventAttendee, MeetingPerson } from "@iris/core/types.ts";
import { api } from "../api";
import { personLabel, researchPerson, shortName } from "../research";
import {
  addSlot,
  buildItems,
  calendarOf,
  calKey,
  calScope,
  cancelAvailability,
  closeCalendar,
  closePopover,
  closeWeek,
  confirmAvailability,
  createAt,
  createAtNow,
  dayToday,
  deleteEvent,
  editEvent,
  ensureEvents,
  evKey,
  loadCalendars,
  openPopover,
  openWeek,
  removeSlot,
  resizeSlot,
  retryCalendar,
  rsvpEvent,
  setAvailDuration,
  shiftDay,
  shiftWeek,
  startAvailability,
  suggestSlots,
  toggleCalendar,
  weekToday,
} from "../cal";
import {
  addDays,
  calTone,
  conferenceOf,
  dayHeader,
  dayTitle,
  fmtRange,
  fmtTime,
  guests,
  HOUR,
  HOUR_PX,
  hourLabel,
  hueOf,
  isUrl,
  layoutDay,
  localTimeZone,
  MIN,
  renderAvailabilityText,
  sortAttendees,
  startOfDay,
  startOfWeek,
  toneVars,
  weekLabel,
  whenLong,
  type CalHue,
  type GridItem,
  type Placed,
} from "../calutil";
import { emit } from "../bus";
import { accountColor, accountEmail, setCalSettings, setState, startCompose, useApp, type Theme } from "../state";
import { avatarColor, initials, nameOf } from "../util";
import { Icon, type IconName } from "./Icon";

export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Load calendars once per scope (every account when unified) and events for the visible range. */
function useCalendarLoad() {
  const account = useApp((s) => calScope(s));
  const pane = useApp((s) => s.calPane);
  const date = useApp((s) => s.calDate);
  const ws = useApp((s) => s.calSettings.weekStartsOn);
  useEffect(() => void loadCalendars(), [account]);
  useEffect(() => void ensureEvents(), [account, pane, date, ws]);
}

function useGridItems(from: number, to: number): GridItem[] {
  const calEvents = useApp((s) => s.calEvents);
  const calInvite = useApp((s) => s.calInvite);
  const calDraft = useApp((s) => s.calDraft);
  const calAvail = useApp((s) => s.calAvail);
  const calendars = useApp((s) => s.calendars);
  const calSettings = useApp((s) => s.calSettings);
  const now = useNow(60_000);
  return useMemo(
    () => buildItems({ calEvents, calInvite, calDraft, calAvail, calendars, calSettings }, from, to, now),
    [calEvents, calInvite, calDraft, calAvail, calendars, calSettings, from, to, now],
  );
}

// ------------------------------------------------------------ grid

interface Drag {
  day: number;
  a: number;
  b: number;
  y0: number;
  moved: boolean;
  resize?: number; // availability slot index
}

function timeAt(day: number, col: HTMLElement, clientY: number, mode: "floor" | "ceil"): number {
  const rect = col.getBoundingClientRect();
  const minutes = Math.max(0, Math.min(24 * 60, ((clientY - rect.top) / HOUR_PX) * 60));
  return day + Math[mode](minutes / 15) * 15 * MIN;
}

function TimeGrid({ days, items, mode, availability }: { days: number[]; items: GridItem[]; mode: "day" | "week"; availability: boolean }) {
  const focus = useApp((s) => s.calFocus);
  const avail = useApp((s) => s.calAvail);
  const now = useNow(30_000);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const todayStart = startOfDay(now);

  // ~06:30, the current time when it's later in the day, or the focused time (invite, new event)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const t = focus?.at;
    let hour = 6.5;
    if (t !== undefined && days.some((d) => t >= d && t < addDays(d, 1))) hour = Math.max(0, (t - startOfDay(t)) / HOUR - 1.5);
    else if (days.includes(todayStart)) {
      const h = (Date.now() - todayStart) / HOUR;
      if (h > 9.5) hour = h - 2.5;
    }
    el.scrollTop = hour * HOUR_PX;
  }, [focus?.seq, days[0]]);

  const allDay = items.filter((i) => i.allDay);
  const timed = items.filter((i) => !i.allDay);
  const cols = `repeat(${days.length}, minmax(0, 1fr))`;

  const pick = (d: Drag) => {
    const start = Math.min(d.a, d.b);
    let end = Math.max(d.a, d.b);
    if (d.resize !== undefined) return resizeSlot(d.resize, end);
    if (!d.moved) end = start + (availability ? (avail?.duration ?? 30) : 30) * MIN;
    else end = Math.max(end, start + 15 * MIN);
    if (availability) addSlot(start, end);
    else createAt(start, end);
  };

  const onDown = (day: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const col = e.currentTarget;
    const target = e.target as HTMLElement;
    const handle = target.closest<HTMLElement>(".cal-ev-handle");
    if (!handle && target.closest(".cal-ev")) return; // block clicks are handled by the block
    e.preventDefault();
    col.setPointerCapture(e.pointerId);
    if (handle) {
      const i = Number(handle.dataset.slot);
      const sl = avail?.slots[i];
      if (!sl) return;
      setDrag({ day, a: sl.start, b: sl.end, y0: e.clientY, moved: true, resize: i });
      return;
    }
    const t = timeAt(day, col, e.clientY, "floor");
    setDrag({ day, a: t, b: t + 15 * MIN, y0: e.clientY, moved: false });
  };
  const onMove = (day: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.day !== day) return;
    const moved = drag.moved || Math.abs(e.clientY - drag.y0) > 5;
    const t = timeAt(day, e.currentTarget, e.clientY, "ceil");
    if (drag.resize !== undefined) return setDrag({ ...drag, b: Math.max(drag.a + 15 * MIN, t) });
    setDrag({ ...drag, moved, b: t > drag.a ? t : timeAt(day, e.currentTarget, e.clientY, "floor") });
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const d = drag;
    setDrag(null);
    pick(d);
  };

  return (
    <div className={`cal-grid ${mode}${availability ? " avail-mode" : ""}`}>
      <div className="cal-scroll" ref={scroller}>
        <div className="cal-sticky">
          {mode === "week" && (
            <div className="cal-dayheads" style={{ gridTemplateColumns: cols }}>
              {days.map((d) => {
                const h = dayHeader(d);
                return (
                  <button key={d} className={`cal-dayhead${d === todayStart ? " today" : ""}`} onClick={() => setState({ calDate: d })}>
                    <span>{h.dow}</span> <b>{h.day}</b>
                  </button>
                );
              })}
            </div>
          )}
          {allDay.length > 0 && (
            <div className="cal-allday" style={{ gridTemplateColumns: cols }}>
              {days.map((d) => (
                <div key={d} className="cal-allday-col">
                  {allDay
                    .filter((i) => i.start < addDays(d, 1) && i.end > d)
                    .map((i) => (
                      <Block key={i.key} item={i} chip dimmed={availability} />
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="cal-body" style={{ height: 24 * HOUR_PX }}>
          <div className="cal-axis">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} style={{ top: (i + 1) * HOUR_PX }}>
                {hourLabel(i + 1)}
              </span>
            ))}
          </div>
          <div className="cal-cols" style={{ gridTemplateColumns: cols }}>
            {days.map((d) => (
              <DayColumn key={d} day={d} items={timed} now={now} dimmed={availability} drag={drag?.day === d ? drag : null} onPointerDown={onDown(d)} onPointerMove={onMove(d)} onPointerUp={onUp} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  items,
  now,
  dimmed,
  drag,
  ...handlers
}: {
  day: number;
  items: GridItem[];
  now: number;
  dimmed: boolean;
  drag: Drag | null;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const end = addDays(day, 1);
  const shown = useMemo(() => {
    if (drag?.resize === undefined) return items;
    return items.map((i) => (i.kind === "slot" && i.slotIndex === drag.resize ? { ...i, end: Math.max(drag.a, drag.b), title: fmtRange(i.start, Math.max(drag.a, drag.b)) } : i));
  }, [items, drag]);
  const placed = useMemo(() => layoutDay(shown.filter((i) => i.start < end && i.end > day), day, end), [shown, day, end]);
  const isToday = day === startOfDay(now);
  const theme = useApp((s) => s.theme);
  const ghost = drag && drag.resize === undefined ? { top: ((Math.min(drag.a, drag.b) - day) / MIN) * (HOUR_PX / 60), height: Math.max(((Math.abs(drag.b - drag.a) || 15 * MIN) / MIN) * (HOUR_PX / 60) - 1, 11) } : null;
  return (
    <div className={`cal-col${isToday ? " today" : ""}`} {...handlers}>
      {placed.map((p) => (
        <Block key={p.item.key} item={p.item} placed={p} dimmed={dimmed} />
      ))}
      {ghost && (
        <div
          className="cal-ev focused ghost"
          style={{ ...toneVars(calTone("violet", theme, { style: "focused", past: false })), top: ghost.top, height: ghost.height, left: 0, width: "calc(100% - 2px)" } as CSSProperties}
        >
          <div className="cal-ev-time">{fmtRange(Math.min(drag!.a, drag!.b), Math.max(drag!.a, drag!.b))}</div>
        </div>
      )}
      {isToday && (
        <div className="cal-now" style={{ top: ((now - day) / MIN) * (HOUR_PX / 60) - 1 }}>
          <span className="cal-now-bulb" />
        </div>
      )}
    </div>
  );
}

/** Tone of a grid item: availability mode recedes the real events to their past steps (no opacity on text). */
function itemTone(item: GridItem, theme: Theme, dimmed: boolean) {
  const t = calTone(item.hue, theme, { style: item.style, past: item.past || (dimmed && item.kind !== "slot") });
  return item.kind === "invite" ? { ...t, borderWidth: 1.5 } : t;
}

function Block({ item, placed, chip, dimmed = false }: { item: GridItem; placed?: Placed; chip?: boolean; dimmed?: boolean }) {
  const theme = useApp((s) => s.theme);
  const mins = (item.end - item.start) / MIN;
  const short = mins < 45;
  const slot = item.kind === "slot"; // title already is the time range
  const style = {
    ...toneVars(itemTone(item, theme, dimmed)),
    ...(placed ? { top: placed.top, height: placed.height, left: `${placed.left}%`, width: `calc(${placed.width}% - 2px)`, zIndex: item.highlight ? 40 : placed.z } : {}),
  } as CSSProperties;
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (item.kind === "slot" && item.slotIndex !== undefined) return removeSlot(item.slotIndex);
    if (item.kind === "invite") return emit("focusInvite");
    if (item.event) openPopover(item.event, e.currentTarget);
  };
  // geometry: padding 4px, 3px at exactly 30 min, 0 under 30 min (radius 2.5px there)
  const size = mins < 30 ? " tiny" : mins === 30 ? " half" : "";
  const cls = `${chip ? "cal-chip" : "cal-ev"} ${item.style} k-${item.kind}${item.past ? " past" : ""}${item.highlight ? " hl" : ""}${short ? " short" : ""}${chip ? "" : size}`;
  if (chip)
    return (
      <div className={cls} style={style} onClick={onClick} title={item.title}>
        <div className="cal-ev-title">{item.title}</div>
      </div>
    );
  return (
    <div className={cls} style={style} onClick={onClick} onPointerDown={(e) => item.kind !== "slot" && e.stopPropagation()} title={`${item.title}\n${fmtRange(item.start, item.end)}`}>
      <div className="cal-ev-title">
        {item.title}
        {short && !slot && <span className="cal-ev-time">, {fmtTime(item.start)}</span>}
      </div>
      {!short && !slot && <div className="cal-ev-time">{fmtRange(item.start, item.end)}</div>}
      {item.kind === "slot" && <div className="cal-ev-handle" data-slot={item.slotIndex} />}
    </div>
  );
}

function CalError() {
  const err = useApp((s) => s.calError);
  if (!err) return null;
  const scope = err.code === "calendar_scope" || /Calendar access not granted/.test(err.message);
  const url = err.message.match(/https?:\/\/\S+/)?.[0];
  return (
    <div className="cal-error">
      <div>{scope ? "Calendar access not granted yet." : err.message.replace(/\s*https?:\/\/\S+/, "")}</div>
      {scope && (
        <div className="el small">
          Run <code>iris auth login</code> in a terminal, then retry.
        </div>
      )}
      <div className="cal-error-actions">
        <button className="link small" onClick={retryCalendar}>
          Retry
        </button>
        {url && (
          <a className="link small" href={url} target="_blank" rel="noreferrer">
            Enable Calendar API
          </a>
        )}
        {scope && (
          <button className="link small" onClick={() => setState({ overlay: { kind: "settings", section: "accounts" } })}>
            Settings
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ day pane

export function DayPane() {
  const date = useApp((s) => s.calDate);
  const loading = useApp((s) => s.calLoading);
  useCalendarLoad();
  const items = useGridItems(date, addDays(date, 1));
  const days = useMemo(() => [date], [date]);
  return (
    <aside className="daypane">
      <header className="cal-head">
        <span className="cal-title">{dayTitle(date)}</span>
        {loading && <span className="cal-spin" title="Loading events" />}
        <span className="spacer" />
        <button className="icon-btn sm" title="Previous day (-)" aria-label="Previous day" onClick={() => shiftDay(-1)}>
          <Icon name="chevron-left" />
        </button>
        <button className="btn sm" title="Today (T)" onClick={dayToday}>
          Today
        </button>
        <button className="icon-btn sm" title="Next day (=)" aria-label="Next day" onClick={() => shiftDay(1)}>
          <Icon name="chevron-right" />
        </button>
        <button className="icon-btn sm" title="Create event (B)" aria-label="Create event" onClick={createAtNow}>
          <Icon name="plus" />
        </button>
        <button className="icon-btn sm" title="Week (0)" aria-label="Week" onClick={() => openWeek(date)}>
          <Icon name="calendar-week" />
        </button>
        <button className="icon-btn sm" title="Close calendar" aria-label="Close calendar" onClick={closeCalendar}>
          <Icon name="x" />
        </button>
      </header>
      <CalError />
      <TimeGrid days={days} items={items} mode="day" availability={false} />
    </aside>
  );
}

// ------------------------------------------------------------ week page

export function WeekPage() {
  const date = useApp((s) => s.calDate);
  const settings = useApp((s) => s.calSettings);
  const loading = useApp((s) => s.calLoading);
  const avail = useApp((s) => !!s.calAvail);
  useCalendarLoad();
  const ws = startOfWeek(date, settings.weekStartsOn);
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => addDays(ws, i)).filter((d) => {
        const dow = new Date(d).getDay();
        return settings.showWeekends || (dow !== 0 && dow !== 6);
      }),
    [ws, settings.showWeekends],
  );
  const items = useGridItems(ws, addDays(ws, 7));
  return (
    <div className={`weekpage${avail ? " avail" : ""}`}>
      <header className="week-top">
        <button className="btn" title="Today (T)" onClick={weekToday}>
          Today
        </button>
        <button className="icon-btn" title="View previous week (K)" aria-label="Previous week" onClick={() => shiftWeek(-1)}>
          <Icon name="chevron-left" />
        </button>
        <button className="icon-btn" title="View next week (J)" aria-label="Next week" onClick={() => shiftWeek(1)}>
          <Icon name="chevron-right" />
        </button>
        <span className="week-label">{weekLabel(days[0] ?? ws, days[days.length - 1] ?? addDays(ws, 6))}</span>
        {loading && <span className="cal-spin" title="Loading events" />}
        <span className="spacer" />
        {avail ? (
          <span className="week-mode">Share availability: click to add times</span>
        ) : (
          <button className="btn" title="Share availability (⌘⇧A)" onClick={startAvailability}>
            Share availability
          </button>
        )}
        {!avail && (
          <button className="btn-primary" title="Create (B)" onClick={createAtNow}>
            <Icon name="plus" size={14} stroke={2} />
            Create
          </button>
        )}
        <button className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={() => (avail ? cancelAvailability() : closeWeek())}>
          <Icon name="x" />
        </button>
      </header>
      <div className="week-main">
        <aside className="week-side">{avail ? <AvailabilityPanel /> : <WeekSidebar />}</aside>
        <div className="week-grid">
          <CalError />
          <TimeGrid days={days} items={items} mode="week" availability={avail} />
        </div>
      </div>
    </div>
  );
}

function MiniMonth() {
  const date = useApp((s) => s.calDate);
  const wso = useApp((s) => s.calSettings.weekStartsOn);
  const [month, setMonth] = useState(() => new Date(date).setDate(1));
  useEffect(() => setMonth(new Date(new Date(date).setDate(1)).setHours(0, 0, 0, 0)), [date]);
  const first = startOfWeek(month, wso);
  const today = startOfDay(Date.now());
  const ws = startOfWeek(date, wso);
  const m = new Date(month);
  const labels = wso === 1 ? ["M", "T", "W", "T", "F", "S", "S"] : ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div className="minimonth">
      <div className="minimonth-head">
        <span>{m.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        <span className="spacer" />
        <button className="icon-btn sm" title="Previous month" aria-label="Previous month" onClick={() => setMonth(new Date(m.getFullYear(), m.getMonth() - 1, 1).getTime())}>
          <Icon name="chevron-left" size={14} />
        </button>
        <button className="icon-btn sm" title="Next month" aria-label="Next month" onClick={() => setMonth(new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime())}>
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
      <div className="minimonth-grid">
        {labels.map((l, i) => (
          <span key={`l${i}`} className="mm-dow">
            {l}
          </span>
        ))}
        {Array.from({ length: 42 }, (_, i) => {
          const d = addDays(first, i);
          const dd = new Date(d);
          const inWeek = d >= ws && d < addDays(ws, 7);
          return (
            <button
              key={d}
              className={`mm-day${dd.getMonth() !== m.getMonth() ? " out" : ""}${d === today ? " today" : ""}${inWeek ? " inweek" : ""}${d === date ? " on" : ""}`}
              onClick={() => setState({ calDate: d })}
            >
              {dd.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WeekSidebar() {
  const calendars = useApp((s) => s.calendars);
  const settings = useApp((s) => s.calSettings);
  // one group per account (unified: every account's calendars are shown together)
  const groups = useApp((s) => {
    const ids = [...new Set(calendars.map((c) => c.accountId))];
    if (!ids.length) ids.push(s.route.account);
    return ids.map((id) => ({ id, email: accountEmail(s, id), color: accountColor(s, id) }));
  });
  const multi = groups.length > 1;
  return (
    <>
      <MiniMonth />
      {groups.map((g) => (
        <div key={g.id} className="side-sec">
          <div className="contact-h side-acct" title={g.email}>
            {multi && <span className="acct-dot" style={{ "--acct": g.color } as CSSProperties} />}
            <span>{g.email}</span>
          </div>
          {calendars
            .filter((c) => c.accountId === g.id || (!multi && !c.accountId))
            .map((c) => (
              <CalCheck key={calKey(c)} hue={hueOf({ hex: c.color })} checked={c.selected} title={c.summary} onToggle={() => void toggleCalendar(c)}>
                {c.primary ? `${c.summary} (primary)` : c.summary}
              </CalCheck>
            ))}
          {!calendars.length && <div className="el small">No calendars yet.</div>}
        </div>
      ))}
      <div className="side-sec">
        <div className="contact-h">View</div>
        <CalCheck hue="pewter" checked={settings.weekStartsOn === 1} onToggle={() => setCalSettings({ weekStartsOn: settings.weekStartsOn === 1 ? 0 : 1 })}>
          Start week on Monday
        </CalCheck>
        <CalCheck hue="pewter" checked={settings.showWeekends} onToggle={() => setCalSettings({ showWeekends: !settings.showWeekends })}>
          Show weekends
        </CalCheck>
        <CalCheck hue="pewter" checked={settings.showDeclined} onToggle={() => setCalSettings({ showDeclined: !settings.showDeclined })}>
          Show declined events
        </CalCheck>
      </div>
    </>
  );
}

/**
 * Checkbox row (replaces the native input): swatch-filled box with a check when on, a ring when off.
 * A button with role=checkbox; Space/Enter toggle it and stay away from the global shortcuts (Space = Today).
 */
export function CalCheck({
  hue,
  checked,
  title,
  disabled,
  className = "",
  onToggle,
  children,
}: {
  hue: CalHue;
  checked: boolean;
  title?: string;
  disabled?: boolean;
  className?: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const theme = useApp((s) => s.theme);
  const on = calTone(hue, theme, { style: "filled", past: false });
  const off = calTone(hue, theme, { style: "bordered", past: false });
  const vars = { "--ev-swatch": on.swatch, "--ev-fg": on.fg, "--ev-border": off.border } as CSSProperties;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`cal-row${checked ? " on" : ""} ${className}`}
      title={title}
      disabled={disabled}
      style={vars}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") e.stopPropagation();
      }}
    >
      <span className="cal-check">{checked && <Icon name="check" size={12} stroke={2} />}</span>
      <span className="cal-name">{children}</span>
    </button>
  );
}

function AvailabilityPanel() {
  const a = useApp((s) => s.calAvail);
  const tz = localTimeZone();
  const preview = useMemo(() => (a ? renderAvailabilityText(a.slots, a.duration, tz) : ""), [a?.slots, a?.duration]);
  if (!a) return null;
  return (
    <div className="avail-panel">
      <div className="avail-title">Share availability</div>
      <div className="contact-h">Duration</div>
      <div className="seg">
        {[15, 30, 45, 60].map((d) => (
          <button key={d} className={a.duration === d ? "on" : ""} onClick={() => setAvailDuration(d)}>
            {d} min
          </button>
        ))}
      </div>
      <div className="contact-h">Time zone</div>
      <div className="small">{tz}</div>
      <p className="el small">Click the calendar to add a slot, drag to pick a range, drag a slot's bottom edge to resize. Click a slot to remove it.</p>
      <button className="btn avail-suggest" disabled={a.suggesting} onClick={() => void suggestSlots()}>
        <Icon name="sparkles" size={14} />
        {a.suggesting ? "Finding free time…" : "Suggest free times"}
      </button>
      {a.slots.length > 0 && (
        <>
          <div className="contact-h">Slots</div>
          <div className="avail-slots">
            {a.slots.map((s, i) => (
              <div key={`${s.start}-${i}`} className="avail-slot">
                <span>
                  {dayTitle(s.start)} · {fmtRange(s.start, s.end)}
                </span>
                <button className="icon-btn xs" title="Remove" aria-label="Remove slot" onClick={() => removeSlot(i)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="contact-h">Preview</div>
          <div className="avail-preview">{preview}</div>
        </>
      )}
      <div className="avail-actions">
        <button className="primary" disabled={!a.slots.length} onClick={() => void confirmAvailability()}>
          Insert <kbd>↵</kbd>
        </button>
        <button className="link small" onClick={cancelAvailability}>
          Cancel <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ event popover

const STATUS_BADGE: Record<string, { icon?: IconName; t?: string; c: string; label: string }> = {
  accepted: { icon: "check", c: "ok", label: "Going" },
  declined: { icon: "x", c: "no", label: "Not going" },
  tentative: { t: "?", c: "maybe", label: "Maybe" },
  needsAction: { c: "wait", label: "Awaiting" },
};

export function AttendeeRow({ a, organizer }: { a: EventAttendee; organizer?: boolean }) {
  const b = STATUS_BADGE[a.responseStatus] ?? STATUS_BADGE.needsAction;
  return (
    <div className="att-row" title={`${a.email} · ${b.label}`}>
      <span className="avatar sm" style={{ background: avatarColor(a.email) }}>
        {initials(a)}
        <span className={`att-badge ${b.c}`}>{b.icon ? <Icon name={b.icon} size={12} stroke={2} /> : b.t}</span>
      </span>
      <span className="att-person">
        {nameOf(a)}
        {a.self ? " (you)" : ""}
        {organizer || a.organizer ? <span className="el"> (organizer)</span> : null}
        {a.optional ? <span className="el"> (optional)</span> : null}
      </span>
    </div>
  );
}

interface Ask {
  title: string;
  text?: string;
  options: { label: string; run: () => void; primary?: boolean }[];
}

/** Row label: a 16px icon in the 24px gutter (the text stays as the accessible name and tooltip). */
export function RowIcon({ name, label, className = "pop-k" }: { name: IconName; label: string; className?: string }) {
  return (
    <span className={className} title={label}>
      <Icon name={name} title={label} />
    </span>
  );
}

export function EventPopover() {
  const pop = useApp((s) => s.calPopover);
  const calendars = useApp((s) => s.calendars);
  const multi = useApp((s) => (s.status?.accounts.length ?? 0) > 1);
  const acctInfo = useApp((s) => (s.calPopover ? { email: accountEmail(s, s.calPopover.event.accountId), color: accountColor(s, s.calPopover.event.accountId) } : null));
  const ref = useRef<HTMLDivElement>(null);
  const theme = useApp((s) => s.theme);
  const [pos, setPos] = useState<{ top: number; left: number; ox: number; oy: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [more, setMore] = useState(false);
  const [people, setPeople] = useState<MeetingPerson[]>([]);
  const now = useNow(60_000);
  const key = pop ? evKey(pop.event) : "";
  useEffect(() => {
    setMenu(false);
    setAsk(null);
    setMore(false);
    setPeople([]);
    // who could be researched (attendees, or a name from the title); older daemons 404 → no button
    const ev = pop?.event;
    if (!ev || ev.allDay) return;
    let alive = true;
    void api
      .get<{ people: MeetingPerson[] }>(`/api/events/${encodeURIComponent(ev.calendarId)}/${encodeURIComponent(ev.id)}/people`, { account: ev.accountId })
      .then((r) => alive && setPeople(r.people ?? []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  useLayoutEffect(() => {
    if (!pop || !ref.current) return setPos(null);
    const W = ref.current.offsetWidth;
    const H = ref.current.offsetHeight;
    const r = pop.rect;
    let left = r.left - W - 10;
    if (left < 8) left = Math.min(window.innerWidth - W - 8, r.right + 10);
    const top = Math.max(60, Math.min(window.innerHeight - H - 12, r.top - 8));
    left = Math.max(8, left);
    // transform-origin at the trigger (clamped to the popover's edge), so it scales out of the clicked block
    const ox = Math.max(0, Math.min(W, (r.left + r.right) / 2 - left));
    const oy = Math.max(0, Math.min(H, (r.top + r.bottom) / 2 - top));
    setPos({ top, left, ox, oy });
  }, [pop, ask, menu, more, people.length]);
  if (!pop) return null;
  const e = pop.event;
  // "me" = the account this copy of the event lives in
  const me = [e.accountId?.toLowerCase(), acctInfo?.email.toLowerCase()].filter((x): x is string => !!x);
  const cal = calendarOf(calendars, e);
  const writable = !cal || cal.accessRole === "owner" || cal.accessRole === "writer";
  const iOrganize = !!e.organizer.self || me.includes(e.organizer.email.toLowerCase()) || e.organizer.email === e.calendarId;
  const editable = writable && (iOrganize || !e.attendees.length);
  const others = guests(e);
  const conf = conferenceOf(e, me[1] ?? me[0]);
  const self = e.attendees.find((a) => a.self);
  const canRsvp = !!(e.selfResponse || self) && !iOrganize;
  const recurring = !!e.recurringEventId;
  const tone = calTone(hueOf({ hex: e.color || cal?.color }), theme, { style: "filled", past: false });

  const rsvp = (r: "accepted" | "tentative" | "declined") => {
    if (e.selfResponse === r) return;
    const label = r === "accepted" ? "Yes" : r === "tentative" ? "Maybe" : "No";
    if (recurring)
      setAsk({
        title: `RSVP ${label} to recurring event`,
        options: [
          { label: "This event", run: () => (setAsk(null), void rsvpEvent(e, r, "this")) },
          { label: "All events", primary: true, run: () => (setAsk(null), void rsvpEvent(e, r, "all")) },
        ],
      });
    else void rsvpEvent(e, r);
  };
  const del = () => {
    setMenu(false);
    const go = (scope?: "this" | "all") => {
      if (others.length && iOrganize)
        setAsk({
          title: "Send an update?",
          text: "Let guests know this event was canceled.",
          options: [
            { label: "Go back", run: () => setAsk(null) },
            { label: "Don't send", run: () => deleteEvent(e, { notify: false, scope }) },
            { label: "Send", primary: true, run: () => deleteEvent(e, { notify: true, scope }) },
          ],
        });
      else deleteEvent(e, { notify: false, scope });
    };
    if (recurring)
      setAsk({
        title: "Delete recurring event",
        options: [
          { label: "Cancel", run: () => setAsk(null) },
          { label: "This event", run: () => go("this") },
          { label: "All events", primary: true, run: () => go("all") },
        ],
      });
    else go();
  };
  const research = (p: Pick<MeetingPerson, "name" | "email"> & { nameSource?: MeetingPerson["nameSource"] }) => {
    closePopover();
    void researchPerson({ name: p.name, email: p.email, nameSource: p.nameSource, accountId: e.accountId, eventId: e.id, calendarId: e.calendarId, eventTitle: e.summary });
  };
  const pickResearch = () =>
    people.length === 1
      ? research(people[0])
      : setAsk({
          title: "Research whom?",
          options: [...people.map((p) => ({ label: personLabel(p), run: () => research(p) })), { label: "Someone else…", run: () => research({ name: "", email: "" }) }],
        });
  const desc = e.description.replace(/<[^>]+>/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return (
    <>
      <div className="cal-pop-backdrop" onMouseDown={closePopover} />
      <div
        ref={ref}
        className="cal-pop"
        style={(pos ? { top: pos.top, left: pos.left, "--pop-ox": `${pos.ox}px`, "--pop-oy": `${pos.oy}px` } : { visibility: "hidden", top: 0, left: 0 }) as CSSProperties}
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="pop-head">
          <span className="cal-swatch" style={{ "--ev-swatch": tone.swatch } as CSSProperties} />
          <div className={`pop-title${editable ? " editable" : ""}`} onClick={() => editable && editEvent(e)} title={editable ? "Edit" : undefined}>
            {e.summary || "(No title)"}
          </div>
          <button className={`icon-btn sm${menu ? " on" : ""}`} title="More" aria-label="More" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="more" />
          </button>
          <button className="icon-btn sm" title="Close (Esc)" aria-label="Close" onClick={closePopover}>
            <Icon name="x" />
          </button>
          {menu && (
            <div className="pop-menu">
              {editable && <button onClick={() => editEvent(e)}>Edit</button>}
              {writable && <button onClick={del}>Delete</button>}
              {others.length > 0 && (
                <button
                  onClick={() => {
                    closePopover();
                    startCompose({ accountId: e.accountId, to: others.map((a) => ({ name: a.name, email: a.email })), subject: e.summary });
                  }}
                >
                  Email guest{others.length > 1 ? "s" : ""}
                </button>
              )}
              {e.htmlLink && (
                <a href={e.htmlLink} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
                  Open in Google Calendar
                  <Icon name="external-link" size={14} />
                </a>
              )}
            </div>
          )}
        </div>
        <div className="pop-rows">
          <div className="pop-row">
            <RowIcon name="clock" label="When" />
            <span className="pop-when">
              {whenLong(e)}
              {recurring ? <span className="el"> · Repeats</span> : null}
              {e.end < now ? <span className="el"> · Ended</span> : null}
            </span>
          </div>
          {e.location && !(conf && (e.location === conf.url || /^(google meet|zoom|microsoft teams|teams)$/i.test(e.location.trim()))) && (
            <div className="pop-row">
              <RowIcon name="map-pin" label="Where" />
              {isUrl(e.location) ? (
                <a className="link" href={e.location} target="_blank" rel="noreferrer">
                  {e.location}
                </a>
              ) : (
                <a className="link" href={`https://maps.google.com/maps?q=${encodeURIComponent(e.location)}`} target="_blank" rel="noreferrer">
                  {e.location}
                </a>
              )}
            </div>
          )}
          {conf && (
            <div className="pop-row top conf">
              <RowIcon name="video" label={conf.label} />
              <span className="pop-conf">
                <a className="btn-primary cal-join" href={conf.url} target="_blank" rel="noreferrer">
                  {conf.join}
                </a>
                <span className="el small pop-url">{conf.url.replace(/^https?:\/\//, "").replace(/[?&]authuser=[^&]*/, "")}</span>
              </span>
            </div>
          )}
          {e.attendees.length > 0 && (
            <div className="pop-row top">
              <RowIcon name="users" label="Who" />
              <div className="pop-who">
                <div className="el small">
                  {e.attendees.length} guest{e.attendees.length > 1 ? "s" : ""} · {e.attendees.filter((a) => a.responseStatus === "accepted").length} yes
                  {e.attendees.some((a) => a.responseStatus === "needsAction") ? ` · ${e.attendees.filter((a) => a.responseStatus === "needsAction").length} awaiting` : ""}
                </div>
                {sortAttendees(e.attendees, e.organizer.email)
                  .slice(0, more ? 100 : 8)
                  .map((a) => (
                    <AttendeeRow key={a.email} a={a} organizer={a.email === e.organizer.email} />
                  ))}
                {e.attendees.length > 8 && !more && (
                  <button className="link small" onClick={() => setMore(true)}>
                    and {e.attendees.length - 8} more
                  </button>
                )}
              </div>
            </div>
          )}
          {!e.attendees.length && e.organizer.email && !iOrganize && (
            <div className="pop-row">
              <RowIcon name="users" label="Organizer" />
              <span>
                {e.organizer.name || e.organizer.email}
                <span className="el"> (organizer)</span>
              </span>
            </div>
          )}
          {desc && (
            <div className="pop-row top">
              <RowIcon name="snippet" label="About" />
              <div className="pop-desc">{desc.length > 600 ? `${desc.slice(0, 600)}…` : desc}</div>
            </div>
          )}
          {cal && (
            <div className="pop-row">
              <RowIcon name="calendar" label="Calendar" />
              <span className="el">{cal.summary}</span>
            </div>
          )}
          {people.length > 0 && (
            <div className="pop-row pop-research">
              <RowIcon name="user-search" label="Research" />
              <button className="rsvp" title="Who is this? A report before the meeting" onClick={pickResearch}>
                {people.length === 1 ? `Research ${shortName(people[0])}` : `Research (${people.length} people)`}
              </button>
            </div>
          )}
          {multi && acctInfo && (
            <div className="pop-row">
              <RowIcon name="mail" label="Account" />
              <span className="pop-acct">
                <span className="acct-dot" style={{ "--acct": acctInfo.color } as CSSProperties} />
                <span className="el">{acctInfo.email}</span>
              </span>
            </div>
          )}
        </div>
        {ask ? (
          <div className="pop-ask">
            <div className="pop-ask-title">{ask.title}</div>
            {ask.text && <div className="el small">{ask.text}</div>}
            <div className="pop-ask-actions">
              {ask.options.map((o) => (
                <button key={o.label} className={o.primary ? "rsvp on" : "rsvp"} onClick={o.run}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          canRsvp && (
            <div className="pop-rsvp">
              <span className="pop-rsvp-k">RSVP</span>
              {(["accepted", "tentative", "declined"] as const).map((r) => (
                <button key={r} className={`rsvp${e.selfResponse === r ? " on" : ""}`} onClick={() => rsvp(r)}>
                  {r === "accepted" ? "Yes" : r === "tentative" ? "Maybe" : "No"}
                </button>
              ))}
            </div>
          )
        )}
      </div>
    </>
  );
}

