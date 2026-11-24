// Calendar service:
// - sync: initial events.list(timeMin = now-30d, no timeMax, singleEvents) → nextSyncToken → incremental with the token only.
//   Instances are cached up to now+120d (cap applied when storing; the window slides with a daily full resync).
//   Ranges outside the cache are fetched on demand without storing a token.
// - writes (insert/patch/delete/RSVP/import) are followed by an immediate re-sync of that calendar + `calendar-changed`.
// - own busy time and availability come from cached events; meeting notifications at lead time.
import { isAllAccounts, type IrisSettings } from "./config.ts";
import type { DB } from "./db.ts";
import type { Bus } from "./events.ts";
import { conferenceUrlOf, guests, mergeRanges, parseYmd } from "./gcal/model.ts";
import { parseIcs, partstatToResponse, type IcsEvent } from "./ics.ts";
import { parseAddressList } from "./mime.ts";
import { inBackground, ProviderError, type CalendarEventWrite, type CalendarProvider, type MailProvider, type SendUpdates } from "./provider.ts";
import { pmap } from "./sync.ts";
import type {
  Calendar,
  CalendarEvent,
  CalendarInvite,
  EventAttendee,
  EventInput,
  InviteMethod,
  Message,
  RecurrenceScope,
  ResponseStatus,
  TimeRange,
} from "./types.ts";
import { parseEventText, parseWhen } from "./when.ts";

const DAY = 86_400_000;
const MIN = 60_000;
export const CALENDAR_WINDOW = { pastDays: 30, futureDays: 120 };
export const WORKING_HOURS = { start: 9, end: 18 };
const DEFAULT_MINUTES = 30;

interface CalendarRow {
  account_id: string;
  id: string;
  summary: string;
  color: string;
  is_primary: number;
  selected_remote: number;
  selected_local: number | null;
  access_role: string;
  time_zone: string;
  position: number;
  color_local: string | null;
  notify_local: number | null;
  /** events.list answered 404: events cleared, not synced again until a full sync */
  disabled: number;
  sync_token: string | null;
  window_start: number | null;
  window_end: number | null;
  synced_at: number | null;
}

export interface CalendarDeps {
  db: DB;
  bus: Bus;
  provider: (accountId: string) => CalendarProvider;
  mail: (accountId: string) => MailProvider;
  acct: (accountId?: string) => string;
  /** every account id in connection order (reads with `account=all`); default: the first account only */
  accounts?: () => string[];
  settings: () => IrisSettings;
}

export type RsvpResponse = Exclude<ResponseStatus, "needsAction">;

/** Thrown for features the contract allows to answer with 501 (recurring "this and following"). */
export class NotImplementedError extends Error {}

/** "yes" / "no" / "maybe" (CLI) or the Google values. */
export function normalizeResponse(r: string): RsvpResponse {
  const v = r.trim().toLowerCase();
  if (["accepted", "accept", "yes", "y"].includes(v)) return "accepted";
  if (["declined", "decline", "no", "n"].includes(v)) return "declined";
  if (["tentative", "maybe", "m"].includes(v)) return "tentative";
  throw new Error(`Unknown RSVP response: ${r} (use accepted, declined or tentative)`);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

const ceil15 = (ms: number) => Math.ceil(ms / (15 * MIN)) * 15 * MIN;
const floor15 = (ms: number) => Math.floor(ms / (15 * MIN)) * 15 * MIN;

/** epoch ms | "1761...": ms | ISO | "2026-10-26" (local midnight) | natural language */
function toMs(v: number | string | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = v.trim();
  if (/^\d{10,13}$/.test(s)) return s.length === 10 ? Number(s) * 1000 : Number(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseYmd(s);
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    if (Number.isFinite(t)) return t;
  }
  const t = parseWhen(s, new Date(), WORKING_HOURS.start);
  if (t === null) throw new Error(`Could not understand time: ${v}`);
  return t;
}

export function attendeeEmails(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  const emails = list.flatMap((x) => parseAddressList(String(x)).map((a) => a.email));
  for (const e of emails) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`Invalid attendee address: ${e}`);
  return [...new Set(emails)];
}

/** Busy for availability: not free (transparent), not declined, not cancelled; out-of-office always counts. */
function isBusy(e: CalendarEvent): boolean {
  if (e.status === "cancelled" || e.selfResponse === "declined") return false;
  if (e.eventType === "outOfOffice") return true;
  return !e.transparent;
}

export class CalendarService {
  private readonly db: DB;
  private readonly bus: Bus;
  private readonly provider: (accountId: string) => CalendarProvider;
  private readonly mail: (accountId: string) => MailProvider;
  private readonly acct: (accountId?: string) => string;
  private readonly accounts: () => string[];
  private readonly settings: () => IrisSettings;
  private running = new Map<string, Promise<boolean>>();
  /** per-calendar serialisation of syncs (sync tokens) */
  private locks = new Map<string, Promise<unknown>>();
  /** last sync failure per account (cleared on success) */
  private errors = new Map<string, { error: Error; at: number }>();
  /** message last reported on the bus per account: report once, not every tick */
  private reported = new Map<string, string>();
  private lastSyncAt = new Map<string, number>();
  /** on-demand ranges outside the cache (no token), kept for a minute */
  private ranges = new Map<string, { at: number; events: CalendarEvent[] }>();
  /** meeting notifications already shown: key → instance start */
  private notified = new Map<string, number>();

  constructor(deps: CalendarDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.provider = deps.provider;
    this.mail = deps.mail;
    this.acct = deps.acct;
    this.accounts = deps.accounts ?? (() => [deps.acct()]);
    this.settings = deps.settings;
  }

  // ------------------------------------------------------------ calendars

  private rows(accountId: string): CalendarRow[] {
    return this.db.all<CalendarRow>("SELECT * FROM calendars WHERE account_id = ? AND disabled = 0 ORDER BY is_primary DESC, position", accountId);
  }

  private toCalendar(r: CalendarRow): Calendar {
    return {
      id: r.id,
      accountId: r.account_id,
      summary: r.summary,
      color: r.color_local ?? r.color,
      primary: !!r.is_primary,
      selected: r.selected_local === null ? !!r.selected_remote : !!r.selected_local,
      notify: r.notify_local === null ? !!r.is_primary : !!r.notify_local,
      accessRole: r.access_role as Calendar["accessRole"],
      timeZone: r.time_zone,
    };
  }

  /** First use (or after a failed first sync): sync now so callers get data or the real error. */
  private async ensureSynced(accountId: string): Promise<void> {
    if (this.db.get("SELECT 1 FROM calendars WHERE account_id = ? LIMIT 1", accountId)) return;
    const err = this.errors.get(accountId);
    if (err && Date.now() - err.at < 60_000) throw err.error;
    await this.sync(accountId);
  }

  /**
   * `account=all` reads: every account in parallel; an account that fails (no calendar scope yet, API off) is left
   * out (its sync error is reported on the bus once). Throws only when every account failed.
   */
  private async eachAccount<T>(fn: (accountId: string) => Promise<T[]>): Promise<T[]> {
    const rs = await Promise.allSettled(this.accounts().map(fn));
    const ok = rs.filter((r) => r.status === "fulfilled");
    if (!ok.length && rs.length) throw (rs[0] as PromiseRejectedResult).reason;
    return ok.flatMap((r) => (r as PromiseFulfilledResult<T[]>).value);
  }

  async calendars(accountIdIn?: string): Promise<Calendar[]> {
    if (isAllAccounts(accountIdIn)) return this.eachAccount((a) => this.calendars(a));
    const accountId = this.acct(accountIdIn);
    await this.ensureSynced(accountId);
    return this.rows(accountId).map((r) => this.toCalendar(r));
  }

  private calendarRow(accountId: string, calendarId: string): CalendarRow {
    const rows = this.rows(accountId);
    const r = calendarId === "primary" ? rows.find((x) => x.is_primary) : rows.find((x) => x.id === calendarId);
    if (!r) throw new Error(`Unknown calendar: ${calendarId}`);
    return r;
  }

  /** Local preferences: shown in the view, color override (null = Google's color), meeting notifications. */
  async updateCalendar(accountIdIn: string | undefined, calendarId: string, patch: { selected?: boolean; color?: string | null; notify?: boolean }): Promise<Calendar> {
    const accountId = this.acct(accountIdIn);
    await this.ensureSynced(accountId);
    const r = this.calendarRow(accountId, calendarId);
    if (patch.color !== undefined && patch.color !== null && !/^#[0-9a-f]{6}$/i.test(patch.color)) throw new Error("color must be #rrggbb or null");
    this.db.run(
      "UPDATE calendars SET selected_local = ?, color_local = ?, notify_local = ? WHERE account_id = ? AND id = ?",
      patch.selected === undefined ? r.selected_local : +patch.selected,
      patch.color === undefined ? r.color_local : patch.color,
      patch.notify === undefined ? r.notify_local : +patch.notify,
      accountId,
      r.id,
    );
    this.changed(accountId);
    return this.toCalendar(this.calendarRow(accountId, r.id));
  }

  private async primaryId(accountId: string): Promise<string> {
    await this.ensureSynced(accountId);
    return this.rows(accountId).find((r) => r.is_primary)?.id ?? "primary";
  }

  private changed(accountId: string): void {
    this.bus.emitEvent({ type: "calendar-changed", accountId });
  }

  // ------------------------------------------------------------ sync

  status(accountId: string): { calendars: number; events: number; lastSyncAt: number | null; error: string | null } {
    return {
      calendars: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calendars WHERE account_id = ?", accountId)?.n ?? 0,
      events: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE account_id = ?", accountId)?.n ?? 0,
      lastSyncAt: this.lastSyncAt.get(accountId) ?? this.db.get<{ t: number | null }>("SELECT MAX(synced_at) AS t FROM calendars WHERE account_id = ?", accountId)?.t ?? null,
      error: this.errors.get(accountId)?.error.message ?? null,
    };
  }

  /** Background loop entry: like sync(), but while the grant lacks the calendar scope only retry every 10 min. */
  backgroundSync(accountId: string): Promise<boolean> {
    const err = this.errors.get(accountId);
    if (err && /^Calendar access not granted/.test(err.error.message) && Date.now() - err.at < 10 * 60_000) return Promise.resolve(false);
    return this.sync(accountId);
  }

  /** Calendar list + incremental sync of every calendar (full when `full`, on 410, or once a day to slide the window). */
  sync(accountIdIn?: string, opts: { full?: boolean } = {}): Promise<boolean> {
    const accountId = this.acct(accountIdIn);
    const cur = this.running.get(accountId);
    if (cur) return cur;
    const p = inBackground(() => this.doSync(accountId, !!opts.full))
      .then((changed) => {
        this.errors.delete(accountId);
        this.reported.delete(accountId);
        this.lastSyncAt.set(accountId, Date.now());
        return changed;
      })
      .catch((e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e));
        this.errors.set(accountId, { error, at: Date.now() });
        if (this.reported.get(accountId) !== error.message) {
          this.reported.set(accountId, error.message);
          this.bus.emitEvent({ type: "error", accountId, data: { where: "calendar", message: error.message } });
        }
        throw error;
      })
      .finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return p;
  }

  private async doSync(accountId: string, full: boolean): Promise<boolean> {
    const p = this.provider(accountId);
    let changed = this.saveCalendars(accountId, await p.listCalendars());
    if (full) this.db.run("UPDATE calendars SET disabled = 0 WHERE account_id = ?", accountId);
    const cals = this.rows(accountId).filter((r) => r.access_role !== "freeBusyReader");
    let firstError: unknown = null;
    await pmap(cals, 3, async (r) => {
      try {
        if (await this.syncCalendar(accountId, p, r.id, full)) changed = true;
      } catch (e) {
        firstError ??= e;
      }
    });
    if (changed) {
      this.ranges.clear();
      this.changed(accountId);
    }
    if (firstError) throw firstError;
    return changed;
  }

  private saveCalendars(accountId: string, list: Calendar[]): boolean {
    return this.db.tx(() => {
      const before = JSON.stringify(this.rows(accountId).map((r) => this.toCalendar(r)));
      const keep = new Set(list.map((c) => c.id));
      for (const r of this.db.all<{ id: string }>("SELECT id FROM calendars WHERE account_id = ?", accountId)) if (!keep.has(r.id)) this.dropCalendar(accountId, r.id);
      list.forEach((c, i) => {
        this.db.run(
          `INSERT INTO calendars (account_id, id, summary, color, is_primary, selected_remote, access_role, time_zone, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, id) DO UPDATE SET summary = excluded.summary, color = excluded.color, is_primary = excluded.is_primary,
             selected_remote = excluded.selected_remote, access_role = excluded.access_role, time_zone = excluded.time_zone, position = excluded.position`,
          accountId,
          c.id,
          c.summary,
          c.color,
          +c.primary,
          +c.selected,
          c.accessRole,
          c.timeZone,
          i,
        );
      });
      return JSON.stringify(this.rows(accountId).map((r) => this.toCalendar(r))) !== before;
    });
  }

  private dropCalendar(accountId: string, calendarId: string): void {
    this.db.run("DELETE FROM calendars WHERE account_id = ? AND id = ?", accountId, calendarId);
    this.db.run("DELETE FROM events WHERE account_id = ? AND calendar_id = ?", accountId, calendarId);
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    void next
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  private syncCalendar(accountId: string, p: CalendarProvider, calendarId: string, full: boolean): Promise<boolean> {
    return this.withLock(`${accountId}\n${calendarId}`, async () => {
      const r = this.rows(accountId).find((x) => x.id === calendarId);
      if (!r) return false;
      try {
        return await this.syncCalendarLocked(accountId, p, r, full);
      } catch (e) {
        if (e instanceof ProviderError && e.status === 404) {
          // calendar gone (unsubscribed / deleted elsewhere): clear and disable it, so it does not flap with the calendar list
          this.db.tx(() => {
            this.db.run("DELETE FROM events WHERE account_id = ? AND calendar_id = ?", accountId, calendarId);
            this.db.run("UPDATE calendars SET disabled = 1, sync_token = NULL WHERE account_id = ? AND id = ?", accountId, calendarId);
          });
          return true;
        }
        throw e;
      }
    });
  }

  private async syncCalendarLocked(accountId: string, p: CalendarProvider, r: CalendarRow, full: boolean): Promise<boolean> {
    const now = Date.now();
    const slide = r.window_end === null || now + CALENDAR_WINDOW.futureDays * DAY - r.window_end >= DAY;
    if (!full && !slide && r.sync_token && r.window_start !== null && r.window_end !== null) {
      const inc = await p.listEvents(r.id, { syncToken: r.sync_token });
      if (inc !== "expired") {
        return this.db.tx(() => {
          let n = 0;
          for (const e of inc.events) {
            if (e.end > r.window_start! && e.start < r.window_end!) n += this.upsert(e);
            else n += this.remove(accountId, r.id, e.id);
          }
          for (const id of inc.deletedIds) n += this.remove(accountId, r.id, id);
          this.db.run("UPDATE calendars SET sync_token = ?, synced_at = ? WHERE account_id = ? AND id = ?", inc.nextSyncToken ?? r.sync_token, now, accountId, r.id);
          return n > 0;
        });
      }
      // 410 Gone: clear the token, resync once
      this.db.run("UPDATE calendars SET sync_token = NULL WHERE account_id = ? AND id = ?", accountId, r.id);
    }
    const wStart = now - CALENDAR_WINDOW.pastDays * DAY;
    const wEnd = now + CALENDAR_WINDOW.futureDays * DAY;
    const res = await p.listEvents(r.id, { timeMin: wStart }); // no timeMax: Google refuses syncToken + timeMax later
    if (res === "expired") throw new Error(`Calendar ${r.summary}: full sync was rejected (410)`);
    return this.db.tx(() => {
      const before = new Map(
        this.db.all<{ id: string; json: string }>("SELECT id, json FROM events WHERE account_id = ? AND calendar_id = ?", accountId, r.id).map((x) => [x.id, x.json]),
      );
      this.db.run("DELETE FROM events WHERE account_id = ? AND calendar_id = ?", accountId, r.id);
      let changed = false;
      for (const e of res.events) {
        if (e.start >= wEnd || e.end <= wStart) continue; // never-ending series: cache instances up to +120 d only
        this.upsert(e);
        if (before.get(e.id) !== JSON.stringify(e)) changed = true;
        before.delete(e.id);
      }
      if (before.size) changed = true;
      this.db.run(
        "UPDATE calendars SET sync_token = ?, window_start = ?, window_end = ?, synced_at = ? WHERE account_id = ? AND id = ?",
        res.nextSyncToken,
        wStart,
        wEnd,
        now,
        accountId,
        r.id,
      );
      return changed;
    });
  }

  /** After a write: incremental sync of that calendar right away, then tell the UI. Never fails the write. */
  private async resync(accountId: string, calendarId: string): Promise<void> {
    await inBackground(() => this.syncCalendar(accountId, this.provider(accountId), calendarId, false)).catch(() => undefined);
    this.ranges.clear();
    this.changed(accountId);
  }

  /** returns 1 when the row changed */
  private upsert(e: CalendarEvent): number {
    const json = JSON.stringify(e);
    return Number(
      this.db.raw
        .prepare(
          `INSERT INTO events (account_id, calendar_id, id, ical_uid, start_ms, end_ms, status, updated, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, calendar_id, id) DO UPDATE SET ical_uid = excluded.ical_uid, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
             status = excluded.status, updated = excluded.updated, json = excluded.json
           WHERE events.json != excluded.json`,
        )
        .run(e.accountId, e.calendarId, e.id, e.iCalUID, e.start, e.end, e.status, e.updated, json).changes,
    );
  }

  private remove(accountId: string, calendarId: string, eventId: string): number {
    return Number(this.db.raw.prepare("DELETE FROM events WHERE account_id = ? AND calendar_id = ? AND id = ?").run(accountId, calendarId, eventId).changes);
  }

  // ------------------------------------------------------------ reads

  private colors(accountId: string): Map<string, string> {
    return new Map(this.rows(accountId).map((r) => [r.id, r.color_local ?? r.color]));
  }

  private withColor(e: CalendarEvent, colors?: Map<string, string>): CalendarEvent {
    if (e.color) return e;
    const c = (colors ?? this.colors(e.accountId)).get(e.calendarId);
    return c ? { ...e, color: c } : e;
  }

  private cachedRange(accountId: string, calendarIds: string[], from: number, to: number): CalendarEvent[] {
    if (!calendarIds.length) return [];
    return this.db
      .all<{ json: string }>(
        `SELECT json FROM events WHERE account_id = ? AND start_ms < ? AND end_ms > ? AND status != 'cancelled'
           AND calendar_id IN (${calendarIds.map(() => "?").join(",")}) ORDER BY start_ms, end_ms`,
        accountId,
        to,
        from,
        ...calendarIds,
      )
      .map((r) => JSON.parse(r.json) as CalendarEvent);
  }

  /** Events overlapping [from, to), sorted by start. Default: selected calendars. Outside the cache: fetched on demand. */
  async events(accountIdIn: string | undefined, from: number, to: number, calendarIds?: string[]): Promise<CalendarEvent[]> {
    if (isAllAccounts(accountIdIn)) {
      // calendar ids are per account ("primary" = each account's primary); ids an account does not have match nothing
      const list = await this.eachAccount((a) => this.events(a, from, to, calendarIds));
      return list.sort((a, b) => a.start - b.start || a.end - b.end);
    }
    const accountId = this.acct(accountIdIn);
    await this.ensureSynced(accountId);
    const rows = this.rows(accountId);
    const ids = calendarIds?.length
      ? calendarIds.map((id) => (id === "primary" ? (rows.find((r) => r.is_primary)?.id ?? id) : id))
      : rows.filter((r) => this.toCalendar(r).selected).map((r) => r.id);
    const colors = this.colors(accountId);
    const out: CalendarEvent[] = [];
    const inCache: string[] = [];
    for (const id of ids) {
      const r = rows.find((x) => x.id === id);
      if (r && r.window_start !== null && r.window_end !== null && (from < r.window_start || to > r.window_end)) {
        out.push(...(await this.fetchRange(accountId, id, from, to).catch(() => this.cachedRange(accountId, [id], from, to))));
      } else inCache.push(id);
    }
    out.push(...this.cachedRange(accountId, inCache, from, to));
    return out.map((e) => this.withColor(e, colors)).sort((a, b) => a.start - b.start || a.end - b.end);
  }

  private async fetchRange(accountId: string, calendarId: string, from: number, to: number): Promise<CalendarEvent[]> {
    const key = `${accountId}\n${calendarId}\n${from}\n${to}`;
    const hit = this.ranges.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.events;
    const r = await this.provider(accountId).listEvents(calendarId, { timeMin: from, timeMax: to });
    const events = r === "expired" ? [] : r.events;
    if (this.ranges.size > 50) this.ranges.clear();
    this.ranges.set(key, { at: Date.now(), events });
    return events;
  }

  private cached(accountId: string, calendarId: string, eventId: string): CalendarEvent | null {
    const r = this.db.get<{ json: string }>("SELECT json FROM events WHERE account_id = ? AND calendar_id = ? AND id = ?", accountId, calendarId, eventId);
    return r ? (JSON.parse(r.json) as CalendarEvent) : null;
  }

  async event(accountIdIn: string | undefined, calendarIdIn: string, eventId: string): Promise<CalendarEvent> {
    const accountId = this.acct(accountIdIn);
    const calendarId = calendarIdIn === "primary" ? await this.primaryId(accountId) : calendarIdIn;
    const hit = this.cached(accountId, calendarId, eventId);
    if (hit) return this.withColor(hit);
    const e = await this.provider(accountId).getEvent(calendarId, eventId);
    if (!e) throw new Error(`Unknown event: ${eventId}`);
    return this.withColor(e);
  }

  // ------------------------------------------------------------ writes

  /** EventInput (natural language + explicit fields) → provider write. `existing` = PATCH semantics. */
  resolveWrite(input: EventInput, existing: CalendarEvent | null, now = new Date()): CalendarEventWrite {
    const w: CalendarEventWrite = {};
    const parsed = input.text?.trim() ? parseEventText(input.text, now, DEFAULT_MINUTES) : null;
    if (input.text?.trim() && !parsed?.start && input.start === undefined && !existing && input.summary === undefined) {
      throw new Error(`Could not find a date or time in: "${input.text.trim()}" (try e.g. "Lunch with Anna tomorrow 1pm for 1h")`);
    }
    if (input.summary !== undefined) w.summary = input.summary.trim();
    else if (parsed?.summary) w.summary = parsed.summary;
    else if (!existing) w.summary = "";
    if (input.description !== undefined) w.description = input.description;
    if (input.location !== undefined) w.location = input.location;

    const explicitStart = toMs(input.start);
    const explicitEnd = toMs(input.end);
    let start: number | null = explicitStart ?? parsed?.start ?? null;
    let end: number | null = explicitEnd ?? (explicitStart === null ? (parsed?.end ?? null) : null);
    const dateOnly = typeof input.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.start.trim());
    const allDay = input.allDay ?? (dateOnly ? true : explicitStart === null && parsed?.start != null ? parsed.allDay : (existing?.allDay ?? false));
    const timeTouched = start !== null || end !== null || (input.allDay !== undefined && input.allDay !== existing?.allDay);
    if (!existing && start === null) throw new Error("start required (epoch ms, ISO time or natural language), or text with a date/time");
    if (timeTouched) {
      if (start === null) start = existing!.allDay && !allDay ? existing!.start + WORKING_HOURS.start * 3600_000 : existing!.start;
      if (allDay) {
        start = startOfDay(start);
        if (end !== null) end = end === startOfDay(end) ? end : addDays(startOfDay(end), 1);
        else end = existing?.allDay && explicitStart === null ? existing.end : addDays(start, 1);
        if (end <= start) end = addDays(start, 1);
      } else {
        if (end === null) {
          const keep = existing && !existing.allDay ? existing.end - existing.start : null;
          end = start + (keep ?? (parsed?.durationMinutes ?? DEFAULT_MINUTES) * MIN);
        }
        if (end <= start) throw new Error("The event must end after it starts");
      }
      w.start = start;
      w.end = end;
      w.allDay = allDay;
    }
    const attendees = attendeeEmails(input.attendees);
    if (attendees && (existing || attendees.length)) w.attendees = attendees;
    if (input.conference ?? (!existing && this.settings().calendar?.defaultMeetingLink === "meet")) w.conference = true;
    return w;
  }

  /** The event a recurring scope applies to: the instance ("this") or its series ("all"). */
  private async scoped(accountId: string, e: CalendarEvent, scope: RecurrenceScope | undefined): Promise<CalendarEvent> {
    if (scope === "following") {
      throw new NotImplementedError('Changing "this and following events" is not supported yet. Use scope "this" or "all", or open the event in Google Calendar.');
    }
    if (scope !== "all" || !e.recurringEventId) return e;
    const master = await this.provider(accountId).getEvent(e.calendarId, e.recurringEventId);
    if (!master) throw new Error(`Unknown event: ${e.recurringEventId}`);
    return master;
  }

  private sendUpdates(notify: boolean | undefined, target: CalendarEvent, w?: CalendarEventWrite): SendUpdates {
    if (notify !== undefined) return notify ? "all" : "none";
    return guests(target).length || (w?.attendees?.length ?? 0) > 0 ? "all" : "none";
  }

  private fresh(e: CalendarEvent): CalendarEvent {
    return this.withColor(this.cached(e.accountId, e.calendarId, e.id) ?? e);
  }

  async createEvent(input: EventInput): Promise<CalendarEvent> {
    const accountId = this.acct(input.account);
    const w = this.resolveWrite(input, null);
    const calendarId = !input.calendarId || input.calendarId === "primary" ? await this.primaryId(accountId) : input.calendarId;
    const row = this.rows(accountId).find((r) => r.id === calendarId);
    if (row && !["owner", "writer"].includes(row.access_role)) throw new Error(`Calendar "${row.summary}" is read-only`);
    const e = await this.provider(accountId).insertEvent(calendarId, w, { sendUpdates: w.attendees?.length ? "all" : "none" });
    this.upsert(e);
    await this.resync(accountId, calendarId);
    return this.fresh(e);
  }

  async updateEvent(accountIdIn: string | undefined, calendarIdIn: string, eventId: string, input: EventInput): Promise<CalendarEvent> {
    const accountId = this.acct(accountIdIn ?? input.account);
    const existing = await this.event(accountId, calendarIdIn, eventId);
    const target = await this.scoped(accountId, existing, input.scope);
    const w = this.resolveWrite(input, existing);
    if (!Object.keys(w).length) return existing;
    if (target !== existing && w.start !== undefined && w.end !== undefined) {
      // "all events" from an instance: move the series by the same offsets
      w.start = target.start + (w.start - existing.start);
      w.end = target.end + (w.end - existing.end);
    }
    const e = await this.provider(accountId).patchEvent(target.calendarId, target.id, w, { sendUpdates: this.sendUpdates(input.notify, target, w) });
    this.upsert(e);
    await this.resync(accountId, target.calendarId);
    return target === existing ? this.fresh(e) : this.withColor(e);
  }

  async deleteEvent(accountIdIn: string | undefined, calendarIdIn: string, eventId: string, opts: { notify?: boolean; scope?: RecurrenceScope } = {}): Promise<{ ok: true }> {
    const accountId = this.acct(accountIdIn);
    const existing = await this.event(accountId, calendarIdIn, eventId);
    const target = await this.scoped(accountId, existing, opts.scope);
    await this.provider(accountId).deleteEvent(target.calendarId, target.id, { sendUpdates: this.sendUpdates(opts.notify, target) });
    this.db.tx(() => {
      this.remove(accountId, target.calendarId, target.id);
      if (target !== existing || !existing.recurringEventId) {
        this.db.run("DELETE FROM events WHERE account_id = ? AND calendar_id = ? AND json_extract(json, '$.recurringEventId') = ?", accountId, target.calendarId, target.id);
      }
    });
    await this.resync(accountId, target.calendarId);
    return { ok: true };
  }

  private selfEmail(accountId: string, e: CalendarEvent | null): string {
    return e?.attendees.find((a) => a.self)?.email ?? accountId.toLowerCase();
  }

  /** PATCH {attendeesOmitted, attendees:[self]} with sendUpdates=all. scope "all" on an instance answers the series. */
  async rsvp(accountIdIn: string | undefined, calendarIdIn: string, eventId: string, response: string, opts: { scope?: "this" | "all" } = {}): Promise<CalendarEvent> {
    const accountId = this.acct(accountIdIn);
    const r = normalizeResponse(response);
    const calendarId = calendarIdIn === "primary" ? await this.primaryId(accountId) : calendarIdIn;
    const known = this.cached(accountId, calendarId, eventId);
    const targetId = opts.scope === "all" && known?.recurringEventId ? known.recurringEventId : eventId;
    const e = await this.provider(accountId).respond(calendarId, targetId, this.selfEmail(accountId, known), r);
    this.upsert(e);
    await this.resync(accountId, calendarId);
    return targetId === eventId ? this.fresh(e) : this.withColor(e);
  }

  /**
   * RSVP from an invite mail: find the event by iCalUID (showHiddenInvitations, showDeleted), import it from the ICS when it is
   * not on the calendar yet, then send the RSVP. Remembers the answer per message for the invite card.
   */
  async rsvpInvite(accountId: string, messages: Message[], response: string, opts: { messageId?: string; scope?: "this" | "all" } = {}): Promise<{ event: CalendarEvent; invite: CalendarInvite }> {
    const r = normalizeResponse(response);
    const found = await this.findInvite(accountId, opts.messageId ? messages.filter((m) => m.id === opts.messageId) : messages);
    if (!found) throw new Error("This conversation has no calendar invite");
    const { ve, message, invite } = found;
    if (!invite.canRsvp) throw new Error(invite.kind === "cancel" ? "Event has been canceled" : "You are not a guest of this invite, so there is nothing to RSVP.");
    const p = this.provider(accountId);
    const primary = await this.primaryId(accountId);
    let matches = await p.findByICalUID(primary, ve.uid);
    if (matches.length && matches.every((e) => e.status === "cancelled")) throw new Error("Event has been deleted");
    if (!matches.length) {
      await p.importEvent(primary, ve);
      matches = await p.findByICalUID(primary, ve.uid);
    }
    const live = matches.filter((e) => e.status !== "cancelled");
    let target = live.find((e) => !e.recurringEventId) ?? live[0];
    if (!target) throw new Error("Could not add the invite to your calendar");
    // default for a series invite: answer the whole series (Gmail's buttons); "this" or a single-occurrence invite: the instance
    if ((ve.recurrenceId !== undefined || (opts.scope === "this" && ve.rrule)) && !target.recurringEventId) {
      const at = ve.recurrenceId ?? ve.start;
      const inst = this.db
        .all<{ json: string }>("SELECT json FROM events WHERE account_id = ? AND ical_uid = ?", accountId, ve.uid)
        .map((x) => JSON.parse(x.json) as CalendarEvent)
        .find((x) => x.recurringEventId === target!.id && Math.abs(x.start - at) < MIN);
      if (inst) target = inst;
    }
    const e = await p.respond(target.calendarId, target.id, this.selfEmail(accountId, target), r);
    this.db.kvSet(`invite-rsvp:${accountId}:${message.id}`, JSON.stringify({ uid: ve.uid, response: r, at: Date.now() }));
    this.upsert(e);
    await this.resync(accountId, target.calendarId);
    const event = this.fresh(e);
    return { event, invite: { ...invite, selfResponse: r, event } };
  }

  // ------------------------------------------------------------ busy time + availability

  /** Calendars that count as "my time": selected ones the user owns or writes to (not subscribed/holiday calendars). */
  private async ownCalendarIds(accountId: string): Promise<string[]> {
    await this.ensureSynced(accountId);
    const rows = this.rows(accountId);
    const ids = rows.filter((r) => this.toCalendar(r).selected && (r.access_role === "owner" || r.access_role === "writer")).map((r) => r.id);
    return ids.length ? ids : rows.filter((r) => r.is_primary).map((r) => r.id);
  }

  /** Own busy time from cached events (rounded to 15 min, merged). */
  async busy(accountIdIn: string | undefined, from: number, to: number): Promise<TimeRange[]> {
    const accountId = this.acct(accountIdIn);
    const events = await this.events(accountId, from, to, await this.ownCalendarIds(accountId));
    return mergeRanges(events.filter(isBusy).map((e) => ({ start: Math.max(from, floor15(e.start)), end: Math.min(to, ceil15(e.end)) })));
  }

  /** `calendars` = other people's calendars/emails (Google freeBusy); without them: own busy time from the cache. */
  async freeBusy(accountIdIn: string | undefined, from: number, to: number, calendars?: string[]): Promise<{ busy: TimeRange[] }> {
    const accountId = this.acct(accountIdIn);
    if (!(to > from)) throw new Error("to must be after from");
    if (calendars?.length) return { busy: mergeRanges(await this.provider(accountId).freeBusy(calendars, from, to)) };
    return { busy: await this.busy(accountId, from, to) };
  }

  /** Computed free time (Find Time rules): working hours Mon–Fri, 15-min rounding, at most `maxRangesPerDay` ranges a day. */
  async availability(
    accountIdIn: string | undefined,
    opts: { days?: number; duration?: number; from?: number; workStart?: number; workEnd?: number; maxRangesPerDay?: number } = {},
  ): Promise<{ slots: TimeRange[]; text: string }> {
    const accountId = this.acct(accountIdIn);
    const days = Math.min(30, Math.max(1, Math.round(opts.days ?? 5)));
    const duration = Math.min(600, Math.max(5, Math.round(opts.duration ?? DEFAULT_MINUTES)));
    const workStart = Math.min(23, Math.max(0, opts.workStart ?? WORKING_HOURS.start));
    const workEnd = Math.min(24, Math.max(workStart + 1, opts.workEnd ?? WORKING_HOURS.end));
    const maxRanges = Math.max(1, Math.round(opts.maxRangesPerDay ?? 3));
    const lower = Math.max(opts.from ?? Date.now(), Date.now());
    const windows: TimeRange[] = [];
    const day0 = startOfDay(lower);
    for (let i = 0; windows.length < days && i < days * 2 + 7; i++) {
      const d = new Date(addDays(day0, i));
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const ws = new Date(d).setHours(Math.floor(workStart), Math.round((workStart % 1) * 60), 0, 0);
      const we = new Date(d).setHours(Math.floor(workEnd), Math.round((workEnd % 1) * 60), 0, 0);
      const s = Math.max(ws, ceil15(lower));
      if (s + duration * MIN > we) continue; // this day is already over
      windows.push({ start: s, end: we });
    }
    if (!windows.length) return { slots: [], text: "" };
    const busy = await this.busy(accountId, windows[0].start, windows[windows.length - 1].end);
    const slots: TimeRange[] = [];
    for (const w of windows) {
      const day: TimeRange[] = [];
      const push = (s: number, e: number) => {
        const a = ceil15(s);
        const b = floor15(e);
        if (b - a >= duration * MIN && day.length < maxRanges) day.push({ start: a, end: b });
      };
      let cur = w.start;
      for (const b of busy) {
        if (b.end <= cur) continue;
        if (b.start >= w.end) break;
        if (b.start > cur) push(cur, b.start);
        cur = Math.max(cur, b.end);
      }
      if (cur < w.end) push(cur, w.end);
      slots.push(...day);
    }
    const text = slots.length ? renderAvailabilityText({ slots, duration }) : `No free ${durationText(duration)} slots in the next ${days} working day${days === 1 ? "" : "s"}.`;
    return { slots, text };
  }

  // ------------------------------------------------------------ meeting notifications

  /** Emit `notification` (kind "meeting") `leadSeconds` before start; once per instance. Returns how many fired. */
  notifyDue(leadSeconds = this.settings().calendar?.notifyLeadSeconds ?? 120, now = Date.now()): number {
    const rows = this.db.all<{ json: string; is_primary: number; notify_local: number | null }>(
      `SELECT e.json, c.is_primary, c.notify_local FROM events e JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
       WHERE e.start_ms <= ? AND e.start_ms > ? AND e.status != 'cancelled'`,
      now + leadSeconds * 1000,
      now - 5 * MIN, // never more than 5 min after the start
    );
    let n = 0;
    for (const r of rows) {
      if (!(r.notify_local === null ? r.is_primary : r.notify_local)) continue;
      const e = JSON.parse(r.json) as CalendarEvent;
      if (e.allDay || !e.summary.trim() || e.selfResponse === "declined") continue;
      const key = `${e.accountId}\n${e.calendarId}\n${e.id}\n${e.start}`;
      if (this.notified.has(key)) continue;
      this.notified.set(key, e.start);
      const mins = Math.round((e.start - now) / MIN);
      this.bus.emitEvent({
        type: "notification",
        accountId: e.accountId,
        data: {
          kind: "meeting",
          title: e.summary,
          body: `${mins > 0 ? `in ${mins}m` : "now"} · ${timeRangeText(e.start, e.end, localZone())}`,
          start: e.start,
          end: e.end,
          calendarId: e.calendarId,
          eventId: e.id,
          ...(e.conferenceUrl ? { conferenceUrl: e.conferenceUrl } : {}),
          ...(e.location ? { location: e.location } : {}),
        },
      });
      n++;
    }
    for (const [k, start] of this.notified) if (start < now - DAY) this.notified.delete(k);
    return n;
  }

  // ------------------------------------------------------------ invites in mail

  private async findInvite(accountId: string, messages: Message[]): Promise<{ ve: IcsEvent; message: Message; invite: CalendarInvite } | undefined> {
    for (const m of [...messages].reverse()) {
      if (m.isDraft) continue;
      let ics = m.ics;
      if (!ics) {
        const att = m.attachments.find((a) => /^(text\/calendar|application\/ics)$/i.test(a.mimeType) || /\.ics$/i.test(a.filename));
        if (!att || att.id.startsWith("inline-data:")) continue;
        try {
          ics = (await this.mail(accountId).getAttachment(m.id, att.id)).toString("utf8");
        } catch {
          continue;
        }
        if (!/BEGIN:VCALENDAR/i.test(ics)) continue;
        this.db.run("UPDATE messages SET ics = ? WHERE account_id = ? AND id = ?", ics, accountId, m.id);
      }
      const cal = parseIcs(ics);
      const ve = cal.events[0];
      if (!ve) continue;
      return { ve, message: m, invite: this.buildInvite(accountId, m, cal.method, ve) };
    }
    return undefined;
  }

  private buildInvite(accountId: string, m: Message, rawMethod: string, ve: IcsEvent): CalendarInvite {
    const me = accountId.toLowerCase();
    const known = ["REQUEST", "CANCEL", "REPLY", "COUNTER", "REFRESH", "ADD", "DECLINECOUNTER", "PUBLISH"];
    const method = (known.includes(rawMethod) ? rawMethod : "NONE") as InviteMethod;
    const attendees: EventAttendee[] = ve.attendees.map((a) => ({
      email: a.email,
      name: a.name,
      responseStatus: partstatToResponse(a.partstat),
      ...(a.email === me ? { self: true } : {}),
      ...(a.email && a.email === ve.organizer.email ? { organizer: true } : {}),
      ...(a.optional ? { optional: true } : {}),
    }));
    const self = attendees.find((a) => a.self);
    const kind: CalendarInvite["kind"] =
      method === "CANCEL" || ve.status === "CANCELLED"
        ? "cancel"
        : method === "REPLY" || method === "COUNTER"
          ? "reply"
          : /updated invitation/i.test(m.subject) || ve.sequence > 0
            ? "update"
            : "request";
    const answered =
      attendees.find((a) => !a.self && !a.organizer && a.responseStatus !== "needsAction") ?? attendees.find((a) => !a.self && a.responseStatus !== "needsAction");
    const stored = this.db.kvGet(`invite-rsvp:${accountId}:${m.id}`);
    const rsvp = stored ? (JSON.parse(stored) as { uid: string; response: ResponseStatus }) : null;
    const conferenceUrl = ve.conferenceUrl ?? conferenceUrlOf({ id: "", location: ve.location, description: ve.description });
    return {
      iCalUID: ve.uid,
      method,
      kind,
      summary: ve.summary,
      description: ve.description,
      start: ve.start,
      end: ve.end,
      allDay: ve.allDay,
      location: ve.location,
      ...(conferenceUrl ? { conferenceUrl } : {}),
      organizer: ve.organizer,
      attendees,
      ...(rsvp?.uid === ve.uid ? { selfResponse: rsvp.response } : self ? { selfResponse: self.responseStatus } : {}),
      recurring: !!ve.rrule || ve.recurrenceId !== undefined,
      canRsvp: !!self && (kind === "request" || kind === "update") && ve.organizer.email !== me && !/^calendly-/i.test(ve.uid),
      ...(kind === "reply" && answered ? { replyFrom: { email: answered.email, name: answered.name, responseStatus: answered.responseStatus } } : {}),
      messageId: m.id,
    };
  }

  /** Invite carried by the newest message with a text/calendar part, matched to the user's calendar event. */
  async inviteFor(accountId: string, messages: Message[]): Promise<CalendarInvite | undefined> {
    const found = await this.findInvite(accountId, messages);
    if (!found) return undefined;
    const { ve, invite } = found;
    const event = await this.inviteEvent(accountId, ve, invite.kind).catch(() => undefined);
    if (!event) return invite;
    const stored = this.db.kvGet(`invite-rsvp:${accountId}:${invite.messageId}`);
    // the calendar is the source of truth once it caught up; the per-message answer covers the gap before sync
    const selfResponse = stored && event.selfResponse === "needsAction" ? invite.selfResponse : (event.selfResponse ?? invite.selfResponse);
    return { ...invite, ...(selfResponse ? { selfResponse } : {}), event };
  }

  private async inviteEvent(accountId: string, ve: IcsEvent, kind: CalendarInvite["kind"]): Promise<CalendarEvent | undefined> {
    if (!ve.uid) return undefined;
    const rows = this.db
      .all<{ json: string }>("SELECT json FROM events WHERE account_id = ? AND ical_uid = ? AND status != 'cancelled'", accountId, ve.uid)
      .map((r) => JSON.parse(r.json) as CalendarEvent);
    const p = this.provider(accountId);
    const healthy = !this.errors.has(accountId);
    if (rows.length) {
      // a series invite is answered on the series (like Gmail's invite buttons), not on one instance
      const inst = rows.find((r) => r.recurringEventId);
      if (ve.rrule && inst && healthy) {
        const master = await p.getEvent(inst.calendarId, inst.recurringEventId!).catch(() => null);
        if (master) return this.withColor(master);
      }
      return this.withColor(rows.sort((a, b) => Math.abs(a.start - ve.start) - Math.abs(b.start - ve.start))[0]);
    }
    if (kind === "cancel" || !healthy) return undefined;
    const primary = this.rows(accountId).find((r) => r.is_primary)?.id;
    if (!primary) return undefined; // calendar not synced yet: do not trigger a sync from opening a thread
    const found = (await p.findByICalUID(primary, ve.uid)).filter((e) => e.status !== "cancelled");
    return found[0] ? this.withColor(found[0]) : undefined;
  }
}

// ---------------------------------------------------------------- "Share availability" text

const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "proton.me",
  "protonmail.com",
]);

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  weekday: string;
  month: string;
}

function zoned(ms: number, tz: string): ZonedParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const month = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short" }).format(new Date(ms));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), weekday: p.weekday, month };
}

/** Abbreviation of `tz` at `ms`: "CEST", "PDT", else "GMT+8". */
export function tzAbbrev(ms: number, tz: string): string {
  const name = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
  const us = name("en-US");
  if (!/^(GMT|UTC)[+-]/.test(us)) return us;
  const gb = name("en-GB");
  return /^(GMT|UTC)[+-]/.test(gb) ? us : gb;
}

function clock(h: number, mi: number): { t: string; ampm: "am" | "pm" } {
  return { t: `${h % 12 || 12}:${String(mi).padStart(2, "0")}`, ampm: h < 12 ? "am" : "pm" };
}

/** "10:00–11:30 am", "11:30 am–1:00 pm" */
export function timeRangeText(start: number, end: number, tz: string): string {
  const a = zoned(start, tz);
  const b = zoned(end, tz);
  const s = clock(a.h, a.mi);
  const e = clock(b.h, b.mi);
  return s.ampm === e.ampm ? `${s.t}–${e.t} ${e.ampm}` : `${s.t} ${s.ampm}–${e.t} ${e.ampm}`;
}

/** "30 min", "an hour", "2 hrs" */
export function durationText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 60) return "an hour";
  return `${Math.round((minutes / 60) * 100) / 100} hrs`;
}

function dayLabel(ms: number, tz: string, now: number): { text: string; relative: boolean } {
  const z = zoned(ms, tz);
  const t = zoned(now, tz);
  const diff = Math.round((Date.UTC(z.y, z.m - 1, z.d) - Date.UTC(t.y, t.m - 1, t.d)) / DAY);
  const md = `${z.month} ${z.d}`;
  if (diff === 0) return { text: `today (${md})`, relative: true };
  if (diff === 1) return { text: `tomorrow (${md})`, relative: true };
  if (diff > 1 && diff < 8) return { text: `${z.weekday} ${md}`, relative: false };
  return { text: z.y === t.y ? md : `${md}, ${z.y}`, relative: false };
}

function orList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * Availability template. Slots are merged when they overlap or touch, then grouped by day.
 * `attendees` (emails, without the user) switch "I" → "We" and add "to meet with us" when there is at least one external
 * guest and at least one internal one (same non-public domain as `me`).
 */
export function renderAvailabilityText(input: { slots: TimeRange[]; duration: number; timeZone?: string; attendees?: string[]; me?: string; now?: number }): string {
  const tz = input.timeZone || localZone();
  const now = input.now ?? Date.now();
  const slots = mergeRanges(input.slots);
  if (!slots.length) return "";
  const myDomain = input.me?.split("@")[1]?.toLowerCase() ?? "";
  const others = (input.attendees ?? []).map((a) => a.toLowerCase()).filter((a) => a && a !== input.me?.toLowerCase());
  const internal = (a: string) => !!myDomain && !PUBLIC_DOMAINS.has(myDomain) && a.split("@")[1] === myDomain;
  const group = others.some((a) => !internal(a)) && others.some(internal);
  const us = group ? " to meet with us" : "";
  const exact = slots.every((s) => s.end - s.start === input.duration * MIN);
  const dur = durationText(input.duration);
  const zone = tzAbbrev(slots[0].start, tz);
  const byDay = new Map<string, TimeRange[]>();
  for (const s of slots) {
    const z = zoned(s.start, tz);
    const k = `${z.y}-${z.m}-${z.d}`;
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const days = [...byDay.values()];
  if (days.length === 1 && days[0].length <= 3) {
    const label = dayLabel(days[0][0].start, tz, now);
    const when = exact ? label.text : `${dur}${label.relative ? " " : " on "}${label.text}`;
    const times = orList(days[0].map((s) => timeRangeText(s.start, s.end, tz)));
    return `Does ${when} work${us}? ${group ? "We" : "I"} can do ${times} ${zone}.`;
  }
  const head = exact ? `Do any of these times (${zone}) work${us}?` : `Does ${dur} during any of these times (${zone}) work${us}?`;
  const lines = days.map((d) => `- ${dayLabel(d[0].start, tz, now).text}: ${d.map((s) => timeRangeText(s.start, s.end, tz)).join(", ")}`);
  return [head, ...lines].join("\n");
}
