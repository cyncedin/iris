// Create / edit event: Title, free-text When with 3 suggestions, Guests,
// Location, Description, Meet, Calendar. ⌘↵ saves, Esc discards.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "@iris/core/types.ts";
import { calKey, closeEventForm, defaultCalendar, saveEvent, selfEmails, writableCalendars } from "../cal";
import { durationLabel, guests, MIN, startOfDay, whenLong, whenSuggestions, whenText, type EventFormInit } from "../calutil";
import { comboOf } from "../keys";
import { getState, setState, useApp } from "../state";
import { CalCheck } from "./Calendar";
import { RecipientInput } from "./Composer";
import { Icon, type IconName } from "./Icon";

/** A form line with a 16px icon in the left gutter. The field's own text label is visually hidden. */
function Line({ icon, label, children, top }: { icon: IconName; label: string; children: React.ReactNode; top?: boolean }) {
  return (
    <div className={`ef-line${top ? " top" : ""}`}>
      <span className="ef-icon" title={label}>
        <Icon name={icon} />
      </span>
      <div className="ef-body">{children}</div>
    </div>
  );
}

export function EventForm() {
  const init = useApp((s) => s.calForm);
  if (!init) return null;
  return <EventFormInner key={init.key} init={init} />;
}

function EventFormInner({ init }: { init: EventFormInit }) {
  const calendars = useApp((s) => s.calendars);
  const defaultMeet = useApp((s) => s.status?.settings.calendar?.defaultMeetingLink === "meet");
  const dayPane = useApp((s) => s.calPane === "day");
  const allMine = useApp((s) => selfEmails(s));
  const initialWhen = init.start !== undefined && init.end !== undefined ? whenText(init.start, init.end, !!init.allDay) : "";
  const [summary, setSummary] = useState(init.summary ?? "");
  const [when, setWhen] = useState(initialWhen);
  const [pick, setPick] = useState(0);
  const [guestList, setGuests] = useState<Address[]>(init.guests ?? []);
  const [location, setLocation] = useState(init.location ?? "");
  const [description, setDescription] = useState(init.description ?? "");
  const [conference, setConference] = useState(init.conference ?? (init.mode === "create" ? defaultMeet : false));
  // calendar choice as `calKey` (account/id): calendar ids repeat across accounts
  const [calChoice, setCalChoice] = useState(init.calendarId ? calKey({ accountId: init.event?.accountId, id: init.calendarId }) : "");
  const [askNotify, setAskNotify] = useState(false);
  const [scope, setScope] = useState<"this" | "all">("this");
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const whenRef = useRef<HTMLInputElement>(null);
  const guestRef = useRef<HTMLInputElement>(null);
  const editing = init.mode === "edit" && !!init.event;
  const recurring = !!init.event?.recurringEventId;
  const writable = writableCalendars({ ...getState(), calendars });
  const fallback = defaultCalendar({ ...getState(), calendars });
  const choice = calChoice || (fallback ? calKey(fallback) : "");
  const chosenCal = writable.find((c) => calKey(c) === choice);
  const multiAccount = useApp((s) => (s.status?.accounts.length ?? 0) > 1);
  // "me" = the account the event lives in (edit) or lands in (create); my other accounts can be guests
  const eventAccount = editing ? init.event!.accountId : chosenCal?.accountId;
  const me = eventAccount ? selfEmails(getState(), eventAccount) : allMine;

  const suggestions = useMemo(() => {
    const list = whenSuggestions(when);
    if (init.start !== undefined && init.end !== undefined && when === initialWhen) {
      const fixed = { start: init.start, end: init.end, allDay: !!init.allDay };
      return [fixed, ...list.filter((x) => !(x.start === fixed.start && x.end === fixed.end && x.allDay === fixed.allDay))].slice(0, 3);
    }
    return list;
  }, [when]);
  useEffect(() => setPick(0), [when]);
  const chosen = suggestions[Math.min(pick, suggestions.length - 1)];

  // the grid shows the chosen time as a draft block; the day pane follows its date
  const lastDay = useRef<number | null>(null);
  useEffect(() => {
    if (!chosen) return;
    const s = getState();
    const day = startOfDay(chosen.start);
    const follow = lastDay.current !== day && !!s.calPane;
    lastDay.current = day;
    setState({
      calDraft: { ...chosen, title: summary.trim() || (editing ? init.event!.summary : "New event") },
      ...(follow ? { calDate: day, calFocus: { at: chosen.start, seq: (s.calFocus?.seq ?? 0) + 1 } } : {}),
    });
  }, [chosen?.start, chosen?.end, chosen?.allDay, summary]);
  useEffect(() => () => setState({ calDraft: null }), []);
  // the Guests line shows an icon instead of its text label; RecipientInput takes no placeholder prop
  useEffect(() => guestRef.current?.setAttribute("placeholder", "Guests"), []);
  useEffect(() => {
    if (init.summary && !initialWhen) whenRef.current?.focus();
    else titleRef.current?.focus();
  }, []);

  const dirty =
    summary !== (init.summary ?? "") ||
    when !== initialWhen ||
    JSON.stringify(guestList.map((g) => g.email)) !== JSON.stringify((init.guests ?? []).map((g) => g.email)) ||
    location !== (init.location ?? "") ||
    description !== (init.description ?? "");

  const discard = () => {
    if (dirty && !confirm(editing ? "Discard your changes?" : "Discard this event?")) return;
    closeEventForm();
  };

  const save = async (notify?: boolean) => {
    if (!chosen || busy) return;
    const ev = init.event;
    const iOrganize = !ev || !!ev.organizer.self || me.includes(ev.organizer.email.toLowerCase()) || ev.organizer.email === ev.calendarId;
    if (editing && notify === undefined && iOrganize && (guests(ev!).length > 0 || guestList.length > 0)) return setAskNotify(true);
    setBusy(true);
    const ok = await saveEvent(
      init,
      {
        summary: summary.trim(),
        start: chosen.start,
        end: chosen.end,
        allDay: chosen.allDay,
        attendees: guestList.map((g) => g.email).filter((e) => !me.includes(e.toLowerCase())),
        location: location.trim(),
        description,
        conference,
        calendarId: editing ? undefined : chosenCal?.id,
        accountId: editing ? undefined : chosenCal?.accountId,
      },
      { notify, scope: recurring ? scope : undefined },
    );
    if (!ok) setBusy(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const combo = comboOf(e.nativeEvent);
    if (!combo) return;
    if (combo === "mod+enter") {
      e.preventDefault();
      void save();
    } else if (combo === "esc") {
      e.preventDefault();
      if (askNotify) setAskNotify(false);
      else discard();
    }
    // keep single-key shortcuts away from the inbox while the editor is open
    e.stopPropagation();
  };

  return (
    <div className={`modal-backdrop event-backdrop${dayPane ? " with-daypane" : ""}`} onMouseDown={discard}>
      <div className="modal event-form" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="modal-title">{editing ? "Edit event" : "New event"}</div>
        <input
          ref={titleRef}
          className="ef-title"
          placeholder="Event title"
          maxLength={200}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              whenRef.current?.focus();
            }
          }}
        />
        <Line icon="clock" label="When">
          <div className="field">
            <span className="field-label">When</span>
            <input
              ref={whenRef}
              className="subject-input"
              placeholder="tomorrow 3pm, fri 10-11, oct 30 all day, 45 min…"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPick((p) => (p + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
                } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && chosen) {
                  e.preventDefault();
                  setWhen(whenText(chosen.start, chosen.end, chosen.allDay));
                }
              }}
            />
          </div>
          <div className="ef-sugg">
            {suggestions.map((s, i) => (
              <button key={`${s.start}-${s.end}-${s.allDay}`} className={`ef-opt${i === pick ? " on" : ""}`} onClick={() => setPick(i)} onDoubleClick={() => void save()}>
                <span className={`ef-radio${i === pick ? " on" : ""}`} />
                <span className="ef-when">{whenLong(s)}</span>
                <span className="ef-dur">{s.allDay ? "All day" : durationLabel(Math.round((s.end - s.start) / MIN))}</span>
              </button>
            ))}
          </div>
        </Line>
        <Line icon="users" label="Guests">
          <RecipientInput label="Guests" value={guestList} onChange={setGuests} inputRef={guestRef} />
          {guestList.length > 0 && !editing && <div className="ef-hint el small">Guests get an email invitation when you save.</div>}
        </Line>
        <Line icon="map-pin" label="Where">
          <div className="field">
            <span className="field-label">Where</span>
            <input className="subject-input" placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
        </Line>
        <Line icon="snippet" label="Description" top>
          <textarea className="ef-desc" placeholder="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Line>
        <Line icon="video" label="Meeting link">
          <div className="ef-row">
            <CalCheck
              hue="pewter"
              className="ef-meet"
              checked={conference}
              disabled={editing && !!init.event?.conferenceUrl}
              title={editing && init.event?.conferenceUrl ? "Remove the link in Google Calendar" : undefined}
              onToggle={() => setConference((c) => !c)}
            >
              Google Meet link
            </CalCheck>
            <span className="spacer" />
            <span className="el small">Calendar</span>
            <span className="select ef-select">
              <select value={editing ? calKey({ accountId: init.event!.accountId, id: init.event!.calendarId }) : choice} disabled={editing} onChange={(e) => setCalChoice(e.target.value)}>
                {(editing ? calendars.filter((c) => c.id === init.event!.calendarId && (!c.accountId || c.accountId === init.event!.accountId)) : writable).map((c) => (
                  <option key={calKey(c)} value={calKey(c)}>
                    {c.summary}
                    {c.primary ? " (primary)" : ""}
                    {multiAccount && !c.primary ? ` · ${c.accountId}` : ""}
                  </option>
                ))}
                {!writable.length && !editing && <option value="">Primary</option>}
              </select>
              <Icon name="chevron-down" size={14} />
            </span>
          </div>
        </Line>
        {editing && recurring && (
          <div className="ef-row">
            <span className="el small">Apply to</span>
            <label className="modal-check ef-check">
              <input type="radio" checked={scope === "this"} onChange={() => setScope("this")} /> This event
            </label>
            <label className="modal-check ef-check">
              <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> All events
            </label>
          </div>
        )}
        {askNotify ? (
          <div className="ef-ask">
            <span className="ef-ask-title">Send an update?</span>
            <span className="el small">Let guests know about the change.</span>
            <span className="spacer" />
            <button className="link small" onClick={() => setAskNotify(false)}>
              Go back
            </button>
            <button className="rsvp" onClick={() => void save(false)}>
              Don't send
            </button>
            <button className="rsvp on" autoFocus onClick={() => void save(true)}>
              Send
            </button>
          </div>
        ) : (
          <div className="ef-foot">
            <button className="primary" disabled={busy || !chosen} onClick={() => void save()}>
              {busy ? "Saving…" : editing ? "Save" : guestList.length ? "Save & invite" : "Save"} <kbd>⌘↵</kbd>
            </button>
            <button className="link small" onClick={discard}>
              Cancel <kbd>Esc</kbd>
            </button>
            {editing && init.event?.htmlLink && (
              <a className="link small ef-gcal" href={init.event.htmlLink} target="_blank" rel="noreferrer">
                More options in Google Calendar
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
