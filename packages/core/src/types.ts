// Shared domain types for Iris.

export interface Address {
  name: string;
  email: string;
}

export interface AttachmentMeta {
  id: string; // provider attachment id
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId?: string;
}

export interface Message {
  id: string;
  threadId: string;
  accountId: string;
  date: number; // epoch ms
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  snippet: string;
  labelIds: string[];
  messageIdHeader: string;
  references: string;
  inReplyTo: string;
  listId: string;
  listUnsubscribe: string;
  listUnsubscribePost: string;
  bodyHtml: string;
  bodyText: string;
  attachments: AttachmentMeta[];
  isDraft: boolean;
  isSent: boolean;
  /** false = synced as metadata only (headers + snippet); body is fetched on demand */
  bodyLoaded?: boolean;
  /** metadata-only messages: top-level Content-Type is multipart/mixed (probably has attachments) */
  attachmentHint?: boolean;
  /** decoded text/calendar part (meeting invites), when the message carries one inline */
  ics?: string;
}

export interface ThreadSummary {
  id: string;
  accountId: string;
  subject: string;
  snippet: string;
  lastDate: number;
  participants: Address[]; // ordered: latest senders first, deduped
  labelIds: string[]; // union over messages
  messageCount: number;
  unread: boolean;
  starred: boolean;
  important: boolean;
  inInbox: boolean;
  hasAttachments: boolean;
  hasDraft: boolean;
  lastFrom: Address | null;
  listId: string;
  /** reminder status line, e.g. "Returning: tomorrow if no reply" */
  reminder?: ReminderInfo | null;
  returnedAt?: number | null;
  aiLabels?: string[];
}

export interface Thread extends ThreadSummary {
  messages: Message[];
  /** set when a message in the thread carries a text/calendar part (meeting invite / update / cancel / reply) */
  invite?: CalendarInvite;
}

export interface Label {
  id: string;
  name: string;
  type: "system" | "user";
  color?: { textColor?: string; backgroundColor?: string } | null;
  messagesUnread?: number;
}

export interface Account {
  id: string; // = email address
  email: string;
  name: string;
  provider: "gmail" | "fake";
  historyId: string | null;
  createdAt: number;
  lastSyncAt: number | null;
  signatureHtml: string;
}

export interface Split {
  id: string;
  accountId: string;
  name: string;
  /** Gmail-style query evaluated locally against inbox threads */
  query: string;
  position: number;
  /** keep matching threads visible in Important/Other too */
  leaveInImportantOther: boolean;
  builtin: "important" | "other" | null;
  enabled: boolean;
}

export interface ReminderInfo {
  id: string;
  threadId: string;
  remindAt: number;
  ifNoReply: boolean;
  status: "pending" | "returned" | "cancelled" | "replied";
  note: string;
}

export interface DraftInput {
  accountId?: string;
  to: string | Address[];
  cc?: string | Address[];
  bcc?: string | Address[];
  subject: string;
  /** HTML body; plain text is derived */
  html?: string;
  text?: string;
  /** reply context */
  threadId?: string;
  inReplyToMessageId?: string; // provider message id we reply to
  attachments?: { filename: string; contentType: string; contentBase64: string }[];
  /** provider draft id when updating an existing Gmail draft */
  draftId?: string;
}

export interface OutboxItem {
  id: string;
  accountId: string;
  draft: DraftInput;
  sendAt: number;
  status: "queued" | "sending" | "sent" | "cancelled" | "failed";
  error: string | null;
  sentMessageId: string | null;
  markDoneAfter: boolean;
  createdAt: number;
}

export interface Snippet {
  id: string;
  name: string;
  subject: string;
  html: string;
  to: string;
  cc: string;
  bcc: string;
  updatedAt: number;
}

export interface GoalStep {
  id: string;
  title: string;
  doneAt: number | null;
}

export interface GoalThread {
  accountId: string;
  threadId: string;
  subject: string;
  lastDate: number | null;
}

export type GoalPace = "on_track" | "adjust" | "off_track" | "no_plan" | "done";

export interface GoalProgress {
  percent: number;
  doneSteps: number;
  totalSteps: number;
  /** "Day 52 of 84" */
  day: number;
  totalDays: number;
  daysLeft: number;
  /** share of the goal's time that has passed */
  expectedPercent: number;
  stepsBehind: number;
  doneLast7Days: number;
  pace: GoalPace;
  /** steps finished per week since the start */
  weeks: { start: number; done: number }[];
  /** gap = percent done minus percent expected at that moment, weekly up to now */
  trajectory: { at: number; percent: number; expected: number; gap: number }[];
  /** where the goal ends up at the pace so far; null until it has run for a week */
  projected: { at: number; gap: number } | null;
  /** kind "metric" only */
  metric?: { current: number; expected: number; lastDate: string | null };
  /** kind "habit" only. Today only counts as passed once it is logged, so an open morning costs nothing. */
  habit?: { loggedDays: number; elapsedDays: number; streak: number; last7: number; last7Target: 7; doneToday: boolean };
}

export type GoalKind = "steps" | "metric" | "habit";

/** One calendar day of a metric (value) or habit (value null) goal. */
export interface GoalEntry {
  /** YYYY-MM-DD, the day as the user lived it */
  date: string;
  value: number | null;
}

export interface Goal {
  id: string;
  title: string;
  why: string;
  startAt: number;
  dueAt: number;
  status: "active" | "done";
  kind: GoalKind;
  startValue: number | null;
  targetValue: number | null;
  unit: string;
  /** first calendar day of a metric or habit goal, fixed so that travelling can't shift it */
  startDate: string | null;
  entries: GoalEntry[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  steps: GoalStep[];
  threads: GoalThread[];
  progress: GoalProgress;
}

export interface Contact {
  email: string;
  name: string;
  score: number;
  lastContacted: number;
}

export type ViewName =
  | "inbox"
  | "starred"
  | "drafts"
  | "sent"
  | "done"
  | "reminders"
  | "scheduled"
  | "all"
  | "spam"
  | "trash"
  | "muted"
  | "label"
  | "search"
  | "split";

export interface ListQuery {
  accountId?: string;
  view: ViewName;
  splitId?: string;
  labelId?: string;
  q?: string;
  filter?: "unread" | "starred" | "important" | null;
  /** hide threads whose AI labels are all in this list */
  hideLabels?: string[];
  /** hide threads without an AI label */
  hideUnlabeled?: boolean;
  limit?: number;
  offset?: number;
}

export interface IrisEvent {
  type:
    | "sync"
    | "threads-changed"
    | "thread-updated"
    | "outbox"
    | "reminder"
    | "notification"
    | "error"
    | "account"
    | "calendar-changed"
    | "goals-changed"
    | "research-changed";
  accountId?: string;
  threadIds?: string[];
  data?: unknown;
  at: number;
}

// ---------------------------------------------------------------- calendar

export interface Calendar {
  id: string;
  accountId: string;
  summary: string;
  /** display color: the user's override if set, else Google's calendar color */
  color: string;
  primary: boolean;
  /** shown in the calendar view. First run: primary + Google's own `selected` flag; then a local preference */
  selected: boolean;
  /** meeting notifications for this calendar (default: primary only) */
  notify: boolean;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  timeZone: string;
}

export type ResponseStatus = "needsAction" | "declined" | "tentative" | "accepted";

export interface EventAttendee {
  email: string;
  name: string;
  responseStatus: ResponseStatus;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  accountId: string;
  iCalUID: string;
  summary: string;
  description: string;
  location: string;
  /** epoch ms; all-day events: local midnight .. next local midnight (end exclusive) */
  start: number;
  end: number;
  /** from Google's start.date */
  allDay: boolean;
  /** render in the all-day row: allDay, or lasting 24 h or more */
  allDayRow: boolean;
  timeZone?: string;
  status: "confirmed" | "tentative" | "cancelled";
  organizer: { email: string; name: string; self?: boolean };
  attendees: EventAttendee[];
  selfResponse?: ResponseStatus;
  /** Meet/Zoom/Teams link if any */
  conferenceUrl?: string;
  htmlLink: string;
  recurringEventId?: string;
  color?: string;
  /** "free" (transparency=transparent): does not count as busy */
  transparent?: boolean;
  /** Google eventType when not "default": focusTime, outOfOffice, fromGmail */
  eventType?: string;
  updated: number;
}

export type RecurrenceScope = "this" | "following" | "all";

/** POST /api/events body; PATCH takes a partial. `text` is natural language, explicit fields win. */
export interface EventInput {
  account?: string;
  calendarId?: string;
  text?: string;
  summary?: string;
  /** epoch ms, ISO string, or natural language */
  start?: number | string;
  end?: number | string;
  allDay?: boolean;
  attendees?: string[] | string;
  location?: string;
  description?: string;
  /** add a Google Meet link (default: settings.calendar.defaultMeetingLink) */
  conference?: boolean;
  /** PATCH/DELETE: email guests (sendUpdates=all|none). Default: notify when the event has guests */
  notify?: boolean;
  /** PATCH/DELETE of a recurring event instance. Default "this" */
  scope?: RecurrenceScope;
}

export type InviteMethod = "REQUEST" | "CANCEL" | "REPLY" | "COUNTER" | "REFRESH" | "ADD" | "DECLINECOUNTER" | "PUBLISH" | "NONE";

export interface CalendarInvite {
  iCalUID: string;
  method: InviteMethod;
  /** request = RSVP buttons; reply = "<name> has accepted"; cancel = "Event has been canceled"; update = changed invite */
  kind: "request" | "reply" | "cancel" | "update";
  summary: string;
  description: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  conferenceUrl?: string;
  organizer: { email: string; name: string };
  attendees: EventAttendee[];
  /** last RSVP sent from Iris for this message, else the calendar's / the invite's state */
  selfResponse?: ResponseStatus;
  recurring: boolean;
  /** the user is a guest and the invite is a request/update (not a cancel/reply) */
  canRsvp: boolean;
  /** kind=reply: who answered and how */
  replyFrom?: { email: string; name: string; responseStatus: ResponseStatus };
  /** message that carried the invite */
  messageId: string;
  /** the matching event in the user's calendar (series master for recurring invites) */
  event?: CalendarEvent;
}

export interface TimeRange {
  start: number;
  end: number;
}

// ---------------------------------------------------------------- unified accounts

/** GET /api/accounts item: the account without its signature, plus its color. */
export interface AccountInfo extends Omit<Account, "signatureHtml"> {
  /** deterministic per account (connection order, see ACCOUNT_COLORS) */
  color: string;
}

/** A thread in a given account. Cross-account actions take `refs: ThreadRef[]`. */
export interface ThreadRef {
  account?: string;
  /** alias of `account` (as on ThreadSummary) */
  accountId?: string;
  threadId: string;
}

export interface MailboxCounts {
  inbox: number;
  inboxUnread: number;
  important: number;
  importantUnread: number;
  other: number;
  otherUnread: number;
  starred: number;
  drafts: number;
  reminders: number;
  scheduled: number;
  spam: number;
  trash: number;
}

export interface MailboxAccount {
  id: string;
  email: string;
  name: string;
  color: string;
  provider: Account["provider"];
  /** last mail sync error, null when the last sync worked */
  error: string | null;
  counts: MailboxCounts;
  /** user labels (no Iris/* system labels) with unread thread counts */
  labels: { id: string; name: string; unread: number }[];
}

/** GET /api/mailboxes: sidebar data for every account in one call. */
export interface Mailboxes {
  unified: Pick<MailboxCounts, "inbox" | "inboxUnread" | "important" | "importantUnread" | "other" | "otherUnread">;
  accounts: MailboxAccount[];
}

// ---------------------------------------------------------------- person research

export type ResearchStatus = "running" | "done" | "failed";

/**
 * Where `name` comes from: the meeting title, the attendee entry (display name or email local part), the From header of
 * mail sent from that address, the person's mail signature, the web (model, NAME line), or the user typing it.
 */
export type ResearchNameSource = "title" | "attendee" | "mail-header" | "signature" | "web" | "user" | "";

export interface ResearchSource {
  url: string;
  title: string;
}

export interface PersonResearch {
  id: string; // "r_" + random
  accountId: string;
  /** as entered / guessed, e.g. "Elena"; upgraded to the full name once mail or the report establishes it */
  name: string;
  nameSource: ResearchNameSource;
  /** "" if unknown */
  email: string;
  /** what the user already knows, free text, "" if none */
  context: string;
  /** "" if not started from an event */
  eventId: string;
  calendarId: string;
  eventTitle: string;
  status: ResearchStatus;
  /** markdown report, "" while running */
  report: string;
  /** one sentence, also shown in lists and the notification */
  tldr: string;
  /** how sure the person found is the person in the meeting */
  confidence: "high" | "medium" | "low" | "";
  sources: ResearchSource[];
  error: string;
  /** short live progress line while running, e.g. "Searching: Elena Marsh Lisbon" */
  progress: string;
  createdAt: number;
  updatedAt: number;
}

/** Someone in a meeting worth researching: an attendee, or a name guessed from the title (email ""). */
export interface MeetingPerson {
  /** "" when nothing names the person (the email then identifies them) */
  name: string;
  email: string;
  nameSource: ResearchNameSource;
}

/** `notification` event data with kind "meeting-research" (meeting-start prompt). */
export interface MeetingResearchPrompt {
  kind: "meeting-research";
  accountId: string;
  title: string;
  start: number;
  end: number;
  calendarId: string;
  eventId: string;
  people: MeetingPerson[];
  existing: { id: string; status: ResearchStatus; tldr: string }[];
}
