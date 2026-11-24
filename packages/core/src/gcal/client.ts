// Google Calendar REST API v3 provider. Same OAuth grant (refresh token) as Gmail, own quota limiter.
import { QuotaLimiter } from "../gmail/client.ts";
import { CALENDAR_SCOPE_ERROR, loadTokens, refreshAccessToken, scopeAllowsCalendar } from "../gmail/oauth.ts";
import { backgroundWork, ProviderError, type CalendarEventWrite, type CalendarProvider, type SendUpdates } from "../provider.ts";
import type { Calendar, CalendarEvent, ResponseStatus, TimeRange } from "../types.ts";
import type { IcsEvent } from "../ics.ts";
import { importBody, mapCalendar, mapEvent, mergeRanges, toGoogleBody, type GCalendarListEntry, type GEvent } from "./model.ts";

export { mergeRanges };

const BASE = "https://www.googleapis.com/calendar/v3";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
/** drops workingLocation and birthday events */
const EVENT_TYPES = ["default", "focusTime", "outOfOffice", "fromGmail"];

export class GoogleCalendarProvider implements CalendarProvider {
  readonly kind = "google" as const;
  readonly email: string;
  readonly limiter: QuotaLimiter;
  private accessToken: string | null = null;
  private expiry = 0;
  private refreshing: Promise<void> | null = null;
  /** granted OAuth scopes as last seen (login or token refresh) */
  private scope: string | undefined;

  constructor(email: string, limiter?: QuotaLimiter) {
    const rate = Number(process.env.IRIS_GCAL_CALLS_PER_SEC) || 8;
    // Calendar quota is per call (not units) and separate from Gmail: ~8 calls/s, small burst
    this.limiter = limiter ?? new QuotaLimiter(rate, Math.max(20, rate), 1, "calendar");
    this.email = email;
    const t = loadTokens(email);
    this.scope = t?.scope;
    if (t?.access_token && t.expiry) {
      this.accessToken = t.access_token;
      this.expiry = t.expiry;
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiry - 60_000) return this.accessToken;
    if (!this.refreshing) {
      this.refreshing = refreshAccessToken(this.email)
        .then((t) => {
          this.accessToken = t.access_token ?? null;
          this.expiry = t.expiry ?? 0;
          this.scope = t.scope ?? this.scope;
        })
        .finally(() => (this.refreshing = null));
    }
    await this.refreshing;
    return this.accessToken!;
  }

  private async req<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    // no API call when the stored grant already shows the calendar scope is missing
    if (!scopeAllowsCalendar(this.scope)) throw new ProviderError(CALENDAR_SCOPE_ERROR, 403);
    await this.limiter.take(1, backgroundWork.getStore() ? "low" : "high");
    const token = await this.token();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      this.expiry = 0;
      return this.req(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text();
      const quota = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|Quota exceeded|RESOURCE_EXHAUSTED/.test(text));
      if (quota && attempt < 6) {
        this.limiter.penalize(2);
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(16_000, 500 * 2 ** attempt);
        await sleep(wait + Math.random() * 300);
        return this.req(method, path, body, attempt + 1);
      }
      if (res.status >= 500 && attempt < 4) {
        await sleep(Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 300);
        return this.req(method, path, body, attempt + 1);
      }
      if (res.status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(text)) {
        throw new ProviderError(CALENDAR_SCOPE_ERROR, 403);
      }
      if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project/.test(text)) {
        const project = text.match(/project[ s/=]+(\d+)/)?.[1];
        throw new ProviderError(
          `The Google Calendar API is not enabled for your Google Cloud project. Enable it at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com${project ? `?project=${project}` : ""}, wait a minute, then run: iris cal sync`,
          403,
        );
      }
      throw new ProviderError(`Calendar ${method} ${path.split("?")[0]} → ${res.status}: ${text.slice(0, 400)}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async listCalendars(): Promise<Calendar[]> {
    const out: Calendar[] = [];
    let pageToken: string | undefined;
    do {
      const p = new URLSearchParams({ maxResults: "250", showHidden: "true" });
      if (pageToken) p.set("pageToken", pageToken);
      const r = await this.req<{ items?: GCalendarListEntry[]; nextPageToken?: string }>("GET", `/users/me/calendarList?${p}`);
      for (const c of r.items ?? []) if (!c.deleted && (!c.hidden || c.primary)) out.push(mapCalendar(c, this.email));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async listEvents(calendarId: string, opts: { timeMin?: number; timeMax?: number; syncToken?: string }) {
    const events: CalendarEvent[] = [];
    const deletedIds: string[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    try {
      do {
        // same parameters for the initial and the incremental calls (Google requires it); never syncToken + timeMin/timeMax
        const p = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "500" });
        for (const t of EVENT_TYPES) p.append("eventTypes", t);
        if (opts.syncToken) p.set("syncToken", opts.syncToken);
        else {
          if (opts.timeMin !== undefined) p.set("timeMin", new Date(opts.timeMin).toISOString());
          if (opts.timeMax !== undefined) p.set("timeMax", new Date(opts.timeMax).toISOString());
        }
        if (pageToken) p.set("pageToken", pageToken);
        const r = await this.req<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>("GET", `/calendars/${enc(calendarId)}/events?${p}`);
        for (const e of r.items ?? []) {
          if (e.status === "cancelled") deletedIds.push(e.id);
          else events.push(mapEvent(e, calendarId, this.email));
        }
        pageToken = r.nextPageToken;
        if (!pageToken) nextSyncToken = r.nextSyncToken ?? null; // only valid after the last page
      } while (pageToken);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 410) return "expired" as const;
      throw e;
    }
    return { events, deletedIds, nextSyncToken: opts.timeMax !== undefined && !opts.syncToken ? null : nextSyncToken };
  }

  private async raw(calendarId: string, eventId: string): Promise<GEvent | null> {
    try {
      const e = await this.req<GEvent>("GET", `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
      return e.status === "cancelled" ? null : e;
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 404 || e.status === 410)) return null;
      throw e;
    }
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    const e = await this.raw(calendarId, eventId);
    return e ? mapEvent(e, calendarId, this.email) : null;
  }

  async findByICalUID(calendarId: string, iCalUID: string): Promise<CalendarEvent[]> {
    const p = new URLSearchParams({ iCalUID, showHiddenInvitations: "true", showDeleted: "true" });
    const r = await this.req<{ items?: GEvent[] }>("GET", `/calendars/${enc(calendarId)}/events?${p}`);
    return (r.items ?? []).map((e) => mapEvent(e, calendarId, this.email));
  }

  async insertEvent(calendarId: string, w: CalendarEventWrite, opts: { sendUpdates: SendUpdates }): Promise<CalendarEvent> {
    const p = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: opts.sendUpdates });
    const e = await this.req<GEvent>("POST", `/calendars/${enc(calendarId)}/events?${p}`, toGoogleBody(w, null, { patch: false }));
    return mapEvent(e, calendarId, this.email);
  }

  async patchEvent(calendarId: string, eventId: string, w: CalendarEventWrite, opts: { sendUpdates: SendUpdates }): Promise<CalendarEvent> {
    // attendees are replaced as a list: start from the current one so others' responses survive
    const existing = w.attendees || w.conference ? await this.raw(calendarId, eventId) : null;
    if ((w.attendees || w.conference) && !existing) throw new ProviderError(`Unknown event: ${eventId}`, 404);
    const p = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: opts.sendUpdates });
    const e = await this.req<GEvent>("PATCH", `/calendars/${enc(calendarId)}/events/${enc(eventId)}?${p}`, toGoogleBody(w, existing, { patch: true }));
    return mapEvent(e, calendarId, this.email);
  }

  async deleteEvent(calendarId: string, eventId: string, opts: { sendUpdates: SendUpdates }): Promise<void> {
    try {
      await this.req("DELETE", `/calendars/${enc(calendarId)}/events/${enc(eventId)}?${new URLSearchParams({ sendUpdates: opts.sendUpdates })}`);
    } catch (e) {
      if (!(e instanceof ProviderError && (e.status === 404 || e.status === 410))) throw e;
    }
  }

  async respond(calendarId: string, eventId: string, selfEmail: string, response: Exclude<ResponseStatus, "needsAction">): Promise<CalendarEvent> {
    const p = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: "all" });
    const e = await this.req<GEvent>("PATCH", `/calendars/${enc(calendarId)}/events/${enc(eventId)}?${p}`, {
      attendeesOmitted: true,
      attendees: [{ email: selfEmail, responseStatus: response }],
    });
    return mapEvent(e, calendarId, this.email);
  }

  async importEvent(calendarId: string, ve: IcsEvent): Promise<CalendarEvent> {
    const e = await this.req<GEvent>("POST", `/calendars/${enc(calendarId)}/events/import?conferenceDataVersion=1`, importBody(ve));
    return mapEvent(e, calendarId, this.email);
  }

  async freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<TimeRange[]> {
    if (!calendarIds.length) return [];
    const r = await this.req<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>("POST", "/freeBusy", {
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      items: calendarIds.slice(0, 50).map((id) => ({ id })),
    });
    const busy: TimeRange[] = [];
    for (const c of Object.values(r.calendars ?? {})) for (const b of c.busy ?? []) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    return mergeRanges(busy);
  }
}
