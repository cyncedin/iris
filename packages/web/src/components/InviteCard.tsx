// Meeting invite card above the messages.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Thread } from "@iris/core/types.ts";
import { addInviteToCalendar, calendarOf, rsvpAndDoneOn, rsvpInvite, selfEmails, showDay } from "../cal";
import { calTone, conferenceOf, hueOf, isUrl, sortAttendees, toneVars, whenLong } from "../calutil";
import { on } from "../bus";
import { comboOf } from "../keys";
import { useApp } from "../state";
import { AttendeeRow, RowIcon } from "./Calendar";

type Answer = "accepted" | "tentative" | "declined";
const LABEL: Record<Answer, string> = { accepted: "Yes", tentative: "Maybe", declined: "No" };
const REPLY_TEXT: Record<string, string> = { accepted: "has accepted", declined: "has declined", tentative: "responded maybe", needsAction: "has responded" };

export function InviteCard({ thread }: { thread: Thread }) {
  const inv = useApp((s) => (s.calInvite && s.calInvite.threadId === thread.id ? s.calInvite : null));
  const me = useApp((s) => selfEmails(s, thread.accountId));
  const andDone = useApp((s) => rsvpAndDoneOn(s));
  const theme = useApp((s) => s.theme);
  // the calendar the invite lives in (or lands in): the matched event's color, else that calendar's, else primary
  const calColor = useApp((s) => {
    const ev = s.calInvite?.threadId === thread.id ? s.calInvite.event : undefined;
    return ev?.color || (ev ? calendarOf(s.calendars, ev) : s.calendars.find((c) => c.primary && c.accountId === thread.accountId))?.color;
  });
  const card = useRef<HTMLDivElement>(null);
  const [askScope, setAskScope] = useState<Answer | null>(null);
  const [more, setMore] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(
    () =>
      on("focusInvite", () => {
        card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        card.current?.querySelector<HTMLButtonElement>("button.inv-btn.on, button.inv-btn")?.focus();
      }),
    [],
  );
  useEffect(() => {
    setAskScope(null);
    setMore(false);
    setAboutOpen(false);
  }, [inv?.messageId]);

  if (!inv) return null;
  const conf = conferenceOf(inv, me[1] ?? me[0]);
  const swatch = calTone(hueOf({ hex: calColor }), theme, { style: "filled", past: false }).swatch;
  const d = new Date(inv.start);
  const answer = (r: Answer) => {
    if (inv.selfResponse === r) return;
    if (inv.recurring) setAskScope(r);
    else void rsvpInvite(inv, r);
  };

  // ← → ↑ ↓ tab / ctrl+j/k/n/p move between buttons, enter/space press, esc back to the messages
  const onKeyDown = (e: React.KeyboardEvent) => {
    const combo = comboOf(e.nativeEvent);
    if (!combo || !card.current) return;
    const buttons = [...card.current.querySelectorAll<HTMLButtonElement>("button.inv-btn")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (dir: number) => {
      e.preventDefault();
      e.stopPropagation();
      buttons[(i + dir + buttons.length) % buttons.length]?.focus();
    };
    if (["right", "down", "tab", "ctrl+j", "ctrl+n"].includes(combo)) return move(1);
    if (["left", "up", "shift+tab", "ctrl+k", "ctrl+p"].includes(combo)) return move(-1);
    if (combo === "enter" || combo === "space") {
      e.preventDefault();
      e.stopPropagation();
      (document.activeElement as HTMLButtonElement | null)?.click();
      return;
    }
    if (combo === "esc") {
      e.preventDefault();
      e.stopPropagation();
      (document.activeElement as HTMLElement | null)?.blur();
    }
  };

  const who = sortAttendees(inv.attendees, inv.organizer.email);
  const about = inv.description.replace(/<[^>]+>/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const replyName = inv.replyFrom ? inv.replyFrom.name || inv.replyFrom.email : "";

  return (
    <div className={`invite k-${inv.kind}`} ref={card} onKeyDown={onKeyDown}>
      <div className="inv-head">
        <div className="inv-tile" style={toneVars(calTone("red", theme, { style: "bordered", past: false })) as CSSProperties}>
          <span>{d.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</span>
          <b>{d.getDate()}</b>
        </div>
        <div className="inv-headtext">
          <div className="inv-title">{inv.summary || "(No title)"}</div>
          <div className="el small inv-sub">
            <span className="cal-swatch sm" style={{ "--ev-swatch": swatch } as CSSProperties} />
            {inv.kind === "cancel" ? "Canceled event" : inv.kind === "reply" ? "Invitation response" : inv.kind === "update" ? "Updated invitation" : "Invitation"}
            {inv.organizer.email ? ` from ${inv.organizer.name || inv.organizer.email}` : ""}
          </div>
        </div>
      </div>

      <div className="inv-row">
        <RowIcon name={inv.kind === "cancel" ? "x" : "check"} label="RSVP" className="inv-k" />
        <div className="inv-v">
          {inv.kind === "cancel" ? (
            <span className="inv-note">Event has been canceled</span>
          ) : inv.kind === "reply" ? (
            <span className="inv-note">{replyName ? `${replyName} ${REPLY_TEXT[inv.replyFrom!.responseStatus] ?? "has responded"}` : "Response to your invitation"}</span>
          ) : askScope ? (
            <span className="inv-btns">
              <span className="small">RSVP {LABEL[askScope]} to recurring event:</span>
              <button className="inv-btn rsvp" autoFocus onClick={() => (setAskScope(null), void rsvpInvite(inv, askScope, { scope: "this" }))}>
                This event
              </button>
              <button className="inv-btn rsvp on" onClick={() => (setAskScope(null), void rsvpInvite(inv, askScope, { scope: "all" }))}>
                All events
              </button>
              <button className="inv-btn link small" onClick={() => setAskScope(null)}>
                Cancel
              </button>
            </span>
          ) : inv.canRsvp ? (
            <span className="inv-btns">
              {inv.kind === "update" && <span className="inv-note">Event has been changed · </span>}
              {(["accepted", "tentative", "declined"] as const).map((r) => (
                <button key={r} className={`inv-btn rsvp${inv.selfResponse === r ? " on" : ""}`} onClick={() => answer(r)} title={andDone ? `${LABEL[r]} and Mark Done` : LABEL[r]}>
                  {LABEL[r]}
                </button>
              ))}
              {andDone && <span className="el small">+ Mark Done</span>}
            </span>
          ) : inv.canAdd ? (
            <button className="inv-btn rsvp" onClick={() => void addInviteToCalendar(inv)}>
              Add to calendar
            </button>
          ) : (
            <span className="inv-note el">{inv.event ? "On your calendar" : "Not on your calendar"}</span>
          )}
        </div>
      </div>

      <div className="inv-row" onMouseEnter={() => showDay(inv.start, { focus: inv.start })}>
        <RowIcon name="calendar" label="When" className="inv-k" />
        <span className="inv-v">
          {whenLong(inv)}
          {inv.recurring ? <span className="el"> (recurring)</span> : null}
        </span>
      </div>
      {inv.location && !(conf && (inv.location === conf.url || /^(google meet|zoom|microsoft teams)$/i.test(inv.location))) && (
        <div className="inv-row">
          <RowIcon name="map-pin" label="Where" className="inv-k" />
          <a className="inv-v link" href={isUrl(inv.location) ? inv.location : `https://maps.google.com/maps?q=${encodeURIComponent(inv.location)}`} target="_blank" rel="noreferrer">
            {inv.location}
          </a>
        </div>
      )}
      {conf && (
        <div className="inv-row top conf">
          <RowIcon name="video" label="Video" className="inv-k" />
          <span className="inv-v inv-conf">
            <a className="btn-primary cal-join" href={conf.url} target="_blank" rel="noreferrer">
              {conf.join}
            </a>
            <span className="el small">{conf.url.replace(/^https?:\/\//, "").replace(/[?&]authuser=[^&]*/, "")}</span>
          </span>
        </div>
      )}
      {who.length > 0 && (
        <div className="inv-row top">
          <RowIcon name="users" label="Who" className="inv-k" />
          <div className="inv-v inv-who">
            {who.slice(0, more ? who.length : 15).map((a) => (
              <AttendeeRow key={a.email} a={a} organizer={a.email === inv.organizer.email} />
            ))}
            {who.length > 15 && !more && (
              <button className="link small" onClick={() => setMore(true)}>
                and {who.length - 15} more
              </button>
            )}
          </div>
        </div>
      )}
      {about && (
        <div className="inv-row top">
          <RowIcon name="snippet" label="About" className="inv-k" />
          <div className={`inv-v inv-about${aboutOpen ? " open" : ""}`} onClick={() => setAboutOpen(true)}>
            {about}
          </div>
        </div>
      )}
    </div>
  );
}
