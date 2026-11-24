import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";
import { ensureHome, irisHome } from "./config.ts";

type Row = Record<string, SQLInputValue>;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL,
    history_id TEXT, created_at INTEGER NOT NULL, last_sync_at INTEGER, signature_html TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE labels (
    account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, color_json TEXT,
    messages_unread INTEGER, PRIMARY KEY (account_id, id)
  );
  CREATE TABLE messages (
    account_id TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL, date INTEGER NOT NULL,
    from_json TEXT NOT NULL, to_json TEXT NOT NULL, cc_json TEXT NOT NULL, bcc_json TEXT NOT NULL, reply_to_json TEXT NOT NULL,
    subject TEXT NOT NULL, snippet TEXT NOT NULL, label_ids TEXT NOT NULL,
    message_id_header TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '',
    list_id TEXT NOT NULL DEFAULT '', list_unsubscribe TEXT NOT NULL DEFAULT '', list_unsubscribe_post TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]',
    is_draft INTEGER NOT NULL DEFAULT 0, is_sent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, id)
  );
  CREATE INDEX messages_thread ON messages(account_id, thread_id, date);
  CREATE TABLE threads (
    account_id TEXT NOT NULL, id TEXT NOT NULL, subject TEXT NOT NULL, snippet TEXT NOT NULL, last_date INTEGER NOT NULL,
    participants_json TEXT NOT NULL, label_ids TEXT NOT NULL, message_count INTEGER NOT NULL,
    unread INTEGER NOT NULL, starred INTEGER NOT NULL, important INTEGER NOT NULL, in_inbox INTEGER NOT NULL,
    has_attachments INTEGER NOT NULL, has_draft INTEGER NOT NULL, last_from_json TEXT, list_id TEXT NOT NULL DEFAULT '',
    ai_labels_json TEXT, returned_at INTEGER,
    PRIMARY KEY (account_id, id)
  );
  CREATE INDEX threads_date ON threads(account_id, last_date DESC);
  CREATE INDEX threads_inbox ON threads(account_id, in_inbox, last_date DESC);
  CREATE VIRTUAL TABLE thread_fts USING fts5(
    subject, from_text, to_text, body, labels, account_id UNINDEXED, thread_id UNINDEXED, tokenize = 'porter unicode61'
  );
  CREATE TABLE reminders (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, thread_id TEXT NOT NULL, remind_at INTEGER NOT NULL,
    if_no_reply INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, last_message_id TEXT, note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_due ON reminders(status, remind_at);
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, draft_json TEXT NOT NULL, send_at INTEGER NOT NULL, status TEXT NOT NULL,
    error TEXT, sent_message_id TEXT, mark_done_after INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE splits (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL, position INTEGER NOT NULL,
    leave_in_io INTEGER NOT NULL DEFAULT 0, builtin TEXT, enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE snippets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', html TEXT NOT NULL,
    to_ TEXT NOT NULL DEFAULT '', cc TEXT NOT NULL DEFAULT '', bcc TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
  );
  CREATE TABLE contacts (
    account_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', score REAL NOT NULL DEFAULT 0,
    last_contacted INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0, recv_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, email)
  );
  CREATE TABLE ai_cache (
    account_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL, cache_key TEXT NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (account_id, thread_id, kind)
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE undo_log (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, description TEXT NOT NULL, ops_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE rules (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN body_loaded INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE messages ADD COLUMN attachment_hint INTEGER NOT NULL DEFAULT 0;
  `,
  // calendar: calendar list (+ local selected/color/notify overrides) and cached events (-30..+120 days, per-calendar sync token); invite parts on messages
  `
  ALTER TABLE messages ADD COLUMN ics TEXT;
  CREATE TABLE calendars (
    account_id TEXT NOT NULL, id TEXT NOT NULL, summary TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0, selected_remote INTEGER NOT NULL DEFAULT 1, selected_local INTEGER,
    access_role TEXT NOT NULL, time_zone TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
    color_local TEXT, notify_local INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
    sync_token TEXT, window_start INTEGER, window_end INTEGER, synced_at INTEGER,
    PRIMARY KEY (account_id, id)
  );
  CREATE TABLE events (
    account_id TEXT NOT NULL, calendar_id TEXT NOT NULL, id TEXT NOT NULL, ical_uid TEXT NOT NULL DEFAULT '',
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (account_id, calendar_id, id)
  );
  CREATE INDEX events_range ON events(account_id, start_ms);
  CREATE INDEX events_uid ON events(account_id, ical_uid);
  `,
  // goals: steps drive the progress, threads link the mail that belongs to a goal
  `
  CREATE TABLE goals (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', start_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE TABLE goal_steps (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE, title TEXT NOT NULL,
    position INTEGER NOT NULL, done_at INTEGER
  );
  CREATE INDEX goal_steps_goal ON goal_steps(goal_id, position);
  CREATE TABLE goal_threads (
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    added_at INTEGER NOT NULL, PRIMARY KEY (goal_id, account_id, thread_id)
  );
  `,
  // goal kinds: steps (default, every goal so far), metric (a number moving from start to target), habit (daily yes/no)
  `
  ALTER TABLE goals ADD COLUMN kind TEXT NOT NULL DEFAULT 'steps';
  ALTER TABLE goals ADD COLUMN start_value REAL;
  ALTER TABLE goals ADD COLUMN target_value REAL;
  ALTER TABLE goals ADD COLUMN unit TEXT NOT NULL DEFAULT '';
  ALTER TABLE goals ADD COLUMN start_date TEXT;
  CREATE TABLE goal_entries (
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE, date TEXT NOT NULL, value REAL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (goal_id, date)
  );
  `,
  // person research: background web + mailbox research runs (ai/research.ts), one row per run.
  // query_name = the name as asked for (folded), for dedupe after `name` was completed from mail or the report
  `
  CREATE TABLE person_research (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, name_source TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    query_name TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '', event_id TEXT NOT NULL DEFAULT '', calendar_id TEXT NOT NULL DEFAULT '', event_title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, report TEXT NOT NULL DEFAULT '', tldr TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT '',
    sources TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', progress TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX person_research_account ON person_research(account_id, created_at);
  CREATE INDEX person_research_event ON person_research(account_id, event_id);
  `,
];

export class DB {
  readonly raw: DatabaseSync;

  constructor(file = path.join(ensureHome(irisHome()), "iris.db")) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.raw.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    let v = row?.version ?? 0;
    if (!row) this.raw.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    while (v < MIGRATIONS.length) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.prepare("UPDATE schema_version SET version = ?").run(v + 1);
      });
      v++;
    }
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.raw.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  kvGet(key: string): string | null {
    return this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  close(): void {
    this.raw.close();
  }
}

export function uid(prefix = ""): string {
  return prefix + Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
}
