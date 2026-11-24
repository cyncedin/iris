// Iris service facade: everything the UI, CLI and MCP server can do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CalendarService } from "./calendar.ts";
import { GoalService } from "./goals.ts";
import { DB, uid } from "./db.ts";
import { Bus } from "./events.ts";
import {
  ALL_ACCOUNTS,
  BUILTIN_SPLITS,
  accountColor,
  builtinSplitKind,
  ensureHome,
  irisHome,
  isAllAccounts,
  loadSettings,
  saveSettings,
  type IrisSettings,
} from "./config.ts";
import { FakeCalendarProvider } from "./fake/calendar.ts";
import { FakeProvider } from "./fake/provider.ts";
import { GoogleCalendarProvider } from "./gcal/client.ts";
import { GmailProvider } from "./gmail/client.ts";
import { forgetTokens, loginWithBrowser } from "./gmail/oauth.ts";
import {
  buildMime,
  displayName,
  escapeHtml,
  formatAddress,
  htmlToText,
  mentionsAttachment,
  parseAddressList,
  replySubject,
  toAddresses,
} from "./mime.ts";
import type { CalendarProvider, MailProvider } from "./provider.ts";
import { inBackground } from "./provider.ts";
import { evaluate, ftsExpression, isEmptyQuery, parseQuery, positiveTerms, type QNode, type QueryTarget } from "./query.ts";
import { Store } from "./store.ts";
import { SyncEngine } from "./sync.ts";
import type {
  Account,
  AccountInfo,
  Address,
  Contact,
  DraftInput,
  Label,
  ListQuery,
  MailboxAccount,
  MailboxCounts,
  Mailboxes,
  Message,
  OutboxItem,
  ReminderInfo,
  Snippet,
  Split,
  Thread,
  ThreadRef,
  ThreadSummary,
} from "./types.ts";
import { describeWhen, parseWhen, reminderPresets } from "./when.ts";

export const IRIS_LABELS = {
  reminders: "Iris/Reminders",
  muted: "Iris/Muted",
} as const;

interface LabelOp {
  threadId: string;
  add: string[];
  remove: string[];
}

/** What undo restores in one account. */
interface UndoPart {
  accountId: string;
  ops: LabelOp[];
  trashed?: string[];
  reminders?: string[];
}

/** One undo step; cross-account actions (refs) hold one part per account. */
interface UndoEntry {
  id: string;
  description: string;
  parts: UndoPart[];
  createdAt: number;
}

/** Result shape of the undoable thread actions. */
export interface ActionResult {
  ok: boolean;
  count: number;
  undoId?: string;
  description?: string;
}

export interface IrisOptions {
  home?: string;
  demo?: boolean;
}

export interface ListResult {
  threads: ThreadSummary[];
  total: number;
}

export interface SplitWithCount extends Split {
  count: number;
  unread: number;
}

interface InboxMemo {
  key: string;
  threads: ThreadSummary[];
  assign?: { key: string; map: Map<string, string[]> };
}

export interface LabelBackupSummary {
  accountId: string;
  file: string;
  labels: { name: string; threads: number }[];
  /** Gmail filters that add or remove one of these labels */
  filters: number;
}

/** Per-account sidebar counts that only change with thread/label state (memoized like the inbox). */
interface MailboxMemo {
  key: string;
  counts: Pick<MailboxCounts, "starred" | "drafts" | "spam" | "trash">;
  labels: MailboxAccount["labels"];
}

export class Iris {
  readonly home: string;
  readonly db: DB;
  readonly store: Store;
  readonly bus = new Bus();
  readonly sync: SyncEngine;
  /** Google Calendar: cached events, writes, RSVP, availability */
  readonly calendar: CalendarService;
  readonly goals: GoalService;
  readonly demo: boolean;
  settings: IrisSettings;
  private providers = new Map<string, MailProvider>();
  private calendarProviders = new Map<string, CalendarProvider>();
  private queues = new Map<string, Promise<unknown>>();
  private undoStack: UndoEntry[] = [];
  private timers: NodeJS.Timeout[] = [];
  /** Per-account memo of the sorted inbox and its split assignment (see inboxState). */
  private inboxMemo = new Map<string, InboxMemo>();
  private mailboxMemo = new Map<string, MailboxMemo>();

  constructor(opts: IrisOptions = {}) {
    this.demo = !!opts.demo;
    this.home = opts.home ?? (this.demo ? fs.mkdtempSync(path.join(os.tmpdir(), "iris-demo-")) : irisHome());
    ensureHome(this.home);
    this.settings = loadSettings(this.home);
    this.db = new DB(path.join(this.home, "iris.db"));
    this.store = new Store(this.db);
    this.sync = new SyncEngine(this.store, (id) => this.provider(id), this.bus, () => this.settings);
    this.sync.onNewMessages = (accountId, msgs) => this.handleNewMessages(accountId, msgs);
    this.calendar = new CalendarService({
      db: this.db,
      bus: this.bus,
      provider: (id) => this.calendarProvider(id),
      mail: (id) => this.provider(id),
      acct: (id) => this.acct(id),
      accounts: () => this.store.accounts().map((a) => a.id),
      settings: () => this.settings,
    });
    this.goals = new GoalService({ db: this.db, bus: this.bus, acct: (id) => this.acct(id), parseWhen: (input) => this.parseWhen(input) });
    if (this.demo && !this.store.accounts().length) {
      this.store.upsertAccount({ id: "demo@iris.local", email: "demo@iris.local", name: "Demo User", provider: "fake" });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start background loops: periodic sync, reminders and the send queue. */
  start(): void {
    for (const a of this.store.accounts()) if (this.db.kvGet(`backfill:${a.id}`) === "running") this.loadWholeMailbox(a.id);
    const tick = async () => {
      await this.processOutbox().catch((e) => this.reportError("outbox", e));
      await this.processReminders().catch((e) => this.reportError("reminders", e));
    };
    this.timers.push(setInterval(tick, 2_000));
    const syncAll = () => {
      // SyncEngine already emits its own error event
      for (const a of this.store.accounts()) this.sync.sync(a.id).catch(() => undefined);
    };
    this.timers.push(setInterval(syncAll, Math.max(10, this.settings.syncIntervalSeconds) * 1000));
    syncAll();
    // calendar: own loop (background quota priority); failures are reported once per distinct error, mail is unaffected
    const calendarAll = () => {
      for (const a of this.store.accounts()) this.calendar.backgroundSync(a.id).catch(() => undefined);
    };
    this.timers.push(setInterval(calendarAll, 60_000));
    calendarAll();
    // meeting notifications (lead time: settings.calendar.notifyLeadSeconds)
    this.timers.push(setInterval(() => this.calendar.notifyDue(), 30_000));
    // person research: runs cut off by the last shutdown fail; "Research nötig?" once a meeting has started
    this.onResearchRecover?.();
    this.timers.push(
      setInterval(() => {
        try {
          this.onMeetingResearch?.();
        } catch (e) {
          this.reportError("research", e);
        }
      }, 30_000),
    );
    for (const a of this.store.accounts()) this.ensureDefaultSplits(a.id);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  close(): void {
    this.stop();
    this.db.close();
  }

  private reportError(where: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.bus.emitEvent({ type: "error", data: { where, message } });
  }

  updateSettings(patch: Partial<IrisSettings>): IrisSettings {
    this.settings = saveSettings(patch, this.home);
    return this.settings;
  }

  // ---------------------------------------------------------------- accounts

  provider(accountId: string): MailProvider {
    let p = this.providers.get(accountId);
    if (!p) {
      const a = this.store.account(accountId);
      if (!a) throw new Error(`Unknown account: ${accountId}`);
      p = a.provider === "fake" ? new FakeProvider(a.email) : new GmailProvider(a.email);
      this.providers.set(accountId, p);
    }
    return p;
  }

  calendarProvider(accountId: string): CalendarProvider {
    let p = this.calendarProviders.get(accountId);
    if (!p) {
      const a = this.store.account(accountId);
      if (!a) throw new Error(`Unknown account: ${accountId}`);
      p = a.provider === "fake" ? new FakeCalendarProvider(a.email) : new GoogleCalendarProvider(a.email);
      this.calendarProviders.set(accountId, p);
    }
    return p;
  }

  accounts(): Account[] {
    return this.store.accounts();
  }

  /** Resolve an optional account id (CLI/MCP convenience): default = first account. */
  acct(accountId?: string): string {
    const all = this.store.accounts();
    if (!all.length) throw new Error("No account connected. Run: iris auth login");
    if (!accountId) return all[0].id;
    const a = all.find((x) => x.id === accountId.toLowerCase() || x.email === accountId.toLowerCase());
    if (!a) throw new Error(`Unknown account: ${accountId}`);
    return a.id;
  }

  /** Accounts a read covers: `all` = every account in connection order, else one (default: first). */
  accountIds(accountId?: string): string[] {
    if (isAllAccounts(accountId)) return this.store.accounts().map((a) => a.id);
    return [this.acct(accountId)];
  }

  /** Deterministic account color: position in connection order on ACCOUNT_COLORS. */
  accountColor(accountId: string): string {
    return accountColor(this.store.accounts().findIndex((a) => a.id === accountId));
  }

  /** Accounts for clients (GET /api/accounts): no signature, with color. */
  accountInfos(): AccountInfo[] {
    return this.store.accounts().map(({ signatureHtml: _s, ...a }, i) => ({ ...a, color: accountColor(i) }));
  }

  async addGmailAccount(onUrl?: (url: string) => void, loginHint?: string): Promise<Account> {
    const r = await loginWithBrowser({ onUrl, loginHint, timeoutMs: 30 * 60_000 });
    this.store.upsertAccount({ id: r.email, email: r.email, name: r.name, provider: "gmail" });
    this.providers.delete(r.email);
    this.calendarProviders.delete(r.email); // new grant (calendar scope)
    this.ensureDefaultSplits(r.email);
    // fail fast with a helpful message (e.g. Gmail API not enabled in the Cloud project)
    await this.provider(r.email).profile();
    try {
      const sig = await this.provider(r.email).sendAsSignature?.();
      if (sig?.signature) this.store.setSignature(r.email, sig.signature);
    } catch {
      /* optional */
    }
    this.bus.emitEvent({ type: "account", accountId: r.email });
    this.sync.sync(r.email, true).catch((e) => this.reportError("sync", e));
    this.calendar.sync(r.email, { full: true }).catch(() => undefined); // reports its own error once
    return this.store.account(r.email)!;
  }

  removeAccount(accountId: string): void {
    const a = this.store.account(accountId);
    if (!a) return;
    if (a.provider === "gmail") forgetTokens(a.email);
    this.store.removeAccount(accountId);
    this.providers.delete(accountId);
    this.calendarProviders.delete(accountId);
    this.bus.emitEvent({ type: "account", accountId });
  }

  myAddress(accountId: string): Address {
    const a = this.store.account(accountId);
    return { name: a?.name ?? "", email: a?.email ?? accountId };
  }

  // ---------------------------------------------------------------- labels

  labels(accountId: string): Label[] {
    return this.store.labels(accountId);
  }

  async ensureLabel(accountId: string, name: string): Promise<Label> {
    const existing = this.store.labelByName(accountId, name);
    if (existing) return existing;
    const l = await this.provider(accountId).createLabel(name);
    await this.sync.syncLabels(accountId);
    return this.store.labelByName(accountId, name) ?? l;
  }

  /** Labels the account owner made (or other apps). Iris' own and Gmail's system labels are never touched. */
  private removableLabels(labels: Label[]): Label[] {
    return labels.filter((l) => l.type === "user" && !l.name.startsWith("Iris/"));
  }

  /** Save which threads carry which user label (live from Gmail, not the local cache) so a purge can be reconstructed. */
  async backupLabels(accountIdIn?: string): Promise<LabelBackupSummary> {
    const accountId = this.acct(accountIdIn);
    const p = this.provider(accountId);
    const labels: { id: string; name: string; threadIds: string[] }[] = [];
    for (const l of this.removableLabels(await p.listLabels())) {
      const threadIds: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await p.listThreadIds({ labelIds: [l.id], maxResults: 500, pageToken });
        threadIds.push(...page.ids);
        pageToken = page.nextPageToken;
      } while (pageToken);
      labels.push({ id: l.id, name: l.name, threadIds });
    }
    const ids = new Set(labels.map((l) => l.id));
    const filters = ((await p.listFilters?.()) ?? []).filter((f) => [...(f.action?.addLabelIds ?? []), ...(f.action?.removeLabelIds ?? [])].some((l) => ids.has(l)));
    const dir = path.join(this.home, "backups");
    ensureHome(dir);
    const createdAt = Date.now();
    const file = path.join(dir, `labels-${accountId}-${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ accountId, createdAt, labels, filters }, null, 2), { mode: 0o600 });
    this.db.kvSet(`labels_backup:${accountId}`, String(createdAt));
    return { accountId, file, labels: labels.map((l) => ({ name: l.name, threads: l.threadIds.length })), filters: filters.length };
  }

  /** Delete every user label of an account. Mail stays. Needs a fresh backup and the label count the user approved. */
  async purgeLabels(accountIdIn: string | undefined, expected: number, keep: string[] = []): Promise<{ deleted: string[]; failed: { name: string; error: string }[] }> {
    const accountId = this.acct(accountIdIn);
    const backupAt = Number(this.db.kvGet(`labels_backup:${accountId}`) ?? 0);
    if (Date.now() - backupAt > 86_400_000) throw new Error("Run the label backup first (iris labels backup).");
    const p = this.provider(accountId);
    const labels = this.removableLabels(await p.listLabels()).filter((l) => !keep.includes(l.name));
    if (labels.length !== expected) throw new Error(`Expected ${expected} labels but found ${labels.length}. Nothing was deleted.`);
    const deleted: string[] = [];
    const removed: string[] = [];
    const failed: { name: string; error: string }[] = [];
    // children before parents
    for (const l of [...labels].sort((a, b) => b.name.length - a.name.length)) {
      try {
        await p.deleteLabel(l.id);
        deleted.push(l.name);
        removed.push(l.id);
      } catch (e) {
        failed.push({ name: l.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const mine = this.sync.myEmails(accountId);
    const threads = this.db.all<{ thread_id: string }>(
      `SELECT DISTINCT thread_id FROM messages WHERE account_id = ? AND EXISTS (SELECT 1 FROM json_each(messages.label_ids) WHERE value IN (${removed.map(() => "?").join(",") || "''"}))`,
      accountId,
      ...removed,
    );
    this.db.tx(() => {
      for (const t of threads) this.store.applyLabelsLocal(accountId, t.thread_id, [], removed, mine);
    });
    await this.sync.syncLabels(accountId);
    this.store.touch();
    this.bus.emitEvent({ type: "threads-changed", accountId, threadIds: threads.map((t) => t.thread_id) });
    return { deleted, failed };
  }

  /** Threads the classifier hasn't seen yet (never spam, trash or draft-only), newest first. */
  unclassifiedThreads(accountIdIn?: string): string[] {
    const accountId = this.acct(accountIdIn);
    return this.db
      .all<{ id: string }>(
        `SELECT id FROM threads WHERE account_id = ? AND ai_labels_json IS NULL
         AND NOT EXISTS (SELECT 1 FROM json_each(threads.label_ids) WHERE value IN ('SPAM', 'TRASH'))
         AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id = threads.account_id AND m.thread_id = threads.id AND m.is_draft = 0) ORDER BY last_date DESC`,
        accountId,
      )
      .map((r) => r.id);
  }

  private labelIdOf(accountId: string, name: string): string | null {
    return this.store.labelByName(accountId, name)?.id ?? null;
  }

  // ---------------------------------------------------------------- splits

  ensureDefaultSplits(accountId: string): void {
    const have = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM splits WHERE account_id = ?", accountId)?.n ?? 0;
    if (have) return;
    const defaults: Omit<Split, "id" | "accountId">[] = [
      { name: "Important", query: "is:important", position: 0, leaveInImportantOther: false, builtin: "important", enabled: true },
      { name: "Calendar", query: "filename:ics OR subject:invitation OR subject:\"updated invitation\"", position: 1, leaveInImportantOther: false, builtin: null, enabled: false },
      { name: "News", query: "list:* OR category:promotions", position: 2, leaveInImportantOther: false, builtin: null, enabled: false },
      { name: "Other", query: "", position: 9, leaveInImportantOther: false, builtin: "other", enabled: true },
    ];
    for (const s of defaults) this.createSplit(accountId, s);
  }

  splits(accountId: string): Split[] {
    return this.db
      .all<{ id: string; account_id: string; name: string; query: string; position: number; leave_in_io: number; builtin: string | null; enabled: number }>(
        "SELECT * FROM splits WHERE account_id = ? ORDER BY position, name",
        accountId,
      )
      .map((r) => ({
        id: r.id,
        accountId: r.account_id,
        name: r.name,
        query: r.query,
        position: r.position,
        leaveInImportantOther: !!r.leave_in_io,
        builtin: (r.builtin as Split["builtin"]) ?? null,
        enabled: !!r.enabled,
      }));
  }

  createSplit(accountId: string, s: Partial<Omit<Split, "id" | "accountId">> & { name: string; query: string }): Split {
    const id = uid("sp_");
    const pos = s.position ?? (this.db.get<{ p: number }>("SELECT COALESCE(MAX(position), 0) AS p FROM splits WHERE account_id = ? AND builtin IS NOT 'other'", accountId)?.p ?? 0) + 1;
    this.db.run(
      "INSERT INTO splits (id, account_id, name, query, position, leave_in_io, builtin, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      accountId,
      s.name,
      s.query,
      pos,
      +(s.leaveInImportantOther ?? false),
      s.builtin ?? null,
      +(s.enabled ?? true),
    );
    this.store.touch();
    return this.splits(accountId).find((x) => x.id === id)!;
  }

  updateSplit(accountId: string, id: string, patch: Partial<Pick<Split, "name" | "query" | "position" | "leaveInImportantOther" | "enabled">>): Split | undefined {
    const cur = this.splits(accountId).find((s) => s.id === id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    this.db.run(
      "UPDATE splits SET name = ?, query = ?, position = ?, leave_in_io = ?, enabled = ? WHERE id = ? AND account_id = ?",
      n.name,
      n.query,
      n.position,
      +n.leaveInImportantOther,
      +n.enabled,
      id,
      accountId,
    );
    this.store.touch();
    this.bus.emitEvent({ type: "threads-changed", accountId });
    return this.splits(accountId).find((s) => s.id === id);
  }

  deleteSplit(accountId: string, id: string): void {
    this.db.run("DELETE FROM splits WHERE id = ? AND account_id = ? AND builtin IS NULL", id, accountId);
    this.store.touch();
    this.bus.emitEvent({ type: "threads-changed", accountId });
  }

  // ---------------------------------------------------------------- query evaluation

  private labelNameMap(accountId: string): Map<string, string> {
    return new Map(this.store.labels(accountId).map((l) => [l.id, l.name.toLowerCase()]));
  }

  /**
   * Query targets for a batch of threads. Cheap fields come from the thread rows; sender/recipient text and the body
   * come from the FTS index and are loaded lazily: one bulk scan the first time any thread needs them, then each body
   * by rowid. A split like `is:important` or `list:*` never touches FTS. Targets are only valid during this call.
   * `listId` carries the `@@any@@` marker for `list:*` (see compileQuery).
   */
  private targets(accountId: string, threads: ThreadSummary[]): Map<string, QueryTarget> {
    const names = this.labelNameMap(accountId);
    const mutedId = this.labelIdOf(accountId, IRIS_LABELS.muted);
    const snoozed = new Set(
      this.db
        .all<{ thread_id: string }>("SELECT thread_id FROM reminders WHERE account_id = ? AND status = 'pending'", accountId)
        .map((r) => r.thread_id),
    );
    const store = this.store;
    let heads: Map<string, { rowid: number; from: string; to: string }> | undefined;
    const head = (id: string) => (heads ??= store.ftsHeads(accountId)).get(id);
    const out = new Map<string, QueryTarget>();
    for (const t of threads) {
      let from: string | undefined;
      let to: string | undefined;
      let body: string | undefined;
      const loadBody = (): string => {
        if (body === undefined) {
          const f = head(t.id);
          body = ((f ? store.ftsBody(f.rowid) : undefined) ?? t.snippet).toLowerCase();
        }
        return body;
      };
      out.set(t.id, {
        subject: t.subject.toLowerCase(),
        get from() {
          return (from ??= (head(t.id)?.from ?? t.participants.map((p) => `${p.name} ${p.email}`).join(" ")).toLowerCase());
        },
        get to() {
          return (to ??= (head(t.id)?.to ?? "").toLowerCase());
        },
        get body() {
          return loadBody();
        },
        get attachments() {
          return t.hasAttachments ? loadBody() : "";
        },
        labelIds: t.labelIds,
        labelNames: [...t.labelIds.map((l) => names.get(l) ?? l.toLowerCase()), ...(t.aiLabels ?? []).map((l) => `ai/${l.toLowerCase()}`)],
        listId: t.listId ? `${t.listId.toLowerCase()} @@any@@` : "",
        lastDate: t.lastDate,
        unread: t.unread,
        starred: t.starred,
        important: t.important,
        snoozed: snoozed.has(t.id),
        muted: !!mutedId && t.labelIds.includes(mutedId),
      });
    }
    return out;
  }

  /** Parse once; null = empty query (matches everything). `list:*` means "any mailing list" (targets carry `@@any@@`). */
  private compileQuery(q: string): QNode | null {
    const node = parseQuery(q.replace(/list:\*/g, "list:@@any@@"));
    return isEmptyQuery(node) ? null : node;
  }

  private sortKey(t: ThreadSummary): number {
    return Math.max(t.lastDate, t.returnedAt ?? 0);
  }

  /** Changes whenever this process wrote thread-related state (store.version) or another connection wrote the DB. */
  private stateKey(): string {
    const dv = this.db.get<{ data_version: number }>("PRAGMA data_version")?.data_version ?? 0;
    return `${this.store.version}:${dv}`;
  }

  /** Memoized sorted inbox (rebuilt after any thread/label/reminder/split change). */
  private inboxState(accountId: string): InboxMemo {
    const key = this.stateKey();
    let m = this.inboxMemo.get(accountId);
    if (!m || m.key !== key) {
      const threads = this.store
        .threadsWhere("account_id = ? AND in_inbox = 1", [accountId], 100_000)
        .sort((a, b) => this.sortKey(b) - this.sortKey(a));
      m = { key, threads };
      this.inboxMemo.set(accountId, m);
    }
    return m;
  }

  inboxThreads(accountId: string): ThreadSummary[] {
    return [...this.inboxState(accountId).threads];
  }

  /** Assign each inbox thread to split ids (first matching custom split; then Important/Other). Memoized per state. */
  private splitAssignment(accountId: string): Map<string, string[]> {
    const memo = this.inboxState(accountId);
    const splits = this.splits(accountId).filter((s) => s.enabled);
    const custom = splits
      .filter((s) => !s.builtin)
      .map((s) => ({ s, node: s.query ? this.compileQuery(s.query) : undefined }));
    const important = splits.find((s) => s.builtin === "important");
    const other = splits.find((s) => s.builtin === "other");
    const importantNode = important?.query ? this.compileQuery(important.query) : undefined;
    // relative-time operators (newer_than:/older_than:) change with the clock: re-evaluate at most once a minute
    const timed = [...custom.map((c) => c.node), importantNode].some((n) => !!n && usesRelativeTime(n));
    const key = `${memo.key}|${timed ? Math.floor(Date.now() / 60_000) : ""}`;
    if (memo.assign?.key === key) return memo.assign.map;
    const threads = memo.threads;
    const targets = this.targets(accountId, threads);
    const out = new Map<string, string[]>();
    for (const s of splits) out.set(s.id, []);
    for (const t of threads) {
      const tg = targets.get(t.id)!;
      let claimed = false;
      for (const { s, node } of custom) {
        // `node === undefined`: no query → never matches; `null`: query parsed to nothing → matches everything
        if (node !== undefined && (node === null || evaluate(node, tg))) {
          out.get(s.id)!.push(t.id);
          if (!s.leaveInImportantOther) claimed = true;
          break;
        }
      }
      if (claimed) continue;
      const isImportant = important ? (importantNode !== undefined ? importantNode === null || evaluate(importantNode, tg) : t.important) : false;
      if (important && isImportant) out.get(important.id)!.push(t.id);
      else if (other) out.get(other.id)!.push(t.id);
      else if (important) out.get(important.id)!.push(t.id);
    }
    memo.assign = { key, map: out };
    return out;
  }

  /**
   * Enabled splits with counts. `all`: the built-in Important / Other of every account folded into
   * `builtin:important` / `builtin:other` (counts summed), plus every account's custom splits (with their accountId).
   */
  splitsWithCounts(accountIdIn?: string): SplitWithCount[] {
    if (!isAllAccounts(accountIdIn)) return this.accountSplitsWithCounts(this.acct(accountIdIn));
    const per = this.accountIds(accountIdIn).flatMap((a) => this.accountSplitsWithCounts(a));
    const unified = (kind: "important" | "other"): SplitWithCount[] => {
      const parts = per.filter((s) => s.builtin === kind);
      if (!parts.length) return [];
      return [
        {
          id: BUILTIN_SPLITS[kind],
          accountId: ALL_ACCOUNTS,
          name: parts[0].name,
          query: "",
          position: parts[0].position,
          leaveInImportantOther: false,
          builtin: kind,
          enabled: true,
          count: parts.reduce((n, s) => n + s.count, 0),
          unread: parts.reduce((n, s) => n + s.unread, 0),
        },
      ];
    };
    // same order as one account: Important, custom splits (account order, then position), Other
    return [...unified("important"), ...per.filter((s) => !s.builtin), ...unified("other")];
  }

  private accountSplitsWithCounts(accountId: string): SplitWithCount[] {
    const threads = this.inboxState(accountId).threads;
    const assign = this.splitAssignment(accountId);
    const byId = new Map(threads.map((t) => [t.id, t]));
    return this.splits(accountId)
      .filter((s) => s.enabled)
      .map((s) => {
        const ids = assign.get(s.id) ?? [];
        return { ...s, count: ids.length, unread: ids.filter((id) => byId.get(id)?.unread).length };
      });
  }

  /** Thread ids of a split in one account. `builtin:important|other` = that account's built-in split. */
  private splitThreadIds(accountId: string, splitId: string): string[] {
    const kind = builtinSplitKind(splitId);
    const id = kind ? this.splits(accountId).find((s) => s.enabled && s.builtin === kind)?.id : splitId;
    return id ? (this.splitAssignment(accountId).get(id) ?? []) : [];
  }

  // ---------------------------------------------------------------- list views

  /** A thread stays visible while at least one of its AI labels is shown. */
  private labelFiltered(threads: ThreadSummary[], q: ListQuery): ThreadSummary[] {
    if (!q.hideLabels?.length && !q.hideUnlabeled) return threads;
    const hidden = new Set(q.hideLabels);
    return threads.filter((t) => (t.aiLabels?.length ? t.aiLabels.some((l) => !hidden.has(l)) : !q.hideUnlabeled));
  }

  /** The whole mailbox per AI label, for the checkboxes in All Mail. Categories first, in their order. */
  mailboxLabels(accountIdIn?: string): { labels: { name: string; count: number }[]; unlabeled: number; total: number } {
    const counts = new Map<string, number>(this.settings.ai.autoLabelCategories.map((c) => [c, 0]));
    let unlabeled = 0;
    let total = 0;
    for (const accountId of this.accountIds(accountIdIn)) {
      for (const t of this.viewThreads(accountId, { view: "all" })) {
        total++;
        if (!t.aiLabels?.length) unlabeled++;
        for (const l of t.aiLabels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
      }
    }
    return { labels: [...counts].map(([name, count]) => ({ name, count })), unlabeled, total };
  }

  /** Start loading the rest of the mailbox in the background (survives a restart, see start()). */
  loadWholeMailbox(accountIdIn?: string): void {
    for (const accountId of this.accountIds(accountIdIn)) {
      void inBackground(() => this.sync.backfill(accountId)).catch((e) => this.reportError("backfill", e));
    }
  }

  /** How much of each Gmail account is in the local cache. */
  async mailboxCoverage(accountIdIn?: string): Promise<{ accountId: string; local: number; gmail: number | null; backfill: "idle" | "running" | "done"; left: number }[]> {
    return Promise.all(
      this.accountIds(accountIdIn).map(async (accountId) => ({
        accountId,
        local: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE account_id = ?", accountId)?.n ?? 0,
        gmail: (await this.provider(accountId).profile().catch(() => null))?.threadsTotal ?? null,
        backfill: this.sync.backfillLeft.has(accountId) ? ("running" as const) : this.db.kvGet(`backfill:${accountId}`) === "done" ? ("done" as const) : ("idle" as const),
        left: this.sync.backfillLeft.get(accountId) ?? 0,
      })),
    );
  }

  /**
   * One view as a page of threads. `accountId: "all"` merges every account (each thread keeps its accountId) in the
   * view's own order, then applies offset/limit; a custom split id implies its account.
   */
  list(q: ListQuery): ListResult {
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    if (!isAllAccounts(q.accountId)) {
      const accountId = this.acct(q.accountId);
      const threads = this.labelFiltered(this.viewThreads(accountId, q), q);
      return { threads: this.decorate(threads.slice(offset, offset + limit)), total: threads.length };
    }
    let accounts = this.accountIds(q.accountId);
    if (q.splitId && (q.view === "inbox" || q.view === "split") && !builtinSplitKind(q.splitId)) {
      const owner = this.db.get<{ account_id: string }>("SELECT account_id FROM splits WHERE id = ?", q.splitId)?.account_id;
      accounts = owner ? [owner] : [];
    }
    const per = accounts.map((a) => this.viewThreads(a, q));
    const threads = this.labelFiltered(per.length === 1 ? per[0] : this.mergeView(q.view, per), q);
    return { threads: this.decorate(threads.slice(offset, offset + limit)), total: threads.length };
  }

  /** Merge per-account lists of one view in that view's order (stable: ties keep connection order). */
  private mergeView(view: ListQuery["view"], per: ThreadSummary[][]): ThreadSummary[] {
    const all = per.flat();
    if (view === "reminders") {
      const at = new Map(
        this.db
          .all<{ account_id: string; thread_id: string; remind_at: number }>("SELECT account_id, thread_id, remind_at FROM reminders WHERE status = 'pending'")
          .map((r) => [`${r.account_id}\n${r.thread_id}`, r.remind_at]),
      );
      const key = (t: ThreadSummary) => at.get(`${t.accountId}\n${t.id}`) ?? Infinity;
      return all.sort((a, b) => key(a) - key(b));
    }
    if (view === "inbox" || view === "split") return all.sort((a, b) => this.sortKey(b) - this.sortKey(a));
    return all.sort((a, b) => b.lastDate - a.lastDate);
  }

  /** Every thread of one view in one account (filtered, in the view's order, not paged). */
  private viewThreads(accountId: string, q: ListQuery): ThreadSummary[] {
    let threads: ThreadSummary[];
    const label = (id: string) => `EXISTS (SELECT 1 FROM json_each(threads.label_ids) WHERE value = '${id.replace(/'/g, "''")}')`;
    const notSpamTrash = `NOT ${label("SPAM")} AND NOT ${label("TRASH")}`;
    switch (q.view) {
      case "inbox":
      case "split": {
        threads = this.inboxState(accountId).threads;
        if (q.splitId) {
          const ids = new Set(this.splitThreadIds(accountId, q.splitId));
          threads = threads.filter((t) => ids.has(t.id));
        }
        break;
      }
      case "starred":
        threads = this.store.threadsWhere(`account_id = ? AND starred = 1 AND ${notSpamTrash}`, [accountId], 5000);
        break;
      case "drafts":
        threads = this.store.threadsWhere("account_id = ? AND has_draft = 1", [accountId], 5000);
        break;
      case "sent":
        threads = this.store.threadsWhere(`account_id = ? AND ${label("SENT")} AND NOT ${label("TRASH")}`, [accountId], 5000);
        break;
      case "done":
        threads = this.store.threadsWhere(`account_id = ? AND in_inbox = 0 AND ${notSpamTrash} AND (has_draft = 0 OR message_count > 1)`, [accountId], 5000);
        break;
      case "all":
        threads = this.store.threadsWhere(`account_id = ? AND ${notSpamTrash}`, [accountId], 100_000);
        break;
      case "spam":
        threads = this.store.threadsWhere(`account_id = ? AND ${label("SPAM")}`, [accountId], 5000);
        break;
      case "trash":
        threads = this.store.threadsWhere(`account_id = ? AND ${label("TRASH")}`, [accountId], 5000);
        break;
      case "muted": {
        const id = this.labelIdOf(accountId, IRIS_LABELS.muted);
        threads = id ? this.store.threadsWhere(`account_id = ? AND ${label(id)}`, [accountId], 5000) : [];
        break;
      }
      case "label":
        threads = q.labelId ? this.store.threadsWhere(`account_id = ? AND ${label(q.labelId)}`, [accountId], 5000) : [];
        break;
      case "reminders": {
        const ids = this.db
          .all<{ thread_id: string }>("SELECT thread_id FROM reminders WHERE account_id = ? AND status = 'pending' ORDER BY remind_at", accountId)
          .map((r) => r.thread_id);
        const byId = new Map(this.store.threadsByIds(accountId, ids).map((t) => [t.id, t]));
        threads = ids.map((id) => byId.get(id)).filter((t): t is ThreadSummary => !!t);
        break;
      }
      case "scheduled": {
        const ids = this.outbox(accountId)
          .filter((o) => o.status === "queued" && o.draft.threadId)
          .map((o) => o.draft.threadId!);
        threads = this.store.threadsByIds(accountId, ids);
        break;
      }
      case "search":
        threads = this.searchLocal(accountId, q.q ?? "", 500);
        break;
      default:
        threads = [];
    }
    if (q.filter === "unread") threads = threads.filter((t) => t.unread);
    else if (q.filter === "starred") threads = threads.filter((t) => t.starred);
    else if (q.filter === "important") threads = threads.filter((t) => t.important);
    if (q.q && q.view !== "search") {
      const node = this.compileQuery(q.q);
      if (node) {
        const tg = this.targets(accountId, threads);
        threads = threads.filter((t) => evaluate(node, tg.get(t.id)!));
      }
    }
    return threads;
  }

  /** Attach pending reminders (threads may come from several accounts). */
  private decorate(threads: ThreadSummary[]): ThreadSummary[] {
    if (!threads.length) return threads;
    const accounts = [...new Set(threads.map((t) => t.accountId))];
    const rem = new Map(
      this.db
        .all<{ id: string; account_id: string; thread_id: string; remind_at: number; if_no_reply: number; status: string; note: string }>(
          `SELECT * FROM reminders WHERE status = 'pending' AND account_id IN (${accounts.map(() => "?").join(",")})`,
          ...accounts,
        )
        .map((r) => [
          `${r.account_id}\n${r.thread_id}`,
          { id: r.id, threadId: r.thread_id, remindAt: r.remind_at, ifNoReply: !!r.if_no_reply, status: "pending", note: r.note } as ReminderInfo,
        ]),
    );
    return threads.map((t) => ({ ...t, reminder: rem.get(`${t.accountId}\n${t.id}`) ?? null }));
  }

  // ---------------------------------------------------------------- search

  searchLocal(accountId: string, q: string, limit = 200): ThreadSummary[] {
    const node = this.compileQuery(q);
    if (!node) return [];
    const terms = positiveTerms(node);
    const wantsSpamTrash = /\bin:(spam|trash|anywhere)\b/.test(q);
    let candidates: ThreadSummary[];
    if (terms.length) {
      const ids = this.store.ftsThreadIds(accountId, ftsExpression(terms), 3000);
      candidates = this.store.threadsByIds(accountId, ids);
    } else {
      candidates = this.store.threadsWhere("account_id = ?", [accountId], 5000);
    }
    if (!wantsSpamTrash) candidates = candidates.filter((t) => !t.labelIds.includes("SPAM") && !t.labelIds.includes("TRASH"));
    const tg = this.targets(accountId, candidates);
    // FTS already matched the free-text terms (with stemming); only evaluate operators strictly.
    const opsOnly = stripText(node);
    return candidates
      .filter((t) => !opsOnly || evaluate(opsOnly, tg.get(t.id)!))
      .sort((a, b) => b.lastDate - a.lastDate)
      .slice(0, limit);
  }

  /**
   * Local results immediately; then asks Gmail for matches we have not cached yet.
   * `all`: every account in parallel (remote search per account), merged by date.
   */
  async search(accountIdIn: string | undefined, q: string, opts: { remote?: boolean; limit?: number } = {}): Promise<ThreadSummary[]> {
    if (isAllAccounts(accountIdIn)) {
      const per = await Promise.all(this.accountIds(accountIdIn).map((a) => this.search(a, q, opts)));
      return per.flat().sort((a, b) => b.lastDate - a.lastDate).slice(0, opts.limit ?? 100);
    }
    const accountId = this.acct(accountIdIn);
    const local = this.searchLocal(accountId, q, opts.limit ?? 100);
    if (opts.remote === false) return this.decorate(local);
    try {
      const r = await this.provider(accountId).listThreadIds({ q, maxResults: Math.min(opts.limit ?? 50, 100) });
      const have = new Set(this.store.threadsByIds(accountId, r.ids).map((t) => t.id));
      const missing = r.ids.filter((id) => !have.has(id));
      if (missing.length) await this.sync.fetchAndSave(accountId, this.provider(accountId), missing, false);
      const merged = new Map(local.map((t) => [t.id, t]));
      for (const t of this.store.threadsByIds(accountId, r.ids)) merged.set(t.id, t);
      return this.decorate([...merged.values()].sort((a, b) => b.lastDate - a.lastDate).slice(0, opts.limit ?? 100));
    } catch (e) {
      this.reportError("search", e);
      return this.decorate(local);
    }
  }

  // ---------------------------------------------------------------- threads

  /** Fetch full bodies for a thread that was synced as metadata only. Cheap no-op when already loaded. */
  async ensureBodies(accountIdIn: string | undefined, threadId: string): Promise<void> {
    const accountId = this.acct(accountIdIn);
    const missing = this.store.messages(accountId, threadId).some((m) => m.bodyLoaded === false);
    if (missing) await this.sync.fetchAndSave(accountId, this.provider(accountId), [threadId], false, undefined, "full");
  }

  async thread(accountIdIn: string | undefined, threadId: string): Promise<Thread | null> {
    const accountId = this.acct(accountIdIn);
    await this.ensureBodies(accountId, threadId).catch((e) => this.reportError("thread", e));
    let s = this.store.thread(accountId, threadId);
    if (!s) {
      await this.sync.refreshThread(accountId, threadId);
      s = this.store.thread(accountId, threadId);
      if (!s) return null;
    }
    const [decorated] = this.decorate([s]);
    const messages = this.store.messages(accountId, threadId);
    const invite = await this.calendar.inviteFor(accountId, messages).catch(() => undefined);
    return { ...decorated, messages, ...(invite ? { invite } : {}) };
  }

  async attachment(accountIdIn: string | undefined, messageId: string, attachmentId: string) {
    const accountId = this.acct(accountIdIn);
    const known = this.store.message(accountId, messageId);
    if (known?.bodyLoaded === false) await this.ensureBodies(accountId, known.threadId);
    const m = this.store.message(accountId, messageId);
    if (!m) throw new Error(`Unknown message: ${messageId}`);
    const meta = m.attachments.find((a) => a.id === attachmentId || a.contentId === attachmentId || a.contentId === `<${attachmentId}>`);
    if (!meta) throw new Error(`Unknown attachment: ${attachmentId}`);
    const data = await this.provider(accountId).getAttachment(messageId, meta.id);
    return { data, filename: meta.filename || "attachment", mimeType: meta.mimeType || "application/octet-stream" };
  }

  async rawMessage(accountIdIn: string | undefined, messageId: string): Promise<string> {
    const accountId = this.acct(accountIdIn);
    return (await this.provider(accountId).getRawMessage(messageId)).toString("utf8");
  }

  // ---------------------------------------------------------------- mutations (optimistic + queued)

  private enqueue(accountId: string, fn: () => Promise<void>, threadIds: string[]): void {
    const prev = this.queues.get(accountId) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch(async (e) => {
        this.reportError("action", e);
        for (const id of threadIds) await this.sync.refreshThread(accountId, id).catch(() => undefined);
      });
    this.queues.set(accountId, next);
  }

  /** Wait until queued provider mutations have been flushed (used by CLI/tests). */
  async flush(accountId?: string): Promise<void> {
    if (accountId) await this.queues.get(accountId);
    else await Promise.all(this.queues.values());
  }

  private applyOps(accountId: string, ops: LabelOp[]): void {
    const mine = this.sync.myEmails(accountId);
    const changed: string[] = [];
    for (const op of ops) {
      if (this.store.applyLabelsLocal(accountId, op.threadId, op.add, op.remove, mine)) changed.push(op.threadId);
    }
    this.bus.emitEvent({ type: "threads-changed", accountId, threadIds: changed });
    const p = this.provider(accountId);
    for (const op of ops) {
      if (!op.add.length && !op.remove.length) continue;
      this.enqueue(accountId, () => p.modifyThread(op.threadId, op.add, op.remove), [op.threadId]);
    }
  }

  private pushUndo(description: string, ...parts: UndoPart[]): UndoEntry {
    const entry: UndoEntry = { id: uid("u_"), description, parts, createdAt: Date.now() };
    this.undoStack.push(entry);
    if (this.undoStack.length > 50) this.undoStack.shift();
    return entry;
  }

  /** Fold undo entries (e.g. one per account) into ONE entry, so a single undo restores all of them. */
  mergeUndo(undoIds: string[], description: string): string | undefined {
    const parts: UndoPart[] = [];
    for (const id of undoIds) {
      const i = this.undoStack.findIndex((u) => u.id === id);
      if (i >= 0) parts.push(...this.undoStack.splice(i, 1)[0].parts);
    }
    return parts.length ? this.pushUndo(description, ...parts).id : undefined;
  }

  // ---------------------------------------------------------------- cross-account actions (refs)

  /** Group thread refs by account (canonical ids; first-seen order; duplicates dropped). No account = first account. */
  groupRefs(refs: ThreadRef[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of refs) {
      if (!r || typeof r.threadId !== "string" || !r.threadId) throw new Error("Every ref needs a threadId");
      const accountId = this.acct(r.account ?? r.accountId);
      const list = out.get(accountId) ?? [];
      if (!list.includes(r.threadId)) list.push(r.threadId);
      out.set(accountId, list);
    }
    return out;
  }

  /** Toggle decisions over threads of several accounts (same rule as toggleStar / toggleRead in one account). */
  allStarred(groups: Map<string, string[]>): boolean {
    return [...groups].every(([a, ids]) => ids.every((id) => this.store.thread(a, id)?.starred));
  }

  anyUnread(groups: Map<string, string[]>): boolean {
    return [...groups].some(([a, ids]) => ids.some((id) => this.store.thread(a, id)?.unread));
  }

  /**
   * Run a per-account action for each account of `groups`; the per-account undo entries become ONE entry
   * (`undo` restores every account). Returns `{ ok, count, undoId, description }` over all accounts.
   */
  async forGroups<R extends Partial<ActionResult>>(
    groups: Map<string, string[]>,
    fn: (accountId: string, threadIds: string[]) => R | Promise<R>,
  ): Promise<ActionResult & { accounts: string[] }> {
    const results: R[] = [];
    const combine = () => {
      const count = results.reduce((n, r) => n + (r?.count ?? 0), 0);
      const description = combineDescriptions(results.map((r) => r?.description).filter((d): d is string => !!d), count);
      const ids = results.map((r) => r?.undoId).filter((id): id is string => !!id);
      const undoId = ids.length > 1 ? this.mergeUndo(ids, description ?? "Undo") : ids[0];
      return { ok: true, count, ...(undoId ? { undoId } : {}), ...(description ? { description } : {}), accounts: [...groups.keys()] };
    };
    try {
      for (const [accountId, threadIds] of groups) results.push(await fn(accountId, threadIds));
    } catch (e) {
      combine(); // keep what already happened undoable as one step
      throw e;
    }
    return combine();
  }

  /** Remind me for threads of several accounts: one time, one undo entry. */
  async remindRefs(refs: ThreadRef[], when: number | string, opts: { ifNoReply?: boolean; note?: string } = {}) {
    const at = typeof when === "number" ? when : this.parseWhen(when);
    if (!at || at <= Date.now()) throw new Error(`Could not understand time: ${when}`);
    const reminderIds: string[] = [];
    const r = await this.forGroups(this.groupRefs(refs), async (a, t) => {
      const x = await this.remind(a, t, at, opts);
      reminderIds.push(...x.reminderIds);
      return x;
    });
    return { ...r, remindAt: at, when: describeWhen(at), reminderIds };
  }

  private labelChange(accountIdIn: string | undefined, threadIds: string[], add: string[], remove: string[], description: string) {
    const accountId = this.acct(accountIdIn);
    const ops: LabelOp[] = [];
    const inverse: LabelOp[] = [];
    for (const id of threadIds) {
      const t = this.store.thread(accountId, id);
      if (!t) continue;
      const realAdd = add.filter((l) => !t.labelIds.includes(l) || l === "UNREAD");
      const realRemove = remove.filter((l) => t.labelIds.includes(l));
      ops.push({ threadId: id, add: realAdd, remove: realRemove });
      inverse.push({ threadId: id, add: realRemove, remove: realAdd.filter((l) => !t.labelIds.includes(l)) });
    }
    this.applyOps(accountId, ops);
    const u = this.pushUndo(description, { accountId, ops: inverse });
    return { ok: true, count: ops.length, undoId: u.id, description };
  }

  markDone(accountId: string | undefined, threadIds: string[]) {
    const r = this.labelChange(accountId, threadIds, [], ["INBOX"], threadIds.length > 1 ? `Marked ${threadIds.length} done` : "Marked done");
    for (const id of threadIds) this.store.setReturned(this.acct(accountId), id, null);
    return r;
  }

  markNotDone(accountId: string | undefined, threadIds: string[]) {
    return this.labelChange(accountId, threadIds, ["INBOX"], [], "Moved to inbox");
  }

  star(accountId: string | undefined, threadIds: string[], on = true) {
    return on ? this.labelChange(accountId, threadIds, ["STARRED"], [], "Starred") : this.labelChange(accountId, threadIds, [], ["STARRED"], "Unstarred");
  }

  toggleStar(accountIdIn: string | undefined, threadIds: string[]) {
    const accountId = this.acct(accountIdIn);
    const allStarred = threadIds.every((id) => this.store.thread(accountId, id)?.starred);
    return this.star(accountId, threadIds, !allStarred);
  }

  markRead(accountId: string | undefined, threadIds: string[], read = true) {
    return read ? this.labelChange(accountId, threadIds, [], ["UNREAD"], "Marked read") : this.markUnread(accountId, threadIds);
  }

  /** Marks the latest message unread, not the whole thread. */
  markUnread(accountIdIn: string | undefined, threadIds: string[]) {
    const accountId = this.acct(accountIdIn);
    const mine = this.sync.myEmails(accountId);
    const inverse: LabelOp[] = [];
    const p = this.provider(accountId);
    for (const id of threadIds) {
      const msgs = this.store.messages(accountId, id).filter((m) => !m.isDraft);
      const last = msgs[msgs.length - 1];
      if (!last) continue;
      last.labelIds = [...new Set([...last.labelIds, "UNREAD"])];
      this.store.saveThread(accountId, id, this.store.messages(accountId, id).map((m) => (m.id === last.id ? last : m)), mine);
      inverse.push({ threadId: id, add: [], remove: ["UNREAD"] });
      this.enqueue(accountId, () => p.modifyMessages([last.id], ["UNREAD"], []), [id]);
    }
    this.bus.emitEvent({ type: "threads-changed", accountId, threadIds });
    const u = this.pushUndo("Marked unread", { accountId, ops: inverse });
    return { ok: true, count: inverse.length, undoId: u.id, description: "Marked unread" };
  }

  toggleRead(accountIdIn: string | undefined, threadIds: string[]) {
    const accountId = this.acct(accountIdIn);
    const anyUnread = threadIds.some((id) => this.store.thread(accountId, id)?.unread);
    return anyUnread ? this.markRead(accountId, threadIds, true) : this.markUnread(accountId, threadIds);
  }

  markImportant(accountId: string | undefined, threadIds: string[], important = true) {
    return important
      ? this.labelChange(accountId, threadIds, ["IMPORTANT"], [], "Moved to Important")
      : this.labelChange(accountId, threadIds, [], ["IMPORTANT"], "Moved to Other");
  }

  spam(accountId: string | undefined, threadIds: string[], on = true) {
    return on
      ? this.labelChange(accountId, threadIds, ["SPAM"], ["INBOX"], "Marked as spam")
      : this.labelChange(accountId, threadIds, ["INBOX"], ["SPAM"], "Not spam");
  }

  trash(accountIdIn: string | undefined, threadIds: string[]) {
    const accountId = this.acct(accountIdIn);
    const mine = this.sync.myEmails(accountId);
    const inverse: LabelOp[] = [];
    const p = this.provider(accountId);
    for (const id of threadIds) {
      const t = this.store.thread(accountId, id);
      if (!t) continue;
      inverse.push({ threadId: id, add: t.inInbox ? ["INBOX"] : [], remove: [] });
      this.store.applyLabelsLocal(accountId, id, ["TRASH"], ["INBOX"], mine);
      this.enqueue(accountId, () => p.trashThread(id), [id]);
    }
    this.bus.emitEvent({ type: "threads-changed", accountId, threadIds });
    const u = this.pushUndo("Moved to trash", { accountId, ops: inverse, trashed: threadIds });
    return { ok: true, count: inverse.length, undoId: u.id, description: "Moved to trash" };
  }

  untrash(accountIdIn: string | undefined, threadIds: string[]) {
    const accountId = this.acct(accountIdIn);
    const mine = this.sync.myEmails(accountId);
    const p = this.provider(accountId);
    for (const id of threadIds) {
      this.store.applyLabelsLocal(accountId, id, [], ["TRASH"], mine);
      this.enqueue(accountId, () => p.untrashThread(id), [id]);
    }
    this.bus.emitEvent({ type: "threads-changed", accountId, threadIds });
    return { ok: true, count: threadIds.length };
  }

  async addLabel(accountIdIn: string | undefined, threadIds: string[], label: string) {
    const accountId = this.acct(accountIdIn);
    const l = await this.ensureLabel(accountId, label);
    return this.labelChange(accountId, threadIds, [l.id], [], `Labeled ${l.name}`);
  }

  removeLabel(accountIdIn: string | undefined, threadIds: string[], label: string) {
    const accountId = this.acct(accountIdIn);
    const l = this.store.labelByName(accountId, label);
    if (!l) throw new Error(`Unknown label: ${label}`);
    return this.labelChange(accountId, threadIds, [], [l.id], `Removed ${l.name}`);
  }

  removeAllLabels(accountIdIn: string | undefined, threadIds: string[]) {
    const accountId = this.acct(accountIdIn);
    const user = new Set(this.store.labels(accountId).filter((l) => l.type === "user").map((l) => l.id));
    const remove = new Set<string>();
    for (const id of threadIds) for (const l of this.store.thread(accountId, id)?.labelIds ?? []) if (user.has(l)) remove.add(l);
    return this.labelChange(accountId, threadIds, [], [...remove], "Removed all labels");
  }

  /** Gmail "move": add label, leave the inbox. */
  async move(accountIdIn: string | undefined, threadIds: string[], label: string) {
    const accountId = this.acct(accountIdIn);
    if (label.toLowerCase() === "inbox") return this.markNotDone(accountId, threadIds);
    const l = await this.ensureLabel(accountId, label);
    return this.labelChange(accountId, threadIds, [l.id], ["INBOX"], `Moved to ${l.name}`);
  }

  async mute(accountIdIn: string | undefined, threadIds: string[], on = true) {
    const accountId = this.acct(accountIdIn);
    const l = await this.ensureLabel(accountId, IRIS_LABELS.muted);
    return on ? this.labelChange(accountId, threadIds, [l.id], ["INBOX"], "Muted") : this.labelChange(accountId, threadIds, ["INBOX"], [l.id], "Unmuted");
  }

  undo(undoId?: string): { ok: boolean; description?: string } {
    const idx = undoId ? this.undoStack.findIndex((u) => u.id === undoId) : this.undoStack.length - 1;
    if (idx < 0) return { ok: false };
    const [u] = this.undoStack.splice(idx, 1);
    for (const p of u.parts) {
      if (!this.store.account(p.accountId)) continue; // account removed meanwhile
      if (p.trashed?.length) this.untrash(p.accountId, p.trashed);
      if (p.reminders?.length) {
        for (const r of p.reminders) this.db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", r);
        this.store.touch();
      }
      this.applyOps(p.accountId, p.ops);
    }
    return { ok: true, description: `Undid: ${u.description}` };
  }

  /** "Get Me To Zero": mark done everything in the inbox older than `before`. */
  getMeToZero(accountIdIn: string | undefined, before: number) {
    const accountId = this.acct(accountIdIn);
    const ids = this.inboxThreads(accountId)
      .filter((t) => t.lastDate < before)
      .map((t) => t.id);
    return this.markDone(accountId, ids);
  }

  // ---------------------------------------------------------------- reminders

  reminderPresets() {
    return reminderPresets(new Date(), this.settings.defaultReminderHour);
  }

  parseWhen(input: string): number | null {
    return parseWhen(input, new Date(), this.settings.defaultReminderHour);
  }

  async remind(accountIdIn: string | undefined, threadIds: string[], when: number | string, opts: { ifNoReply?: boolean; note?: string } = {}) {
    const accountId = this.acct(accountIdIn);
    const at = typeof when === "number" ? when : this.parseWhen(when);
    if (!at || at <= Date.now()) throw new Error(`Could not understand time: ${when}`);
    const l = await this.ensureLabel(accountId, IRIS_LABELS.reminders);
    const ids: string[] = [];
    for (const threadId of threadIds) {
      const msgs = this.store.messages(accountId, threadId).filter((m) => !m.isDraft);
      this.db.run("UPDATE reminders SET status = 'cancelled' WHERE account_id = ? AND thread_id = ? AND status = 'pending'", accountId, threadId);
      const id = uid("rm_");
      this.db.run(
        "INSERT INTO reminders (id, account_id, thread_id, remind_at, if_no_reply, status, last_message_id, note, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        id,
        accountId,
        threadId,
        at,
        +(opts.ifNoReply ?? false),
        msgs[msgs.length - 1]?.id ?? null,
        opts.note ?? "",
        Date.now(),
      );
      ids.push(id);
    }
    this.store.touch();
    const r = this.labelChange(accountId, threadIds, [l.id], ["INBOX"], `Reminder set for ${describeWhen(at)}`);
    const entry = this.undoStack[this.undoStack.length - 1];
    if (entry?.id === r.undoId) entry.parts[0].reminders = ids;
    this.bus.emitEvent({ type: "reminder", accountId, threadIds });
    return { ...r, remindAt: at, when: describeWhen(at), reminderIds: ids };
  }

  cancelReminder(accountIdIn: string | undefined, threadIds: string[], moveToInbox = true) {
    const accountId = this.acct(accountIdIn);
    for (const id of threadIds)
      this.db.run("UPDATE reminders SET status = 'cancelled' WHERE account_id = ? AND thread_id = ? AND status = 'pending'", accountId, id);
    this.store.touch();
    const lid = this.labelIdOf(accountId, IRIS_LABELS.reminders);
    return this.labelChange(accountId, threadIds, moveToInbox ? ["INBOX"] : [], lid ? [lid] : [], "Reminder removed");
  }

  /** Pending reminders by due time (`all`: every account). */
  reminders(accountIdIn?: string): (ReminderInfo & { accountId: string; subject: string; when: string })[] {
    const accounts = this.accountIds(accountIdIn);
    if (!accounts.length) return [];
    return this.db
      .all<{ id: string; account_id: string; thread_id: string; remind_at: number; if_no_reply: number; status: string; note: string }>(
        `SELECT * FROM reminders WHERE status = 'pending' AND account_id IN (${accounts.map(() => "?").join(",")}) ORDER BY remind_at`,
        ...accounts,
      )
      .map((r) => ({
        id: r.id,
        accountId: r.account_id,
        threadId: r.thread_id,
        remindAt: r.remind_at,
        ifNoReply: !!r.if_no_reply,
        status: "pending" as const,
        note: r.note,
        subject: this.store.thread(r.account_id, r.thread_id)?.subject ?? "",
        when: describeWhen(r.remind_at),
      }));
  }

  async processReminders(): Promise<void> {
    const due = this.db.all<{ id: string; account_id: string; thread_id: string; if_no_reply: number }>(
      "SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ?",
      Date.now(),
    );
    for (const r of due) {
      this.db.run("UPDATE reminders SET status = 'returned' WHERE id = ?", r.id);
      this.store.touch();
      const lid = this.labelIdOf(r.account_id, IRIS_LABELS.reminders);
      const t = this.store.thread(r.account_id, r.thread_id);
      this.applyOps(r.account_id, [{ threadId: r.thread_id, add: ["INBOX", "UNREAD"], remove: lid ? [lid] : [] }]);
      this.store.setReturned(r.account_id, r.thread_id, Date.now());
      this.bus.emitEvent({
        type: "notification",
        accountId: r.account_id,
        threadIds: [r.thread_id],
        data: { title: r.if_no_reply ? "No reply yet" : "Reminder", body: t?.subject ?? "", kind: "reminder" },
      });
    }
  }

  private async handleNewMessages(accountId: string, msgs: Message[]): Promise<void> {
    const mine = this.sync.myEmails(accountId);
    const mutedId = this.labelIdOf(accountId, IRIS_LABELS.muted);
    const blocked = new Set(this.rules(accountId).filter((r) => r.kind === "block_sender").map((r) => r.value));
    const blockedDomains = new Set(this.rules(accountId).filter((r) => r.kind === "block_domain").map((r) => r.value));
    const notify: Message[] = [];
    for (const m of msgs) {
      const incoming = !mine.includes(m.from.email) && !m.isSent;
      if (!incoming) continue;
      const domain = m.from.email.split("@")[1] ?? "";
      if (blocked.has(m.from.email) || blockedDomains.has(domain)) {
        this.trash(accountId, [m.threadId]);
        continue;
      }
      // a reply cancels "remind me"
      const pending = this.db.get<{ id: string }>(
        "SELECT id FROM reminders WHERE account_id = ? AND thread_id = ? AND status = 'pending'",
        accountId,
        m.threadId,
      );
      if (pending) {
        this.db.run("UPDATE reminders SET status = 'replied', note = ? WHERE id = ?", `Removed as ${displayName(m.from)} replied`, pending.id);
        this.store.touch();
        const lid = this.labelIdOf(accountId, IRIS_LABELS.reminders);
        if (lid) this.applyOps(accountId, [{ threadId: m.threadId, add: [], remove: [lid] }]);
      }
      if (mutedId && m.labelIds.includes(mutedId)) {
        this.applyOps(accountId, [{ threadId: m.threadId, add: [], remove: ["INBOX"] }]);
        continue;
      }
      if (m.labelIds.includes("INBOX")) notify.push(m);
    }
    for (const m of notify.slice(-5)) {
      this.bus.emitEvent({
        type: "notification",
        accountId,
        threadIds: [m.threadId],
        data: { title: displayName(m.from), body: m.subject, kind: "mail", important: m.labelIds.includes("IMPORTANT") },
      });
    }
    if (this.settings.ai.autoLabels && notify.length && this.onAutoLabel) {
      await this.onAutoLabel(accountId, [...new Set(notify.map((m) => m.threadId))]).catch((e) => this.reportError("ai", e));
    }
  }

  /** set by the AI module */
  onAutoLabel: ((accountId: string, threadIds: string[]) => Promise<void>) | null = null;
  /** set by the AI module: meeting-start research prompt (every 30 s), returns the number of prompts sent */
  onMeetingResearch: ((now?: number) => number) | null = null;
  /** set by the AI module: mark research runs that a restart interrupted as failed */
  onResearchRecover: (() => number) | null = null;

  // ---------------------------------------------------------------- compose / drafts / outbox

  /** Build reply/forward defaults (reply-all excludes me, keeps cc). */
  replyDraft(accountIdIn: string | undefined, threadId: string, kind: "reply" | "replyAll" | "forward", messageId?: string): DraftInput {
    const accountId = this.acct(accountIdIn);
    const msgs = this.store.messages(accountId, threadId).filter((m) => !m.isDraft);
    const target = (messageId && msgs.find((m) => m.id === messageId)) || msgs[msgs.length - 1];
    if (!target) throw new Error("Thread has no messages");
    const me = this.myAddress(accountId).email;
    const fromMe = target.from.email === me;
    const dedupe = (list: Address[]) => {
      const seen = new Set<string>([me]);
      return list.filter((a) => a.email && !seen.has(a.email) && seen.add(a.email));
    };
    if (kind === "forward") {
      const quoted = `<br><br><div>---------- Forwarded message ---------<br>From: ${escapeHtml(formatAddress(target.from))}<br>Date: ${new Date(target.date).toUTCString()}<br>Subject: ${escapeHtml(target.subject)}<br>To: ${escapeHtml(target.to.map(formatAddress).join(", "))}<br><br>${target.bodyHtml}</div>`;
      return { accountId, to: [], subject: replySubject(target.subject, "forward"), html: quoted, threadId, inReplyToMessageId: target.id };
    }
    const base = fromMe ? target.to : target.replyTo.length ? target.replyTo : [target.from];
    const to = dedupe(base);
    const cc = kind === "replyAll" ? dedupe([...(fromMe ? [] : target.to), ...target.cc]).filter((a) => !to.some((t) => t.email === a.email)) : [];
    return { accountId, to, cc, subject: replySubject(target.subject, "reply"), html: "", threadId, inReplyToMessageId: target.id };
  }

  private replyContext(accountId: string, draft: DraftInput) {
    if (!draft.inReplyToMessageId) return null;
    const m = this.store.message(accountId, draft.inReplyToMessageId);
    return m ? { messageIdHeader: m.messageIdHeader, references: m.references } : null;
  }

  private withSignatureAndQuote(accountId: string, draft: DraftInput): DraftInput {
    const sig = this.store.account(accountId)?.signatureHtml;
    let html = draft.html ?? (draft.text ? `<div style="white-space:pre-wrap">${escapeHtml(draft.text)}</div>` : "");
    if (sig && !html.includes("data-iris-signature")) html += `<br><div data-iris-signature>${sig}</div>`;
    if (draft.inReplyToMessageId && !/forwarded message/i.test(html) && !html.includes("data-iris-quote")) {
      const m = this.store.message(accountId, draft.inReplyToMessageId);
      if (m) {
        const when = new Date(m.date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
        html += `<br><div class="gmail_quote" data-iris-quote><div>On ${when}, ${escapeHtml(formatAddress(m.from))} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${m.bodyHtml}</blockquote></div>`;
      }
    }
    return { ...draft, html, text: undefined };
  }

  validateDraft(draft: DraftInput): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const all = [...toAddresses(draft.to), ...toAddresses(draft.cc), ...toAddresses(draft.bcc)];
    if (!all.length) errors.push("No recipients");
    for (const a of all) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) errors.push(`Invalid address: ${a.email}`);
    const body = draft.text ?? htmlToText(draft.html ?? "");
    if (!draft.subject?.trim()) warnings.push("Empty subject");
    if (mentionsAttachment(body) && !draft.attachments?.length) warnings.push("You mention an attachment but none is attached");
    return { errors, warnings };
  }

  async saveDraft(draftIn: DraftInput): Promise<{ draftId: string; threadId: string; messageId: string }> {
    const accountId = this.acct(draftIn.accountId);
    const draft = { ...draftIn, accountId };
    if (draft.threadId) await this.ensureBodies(accountId, draft.threadId);
    const raw = await buildMime(this.withSignatureAndQuote(accountId, draft), this.myAddress(accountId), this.replyContext(accountId, draft));
    const p = this.provider(accountId);
    const d = draft.draftId ? await p.updateDraft(draft.draftId, raw, draft.threadId) : await p.createDraft(raw, draft.threadId);
    await this.sync.refreshThread(accountId, d.threadId);
    return d;
  }

  async deleteDraft(accountIdIn: string | undefined, draftId: string, threadId?: string): Promise<void> {
    const accountId = this.acct(accountIdIn);
    await this.provider(accountId).deleteDraft(draftId);
    if (threadId) await this.sync.refreshThread(accountId, threadId);
  }

  /** Gmail drafts (`all`: every account, newest first; an account that fails is reported and skipped). */
  async drafts(accountIdIn?: string) {
    const one = async (accountId: string) => {
      const list = await this.provider(accountId).listDrafts();
      return list.map((d) => {
        const m = this.store.message(accountId, d.messageId);
        return { ...d, accountId, subject: m?.subject ?? "", to: m?.to ?? [], snippet: m?.snippet ?? "", date: m?.date ?? 0 };
      });
    };
    if (!isAllAccounts(accountIdIn)) return one(this.acct(accountIdIn));
    const per = await settled(this.accountIds(accountIdIn).map(one), (e) => this.reportError("drafts", e));
    return per.flat().sort((a, b) => b.date - a.date);
  }

  /**
   * Queue a send. Default: undo window (settings.undoSendSeconds). `sendAt` = Send Later.
   * Returns the outbox item; cancel with cancelSend() while queued.
   */
  send(draftIn: DraftInput, opts: { sendAt?: number; markDone?: boolean; instant?: boolean } = {}): OutboxItem {
    const accountId = this.acct(draftIn.accountId);
    const draft = { ...draftIn, accountId };
    const v = this.validateDraft(draft);
    if (v.errors.length) throw new Error(v.errors.join("; "));
    const sendAt = opts.instant ? Date.now() : opts.sendAt ?? Date.now() + this.settings.undoSendSeconds * 1000;
    const id = uid("ob_");
    this.db.run(
      "INSERT INTO outbox (id, account_id, draft_json, send_at, status, mark_done_after, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
      id,
      accountId,
      JSON.stringify(draft),
      sendAt,
      +(opts.markDone ?? false),
      Date.now(),
    );
    if (opts.markDone && draft.threadId) this.markDone(accountId, [draft.threadId]);
    this.bus.emitEvent({ type: "outbox", accountId, data: { id, status: "queued", sendAt } });
    if (opts.instant) void this.processOutbox();
    return this.outboxItem(id)!;
  }

  outboxItem(id: string): OutboxItem | undefined {
    const r = this.db.get<{
      id: string;
      account_id: string;
      draft_json: string;
      send_at: number;
      status: OutboxItem["status"];
      error: string | null;
      sent_message_id: string | null;
      mark_done_after: number;
      created_at: number;
    }>("SELECT * FROM outbox WHERE id = ?", id);
    if (!r) return undefined;
    return {
      id: r.id,
      accountId: r.account_id,
      draft: JSON.parse(r.draft_json),
      sendAt: r.send_at,
      status: r.status,
      error: r.error,
      sentMessageId: r.sent_message_id,
      markDoneAfter: !!r.mark_done_after,
      createdAt: r.created_at,
    };
  }

  /** Queued, sending and failed sends by send time (`all`: every account). */
  outbox(accountIdIn?: string): OutboxItem[] {
    const accounts = this.accountIds(accountIdIn);
    if (!accounts.length) return [];
    return this.db
      .all<{ id: string }>(
        `SELECT id FROM outbox WHERE account_id IN (${accounts.map(() => "?").join(",")}) AND status IN ('queued','sending','failed') ORDER BY send_at`,
        ...accounts,
      )
      .map((r) => this.outboxItem(r.id)!)
      .filter(Boolean);
  }

  cancelSend(id: string): OutboxItem | undefined {
    const item = this.outboxItem(id);
    if (!item || item.status !== "queued") return item;
    this.db.run("UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'queued'", id);
    if (item.markDoneAfter && item.draft.threadId) this.markNotDone(item.accountId, [item.draft.threadId]);
    this.bus.emitEvent({ type: "outbox", accountId: item.accountId, data: { id, status: "cancelled" } });
    return this.outboxItem(id);
  }

  sendNow(id: string): OutboxItem | undefined {
    this.db.run("UPDATE outbox SET send_at = ? WHERE id = ? AND status = 'queued'", Date.now(), id);
    void this.processOutbox();
    return this.outboxItem(id);
  }

  reschedule(id: string, sendAt: number): OutboxItem | undefined {
    this.db.run("UPDATE outbox SET send_at = ? WHERE id = ? AND status = 'queued'", sendAt, id);
    return this.outboxItem(id);
  }

  private outboxRun: Promise<void> | null = null;
  /** Send everything that is due. Concurrent callers wait for the running pass, then run one more. */
  async processOutbox(): Promise<void> {
    if (this.outboxRun) await this.outboxRun.catch(() => undefined);
    if (this.outboxRun) return this.outboxRun;
    this.outboxRun = this.runOutbox().finally(() => (this.outboxRun = null));
    return this.outboxRun;
  }

  private async runOutbox(): Promise<void> {
    {
      const due = this.db.all<{ id: string }>("SELECT id FROM outbox WHERE status = 'queued' AND send_at <= ? ORDER BY send_at", Date.now());
      for (const { id } of due) {
        const claimed = this.db.raw.prepare("UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'queued'").run(id);
        if (!claimed.changes) continue;
        const item = this.outboxItem(id)!;
        try {
          if (item.draft.threadId) await this.ensureBodies(item.accountId, item.draft.threadId);
          const draft = this.withSignatureAndQuote(item.accountId, item.draft);
          const raw = await buildMime(draft, this.myAddress(item.accountId), this.replyContext(item.accountId, item.draft));
          const p = this.provider(item.accountId);
          const sent = await p.send(raw, item.draft.threadId);
          if (item.draft.draftId) await p.deleteDraft(item.draft.draftId).catch(() => undefined);
          this.db.run("UPDATE outbox SET status = 'sent', sent_message_id = ? WHERE id = ?", sent.id, id);
          await this.sync.refreshThread(item.accountId, sent.threadId);
          if (item.markDoneAfter) {
            const t = this.store.thread(item.accountId, sent.threadId);
            if (t?.inInbox) this.applyOps(item.accountId, [{ threadId: sent.threadId, add: [], remove: ["INBOX"] }]);
          }
          this.bus.emitEvent({ type: "outbox", accountId: item.accountId, threadIds: [sent.threadId], data: { id, status: "sent", threadId: sent.threadId } });
        } catch (e) {
          const message = (e as Error).message;
          this.db.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", message, id);
          this.bus.emitEvent({ type: "outbox", accountId: item.accountId, data: { id, status: "failed", error: message } });
          this.bus.emitEvent({ type: "notification", accountId: item.accountId, data: { title: "Send failed", body: message, kind: "error" } });
        }
      }
    }
  }

  // ---------------------------------------------------------------- snippets

  snippets(): Snippet[] {
    return this.db
      .all<{ id: string; name: string; subject: string; html: string; to_: string; cc: string; bcc: string; updated_at: number }>(
        "SELECT * FROM snippets ORDER BY updated_at DESC",
      )
      .map((r) => ({ id: r.id, name: r.name, subject: r.subject, html: r.html, to: r.to_, cc: r.cc, bcc: r.bcc, updatedAt: r.updated_at }));
  }

  saveSnippet(s: Partial<Snippet> & { name: string; html: string }): Snippet {
    const id = s.id ?? uid("sn_");
    this.db.run(
      `INSERT INTO snippets (id, name, subject, html, to_, cc, bcc, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, subject = excluded.subject, html = excluded.html, to_ = excluded.to_,
         cc = excluded.cc, bcc = excluded.bcc, updated_at = excluded.updated_at`,
      id,
      s.name,
      s.subject ?? "",
      s.html,
      s.to ?? "",
      s.cc ?? "",
      s.bcc ?? "",
      Date.now(),
    );
    return this.snippets().find((x) => x.id === id)!;
  }

  deleteSnippet(id: string): void {
    this.db.run("DELETE FROM snippets WHERE id = ?", id);
  }

  /** Expand {first_name}, {last_name}, {full_name}, {email}, {my_first_name}, {my_name}, {date}, {weekday}. */
  expandSnippet(id: string, ctx: { to?: string | Address[]; accountId?: string } = {}): Snippet {
    const s = this.snippets().find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!s) throw new Error(`Unknown snippet: ${id}`);
    const first = toAddresses(ctx.to)[0];
    const full = first ? displayName(first) : "";
    const me = this.myAddress(this.acct(ctx.accountId));
    const vars: Record<string, string> = {
      first_name: full.split(/\s+/)[0] ?? "",
      last_name: full.split(/\s+/).slice(1).join(" "),
      full_name: full,
      email: first?.email ?? "",
      my_name: me.name,
      my_first_name: me.name.split(/\s+/)[0] ?? "",
      date: new Date().toLocaleDateString(),
      weekday: new Date().toLocaleDateString(undefined, { weekday: "long" }),
    };
    const sub = (x: string) => x.replace(/\{\s*([a-z_]+)\s*\}/gi, (m, k) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : m));
    return { ...s, subject: sub(s.subject), html: sub(s.html) };
  }

  // ---------------------------------------------------------------- unsubscribe / block

  async unsubscribe(accountIdIn: string | undefined, threadId: string, then: "none" | "done" | "trash" = "done") {
    const accountId = this.acct(accountIdIn);
    const msgs = this.store.messages(accountId, threadId);
    const m = [...msgs].reverse().find((x) => x.listUnsubscribe);
    if (!m) return { ok: false, method: "none", message: "No List-Unsubscribe header in this thread" };
    const links = [...m.listUnsubscribe.matchAll(/<([^>]+)>/g)].map((x) => x[1]);
    const http = links.find((l) => /^https?:/i.test(l));
    const mailto = links.find((l) => /^mailto:/i.test(l));
    let method = "none";
    let url: string | undefined;
    if (http && /one-click/i.test(m.listUnsubscribePost)) {
      const r = await fetch(http, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        redirect: "follow",
      }).catch(() => null);
      method = r && r.ok ? "one-click" : "one-click-failed";
      if (!r?.ok) url = http;
    } else if (mailto) {
      const u = new URL(mailto);
      this.send(
        { accountId, to: decodeURIComponent(u.pathname), subject: u.searchParams.get("subject") ?? "unsubscribe", text: u.searchParams.get("body") ?? "unsubscribe" },
        { instant: true },
      );
      method = "mailto";
    } else if (http) {
      method = "link";
      url = http;
    }
    const sender = m.from.email;
    if (then !== "none") {
      const ids = this.store.threadsWhere("account_id = ? AND in_inbox = 1", [accountId], 5000).filter((t) => t.participants.some((p) => p.email === sender)).map((t) => t.id);
      if (!ids.includes(threadId)) ids.push(threadId);
      if (then === "trash") this.trash(accountId, ids);
      else this.markDone(accountId, ids);
    }
    return { ok: method === "one-click" || method === "mailto", method, url, sender };
  }

  rules(accountId: string): { id: string; kind: string; value: string }[] {
    return this.db.all("SELECT id, kind, value FROM rules WHERE account_id = ? ORDER BY created_at", accountId);
  }

  async block(accountIdIn: string | undefined, value: string, kind: "block_sender" | "block_domain" = "block_sender") {
    const accountId = this.acct(accountIdIn);
    const v = value.toLowerCase().replace(/^@/, "");
    this.db.run("INSERT INTO rules (id, account_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?)", uid("ru_"), accountId, kind, v, Date.now());
    const p = this.provider(accountId);
    await p.createFilter?.({ from: kind === "block_domain" ? `@${v}` : v }, { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] }).catch((e) => this.reportError("filter", e));
    const ids = this.inboxThreads(accountId)
      .filter((t) => t.participants.some((a) => (kind === "block_domain" ? a.email.endsWith(`@${v}`) : a.email === v)))
      .map((t) => t.id);
    if (ids.length) this.trash(accountId, ids);
    return { ok: true, trashed: ids.length };
  }

  // ---------------------------------------------------------------- contacts

  /** Autocomplete. `all`: every account merged, deduped by email (best-ranked entry wins), same ranking. */
  contacts(accountIdIn: string | undefined, q: string, limit = 8): Contact[] {
    if (!isAllAccounts(accountIdIn)) return this.store.contacts(this.acct(accountIdIn), q, limit);
    const now = Date.now();
    const rank = (c: Contact) => c.score / (1 + (now - c.lastContacted) / 2_592_000_000); // = Store.contacts ORDER BY
    const best = new Map<string, Contact>();
    for (const a of this.accountIds(accountIdIn)) {
      for (const c of this.store.contacts(a, q, limit)) {
        const key = c.email.toLowerCase();
        const cur = best.get(key);
        if (!cur || rank(c) > rank(cur)) best.set(key, c);
      }
    }
    return [...best.values()].sort((x, y) => rank(y) - rank(x)).slice(0, limit);
  }

  person(accountIdIn: string | undefined, email: string) {
    const accountId = this.acct(accountIdIn);
    const e = email.toLowerCase();
    return {
      email: e,
      contact: this.store.contact(accountId, e) ?? null,
      recentThreads: this.store.threadsWithPerson(accountId, e, 8),
      domain: e.split("@")[1] ?? "",
    };
  }

  // ---------------------------------------------------------------- sidebar (GET /api/mailboxes)

  /** Sidebar counts for every account plus All Inboxes, in one call. Memoized per account on the store state. */
  mailboxes(): Mailboxes {
    const accounts: MailboxAccount[] = this.store.accounts().map((a, i) => {
      const splits = this.accountSplitsWithCounts(a.id);
      const important = splits.find((s) => s.builtin === "important");
      const other = splits.find((s) => s.builtin === "other");
      const inbox = this.inboxState(a.id).threads;
      const memo = this.mailboxState(a.id);
      const counts: MailboxCounts = {
        inbox: inbox.length,
        inboxUnread: inbox.reduce((n, t) => n + (t.unread ? 1 : 0), 0),
        important: important?.count ?? 0,
        importantUnread: important?.unread ?? 0,
        other: other?.count ?? 0,
        otherUnread: other?.unread ?? 0,
        ...memo.counts,
        // reminders/outbox writes do not all bump the store version: counted live (indexed, small)
        reminders: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending' AND account_id = ?", a.id)?.n ?? 0,
        scheduled: this.scheduledCount(a.id),
      };
      return { id: a.id, email: a.email, name: a.name, color: accountColor(i), provider: a.provider, error: this.sync.lastError(a.id), counts, labels: memo.labels };
    });
    const sum = (k: keyof Mailboxes["unified"]) => accounts.reduce((n, a) => n + a.counts[k], 0);
    return {
      unified: {
        inbox: sum("inbox"),
        inboxUnread: sum("inboxUnread"),
        important: sum("important"),
        importantUnread: sum("importantUnread"),
        other: sum("other"),
        otherUnread: sum("otherUnread"),
      },
      accounts,
    };
  }

  /** Same threads as the `scheduled` view: queued sends that belong to a thread. */
  private scheduledCount(accountId: string): number {
    return (
      this.db.get<{ n: number }>(
        "SELECT COUNT(DISTINCT json_extract(draft_json, '$.threadId')) AS n FROM outbox WHERE account_id = ? AND status = 'queued' AND json_extract(draft_json, '$.threadId') IS NOT NULL",
        accountId,
      )?.n ?? 0
    );
  }

  /** Starred / drafts / spam / trash counts and label unread counts in one scan, same rules as the views. */
  private mailboxState(accountId: string): MailboxMemo {
    const key = this.stateKey();
    const hit = this.mailboxMemo.get(accountId);
    if (hit?.key === key) return hit;
    // label_ids is a JSON array of ids: instr('"SPAM"') is an exact id match and much cheaper than json_each per row
    const spam = `instr(label_ids, '"SPAM"') > 0`;
    const trash = `instr(label_ids, '"TRASH"') > 0`;
    const r = this.db.get<{ starred: number | null; drafts: number | null; spam: number | null; trash: number | null }>(
      `SELECT SUM(starred = 1 AND NOT ${spam} AND NOT ${trash}) AS starred, SUM(has_draft = 1) AS drafts,
              SUM(${spam}) AS spam, SUM(${trash}) AS trash
         FROM threads WHERE account_id = ?`,
      accountId,
    );
    const hidden = new Set<string>(Object.values(IRIS_LABELS).map((n) => n.toLowerCase()));
    const user = this.store.labels(accountId).filter((l) => l.type === "user" && !hidden.has(l.name.toLowerCase()));
    const unread = new Map<string, number>(user.map((l) => [l.id, 0]));
    for (const row of this.db.all<{ label_ids: string }>(
      `SELECT label_ids FROM threads WHERE account_id = ? AND unread = 1 AND NOT ${spam} AND NOT ${trash}`,
      accountId,
    )) {
      for (const id of JSON.parse(row.label_ids) as string[]) {
        const n = unread.get(id);
        if (n !== undefined) unread.set(id, n + 1);
      }
    }
    const memo: MailboxMemo = {
      key,
      counts: { starred: r?.starred ?? 0, drafts: r?.drafts ?? 0, spam: r?.spam ?? 0, trash: r?.trash ?? 0 },
      labels: user.map((l) => ({ id: l.id, name: l.name, unread: unread.get(l.id) ?? 0 })),
    };
    this.mailboxMemo.set(accountId, memo);
    return memo;
  }

  status() {
    return {
      demo: this.demo,
      accounts: this.store.accounts().map((a, i) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        color: accountColor(i),
        provider: a.provider,
        lastSyncAt: a.lastSyncAt,
        syncing: (({ done, total } = { done: 0, total: 0 }) => (this.sync.progress.has(a.id) ? { done, total } : null))(this.sync.progress.get(a.id)),
        inbox: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE account_id = ? AND in_inbox = 1", a.id)?.n ?? 0,
        unread: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE account_id = ? AND in_inbox = 1 AND unread = 1", a.id)?.n ?? 0,
        threads: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE account_id = ?", a.id)?.n ?? 0,
        calendar: this.calendar.status(a.id),
      })),
      settings: this.settings,
    };
  }
}

/** One description for an action over several accounts ("Marked done" + "Marked 2 done" → "Marked 3 done"). */
function combineDescriptions(descs: string[], count: number): string | undefined {
  if (!descs.length) return undefined;
  const norm = [...new Set(descs.map((d) => d.replace(/^Marked \d+ done$/, "Marked done")))];
  if (norm.length > 1) return [...new Set(descs)].join("; ");
  return norm[0] === "Marked done" && count > 1 ? `Marked ${count} done` : norm[0];
}

/** Await every promise; failures are reported and skipped unless all of them failed (then the first error is thrown). */
async function settled<T>(ps: Promise<T>[], report: (e: unknown) => void): Promise<T[]> {
  const ok: T[] = [];
  const bad: unknown[] = [];
  for (const r of await Promise.allSettled(ps)) {
    if (r.status === "fulfilled") ok.push(r.value as T);
    else bad.push(r.reason);
  }
  if (bad.length && !ok.length) throw bad[0];
  bad.forEach(report);
  return ok;
}

function usesRelativeTime(n: QNode): boolean {
  switch (n.t) {
    case "and":
    case "or":
      return n.c.some(usesRelativeTime);
    case "not":
      return usesRelativeTime(n.c);
    case "op":
      return n.op === "newer_than" || n.op === "older_than";
    default:
      return false;
  }
}

function stripText(n: ReturnType<typeof parseQuery>): ReturnType<typeof parseQuery> | null {
  switch (n.t) {
    case "text":
      return null;
    case "and": {
      const c = n.c.map(stripText).filter((x): x is NonNullable<typeof x> => !!x);
      return c.length ? { t: "and", c } : null;
    }
    default:
      return n;
  }
}

export { parseAddressList };
