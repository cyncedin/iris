import { AsyncLocalStorage } from "node:async_hooks";
import type { IcsEvent } from "./ics.ts";
import type { Calendar, CalendarEvent, Label, Message, ResponseStatus, TimeRange } from "./types.ts";

export interface ProviderThread {
  id: string;
  historyId: string;
  messages: Message[];
}

export interface HistoryResult {
  historyId: string;
  changedThreadIds: string[];
  /** threads with new messages (need full bodies); the rest only changed labels */
  addedThreadIds?: string[];
  deletedMessageIds: string[];
}

export interface ProviderDraft {
  draftId: string;
  messageId: string;
  threadId: string;
}

export interface MailProvider {
  readonly kind: "gmail" | "fake";
  profile(): Promise<{ email: string; historyId: string; threadsTotal?: number }>;
  listLabels(): Promise<Label[]>;
  createLabel(name: string): Promise<Label>;
  deleteLabel(id: string): Promise<void>;
  /** Gmail filters: criteria and action as the API returns them */
  listFilters?(): Promise<{ id: string; criteria: Record<string, unknown>; action: { addLabelIds?: string[]; removeLabelIds?: string[] } }[]>;
  listThreadIds(opts: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string }): Promise<{
    ids: string[];
    nextPageToken?: string;
  }>;
  /** null when the thread no longer exists */
  /** format "metadata" = headers + snippet only (much cheaper on Gmail quota) */
  getThread(id: string, format?: "full" | "metadata"): Promise<ProviderThread | null>;
  /** "expired" when startHistoryId is too old and a full resync is required */
  history(startHistoryId: string): Promise<HistoryResult | "expired">;
  modifyThread(id: string, add: string[], remove: string[]): Promise<void>;
  modifyMessages(ids: string[], add: string[], remove: string[]): Promise<void>;
  trashThread(id: string): Promise<void>;
  untrashThread(id: string): Promise<void>;
  send(raw: Buffer, threadId?: string): Promise<{ id: string; threadId: string }>;
  createDraft(raw: Buffer, threadId?: string): Promise<ProviderDraft>;
  updateDraft(draftId: string, raw: Buffer, threadId?: string): Promise<ProviderDraft>;
  deleteDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<{ id: string; threadId: string }>;
  listDrafts(): Promise<ProviderDraft[]>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  getRawMessage(messageId: string): Promise<Buffer>;
  /** optional: create a Gmail filter (block sender etc.) */
  createFilter?(criteria: { from?: string }, action: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<void>;
  sendAsSignature?(): Promise<{ name: string; signature: string } | null>;
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Work running inside `inBackground` (sync, prefetch) yields provider quota to user-driven calls. */
export const backgroundWork = new AsyncLocalStorage<boolean>();
export function inBackground<T>(fn: () => Promise<T>): Promise<T> {
  return backgroundWork.run(true, fn);
}

// ---------------------------------------------------------------- calendar

/** Fields Iris writes to an event. start/end are epoch ms (all-day: local midnights, end exclusive) and always come together. */
export interface CalendarEventWrite {
  summary?: string;
  description?: string;
  location?: string;
  start?: number;
  end?: number;
  allDay?: boolean;
  /** full guest list (emails); existing response states are kept */
  attendees?: string[];
  /** add a Google Meet link */
  conference?: boolean;
}

export interface CalendarEventsResult {
  /** changed (incremental) or all listed events; never cancelled ones */
  events: CalendarEvent[];
  /** ids of cancelled/deleted events (showDeleted=true) */
  deletedIds: string[];
  /** set once pagination finished; null for ranged (timeMin+timeMax) listings */
  nextSyncToken: string | null;
}

export type SendUpdates = "all" | "none";

export interface CalendarProvider {
  readonly kind: "google" | "fake";
  /** visible calendars (hidden ones dropped except primary); `selected` = primary or Google's selected flag */
  listCalendars(): Promise<Calendar[]>;
  /**
   * Single instances, showDeleted, eventTypes default/focusTime/outOfOffice/fromGmail.
   * - `{ timeMin }` (no timeMax): initial sync, returns nextSyncToken after the last page
   * - `{ syncToken }`: incremental
   * - `{ timeMin, timeMax }`: on-demand range outside the cache (no token)
   * "expired" = 410 Gone: clear the token and resync. Throws ProviderError(404) when the calendar is gone.
   */
  listEvents(calendarId: string, opts: { timeMin?: number; timeMax?: number; syncToken?: string }): Promise<CalendarEventsResult | "expired">;
  /** null when the event does not exist (anymore) */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
  /** events.list?iCalUID=&showHiddenInvitations=true&showDeleted=true (series not expanded; may include cancelled) */
  findByICalUID(calendarId: string, iCalUID: string): Promise<CalendarEvent[]>;
  insertEvent(calendarId: string, e: CalendarEventWrite, opts: { sendUpdates: SendUpdates }): Promise<CalendarEvent>;
  patchEvent(calendarId: string, eventId: string, e: CalendarEventWrite, opts: { sendUpdates: SendUpdates }): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string, opts: { sendUpdates: SendUpdates }): Promise<void>;
  /** PATCH ?sendUpdates=all {attendeesOmitted:true, attendees:[{email:self, responseStatus}]} */
  respond(calendarId: string, eventId: string, selfEmail: string, response: Exclude<ResponseStatus, "needsAction">): Promise<CalendarEvent>;
  /** events.import of an invite that is not on the calendar yet */
  importEvent(calendarId: string, ve: IcsEvent): Promise<CalendarEvent>;
  /** other people's calendars (own busy time comes from cached events) */
  freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<TimeRange[]>;
}
