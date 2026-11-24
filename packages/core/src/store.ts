// Local cache: threads, messages, labels, contacts, FTS index.
import type { StatementSync } from "node:sqlite";
import type { DB } from "./db.ts";
import { htmlToText } from "./mime.ts";
import type { Account, Address, Contact, Label, Message, ThreadSummary } from "./types.ts";

interface ThreadRow {
  account_id: string;
  id: string;
  subject: string;
  snippet: string;
  last_date: number;
  participants_json: string;
  label_ids: string;
  message_count: number;
  unread: number;
  starred: number;
  important: number;
  in_inbox: number;
  has_attachments: number;
  has_draft: number;
  last_from_json: string | null;
  list_id: string;
  ai_labels_json: string | null;
  returned_at: number | null;
}

interface MessageRow {
  account_id: string;
  id: string;
  thread_id: string;
  date: number;
  from_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  subject: string;
  snippet: string;
  label_ids: string;
  message_id_header: string;
  refs: string;
  in_reply_to: string;
  list_id: string;
  list_unsubscribe: string;
  list_unsubscribe_post: string;
  body_html: string;
  body_text: string;
  attachments_json: string;
  is_draft: number;
  is_sent: number;
  body_loaded: number;
  attachment_hint: number;
  ics: string | null;
}

export function rowToThread(r: ThreadRow): ThreadSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    lastDate: r.last_date,
    participants: JSON.parse(r.participants_json),
    labelIds: JSON.parse(r.label_ids),
    messageCount: r.message_count,
    unread: !!r.unread,
    starred: !!r.starred,
    important: !!r.important,
    inInbox: !!r.in_inbox,
    hasAttachments: !!r.has_attachments,
    hasDraft: !!r.has_draft,
    lastFrom: r.last_from_json ? JSON.parse(r.last_from_json) : null,
    listId: r.list_id,
    aiLabels: r.ai_labels_json ? JSON.parse(r.ai_labels_json) : [],
    returnedAt: r.returned_at,
  };
}

export function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    date: r.date,
    from: JSON.parse(r.from_json),
    to: JSON.parse(r.to_json),
    cc: JSON.parse(r.cc_json),
    bcc: JSON.parse(r.bcc_json),
    replyTo: JSON.parse(r.reply_to_json),
    subject: r.subject,
    snippet: r.snippet,
    labelIds: JSON.parse(r.label_ids),
    messageIdHeader: r.message_id_header,
    references: r.refs,
    inReplyTo: r.in_reply_to,
    listId: r.list_id,
    listUnsubscribe: r.list_unsubscribe,
    listUnsubscribePost: r.list_unsubscribe_post,
    bodyHtml: r.body_html,
    bodyText: r.body_text,
    attachments: JSON.parse(r.attachments_json),
    isDraft: !!r.is_draft,
    isSent: !!r.is_sent,
    bodyLoaded: r.body_loaded !== 0,
    attachmentHint: !!r.attachment_hint,
    ...(r.ics ? { ics: r.ics } : {}),
  };
}

export function summarize(accountId: string, threadId: string, messages: Message[], myEmails: string[]): ThreadSummary | null {
  if (!messages.length) return null;
  const sorted = [...messages].sort((a, b) => a.date - b.date);
  const real = sorted.filter((m) => !m.isDraft);
  const basis = real.length ? real : sorted;
  const last = basis[basis.length - 1];
  const labels = new Set<string>();
  for (const m of sorted) for (const l of m.labelIds) labels.add(l);
  const seen = new Set<string>();
  const participants: Address[] = [];
  for (const m of [...basis].reverse()) {
    const addrs = [m.from, ...(myEmails.includes(m.from.email) ? m.to : [])];
    for (const a of addrs) {
      if (!a?.email || seen.has(a.email)) continue;
      seen.add(a.email);
      participants.push(a);
    }
  }
  const has = (l: string) => sorted.some((m) => m.labelIds.includes(l));
  return {
    id: threadId,
    accountId,
    subject: sorted[0].subject || last.subject || "(no subject)",
    snippet: last.snippet,
    lastDate: last.date,
    participants,
    labelIds: [...labels],
    messageCount: real.length || sorted.length,
    unread: has("UNREAD"),
    starred: has("STARRED"),
    important: has("IMPORTANT"),
    inInbox: has("INBOX"),
    hasAttachments: sorted.some((m) => m.attachments.some((a) => !a.inline) || (m.bodyLoaded === false && !!m.attachmentHint)),
    hasDraft: sorted.some((m) => m.isDraft),
    lastFrom: last.from,
    listId: sorted.find((m) => m.listId)?.listId ?? "",
  };
}

export class Store {
  readonly db: DB;
  /**
   * Bumped on every local write that can change what a thread looks like to the query evaluator
   * (threads, messages, FTS, labels, AI labels, reminders, splits). Memos of split assignments key on it.
   */
  version = 0;
  private ftsBodyStmt: StatementSync | null = null;
  constructor(db: DB) {
    this.db = db;
  }

  /** Mark thread-related state as changed (invalidates split/inbox memos). */
  touch(): void {
    this.version++;
  }

  // ---------- accounts ----------
  accounts(): Account[] {
    return this.db
      .all<Record<string, string | number | null>>("SELECT * FROM accounts ORDER BY created_at, rowid")
      .map((r) => ({
        id: r.id as string,
        email: r.email as string,
        name: r.name as string,
        provider: r.provider as Account["provider"],
        historyId: (r.history_id as string) ?? null,
        createdAt: r.created_at as number,
        lastSyncAt: (r.last_sync_at as number) ?? null,
        signatureHtml: (r.signature_html as string) ?? "",
      }));
  }

  account(id: string): Account | undefined {
    return this.accounts().find((a) => a.id === id);
  }

  upsertAccount(a: Pick<Account, "id" | "email" | "name" | "provider">): void {
    this.db.run(
      `INSERT INTO accounts (id, email, name, provider, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider = excluded.provider`,
      a.id,
      a.email,
      a.name,
      a.provider,
      Date.now(),
    );
  }

  setAccountSync(id: string, historyId: string | null): void {
    this.db.run("UPDATE accounts SET history_id = ?, last_sync_at = ? WHERE id = ?", historyId, Date.now(), id);
  }

  setSignature(id: string, html: string): void {
    this.db.run("UPDATE accounts SET signature_html = ? WHERE id = ?", html, id);
  }

  removeAccount(id: string): void {
    this.touch();
    this.db.tx(() => {
      for (const t of ["labels", "messages", "threads", "reminders", "outbox", "splits", "contacts", "ai_cache", "undo_log", "rules", "calendars", "events"]) {
        this.db.run(`DELETE FROM ${t} WHERE account_id = ?`, id);
      }
      this.db.run("DELETE FROM thread_fts WHERE account_id = ?", id);
      this.db.run("DELETE FROM accounts WHERE id = ?", id);
    });
  }

  // ---------- labels ----------
  replaceLabels(accountId: string, labels: Label[]): void {
    this.touch();
    this.db.tx(() => {
      this.db.run("DELETE FROM labels WHERE account_id = ?", accountId);
      for (const l of labels) {
        this.db.run(
          "INSERT INTO labels (account_id, id, name, type, color_json, messages_unread) VALUES (?, ?, ?, ?, ?, ?)",
          accountId,
          l.id,
          l.name,
          l.type,
          l.color ? JSON.stringify(l.color) : null,
          l.messagesUnread ?? null,
        );
      }
    });
  }

  labels(accountId: string): Label[] {
    return this.db
      .all<{ id: string; name: string; type: string; color_json: string | null; messages_unread: number | null }>(
        "SELECT * FROM labels WHERE account_id = ? ORDER BY type DESC, name COLLATE NOCASE",
        accountId,
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type as Label["type"],
        color: r.color_json ? JSON.parse(r.color_json) : null,
        messagesUnread: r.messages_unread ?? undefined,
      }));
  }

  labelByName(accountId: string, name: string): Label | undefined {
    const n = name.toLowerCase();
    return this.labels(accountId).find((l) => l.name.toLowerCase() === n || l.id.toLowerCase() === n);
  }

  // ---------- threads ----------
  saveThread(accountId: string, threadId: string, messages: Message[], myEmails: string[]): ThreadSummary | null {
    this.touch();
    return this.db.tx(() => {
      const rows = this.db.all<{ id: string; body_loaded: number; body_html: string; body_text: string; attachments_json: string; ics: string | null }>(
        "SELECT id, body_loaded, body_html, body_text, attachments_json, ics FROM messages WHERE account_id = ? AND thread_id = ?",
        accountId,
        threadId,
      );
      const existing = new Set(rows.map((r) => r.id));
      // a metadata-only refresh must not throw away bodies we already have
      const bodies = new Map(rows.filter((r) => r.body_loaded).map((r) => [r.id, r]));
      messages = messages.map((m) => {
        const b = m.bodyLoaded === false ? bodies.get(m.id) : undefined;
        return b
          ? { ...m, bodyHtml: b.body_html, bodyText: b.body_text, attachments: JSON.parse(b.attachments_json), bodyLoaded: true, ...(b.ics ? { ics: b.ics } : {}) }
          : m;
      });
      this.db.run("DELETE FROM messages WHERE account_id = ? AND thread_id = ?", accountId, threadId);
      for (const m of messages) this.insertMessage(m);
      const s = summarize(accountId, threadId, messages, myEmails);
      if (!s) {
        this.deleteThread(accountId, threadId);
        return null;
      }
      const prev = this.db.get<{ ai_labels_json: string | null; returned_at: number | null }>(
        "SELECT ai_labels_json, returned_at FROM threads WHERE account_id = ? AND id = ?",
        accountId,
        threadId,
      );
      this.db.run(
        `INSERT INTO threads (account_id, id, subject, snippet, last_date, participants_json, label_ids, message_count, unread, starred,
           important, in_inbox, has_attachments, has_draft, last_from_json, list_id, ai_labels_json, returned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, id) DO UPDATE SET subject=excluded.subject, snippet=excluded.snippet, last_date=excluded.last_date,
           participants_json=excluded.participants_json, label_ids=excluded.label_ids, message_count=excluded.message_count,
           unread=excluded.unread, starred=excluded.starred, important=excluded.important, in_inbox=excluded.in_inbox,
           has_attachments=excluded.has_attachments, has_draft=excluded.has_draft, last_from_json=excluded.last_from_json,
           list_id=excluded.list_id`,
        accountId,
        threadId,
        s.subject,
        s.snippet,
        s.lastDate,
        JSON.stringify(s.participants),
        JSON.stringify(s.labelIds),
        s.messageCount,
        +s.unread,
        +s.starred,
        +s.important,
        +s.inInbox,
        +s.hasAttachments,
        +s.hasDraft,
        s.lastFrom ? JSON.stringify(s.lastFrom) : null,
        s.listId,
        prev?.ai_labels_json ?? null,
        prev?.returned_at ?? null,
      );
      this.indexThread(accountId, threadId, messages);
      this.updateContacts(accountId, messages.filter((m) => !existing.has(m.id)), myEmails);
      return s;
    });
  }

  private insertMessage(m: Message): void {
    this.db.run(
      `INSERT OR REPLACE INTO messages (account_id, id, thread_id, date, from_json, to_json, cc_json, bcc_json, reply_to_json, subject, snippet,
         label_ids, message_id_header, refs, in_reply_to, list_id, list_unsubscribe, list_unsubscribe_post, body_html, body_text,
         attachments_json, is_draft, is_sent, body_loaded, attachment_hint, ics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.accountId,
      m.id,
      m.threadId,
      m.date,
      JSON.stringify(m.from),
      JSON.stringify(m.to),
      JSON.stringify(m.cc),
      JSON.stringify(m.bcc),
      JSON.stringify(m.replyTo),
      m.subject,
      m.snippet,
      JSON.stringify(m.labelIds),
      m.messageIdHeader,
      m.references,
      m.inReplyTo,
      m.listId,
      m.listUnsubscribe,
      m.listUnsubscribePost,
      m.bodyHtml,
      m.bodyText,
      JSON.stringify(m.attachments),
      +m.isDraft,
      +m.isSent,
      m.bodyLoaded === false ? 0 : 1,
      +!!m.attachmentHint,
      m.ics ?? null,
    );
  }

  private indexThread(accountId: string, threadId: string, messages: Message[]): void {
    this.db.run("DELETE FROM thread_fts WHERE account_id = ? AND thread_id = ?", accountId, threadId);
    const fmt = (a: Address) => `${a.name} ${a.email}`;
    const labelNames = new Map(this.labels(accountId).map((l) => [l.id, l.name]));
    const labels = new Set<string>();
    for (const m of messages) for (const l of m.labelIds) labels.add(labelNames.get(l) ?? l);
    this.db.run(
      "INSERT INTO thread_fts (subject, from_text, to_text, body, labels, account_id, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      messages.map((m) => m.subject).join(" \n"),
      messages.map((m) => fmt(m.from)).join(" "),
      messages.flatMap((m) => [...m.to, ...m.cc, ...m.bcc].map(fmt)).join(" "),
      messages
        .map((m) => (m.bodyText || htmlToText(m.bodyHtml) || m.snippet) + " " + m.attachments.map((a) => a.filename).join(" "))
        .join("\n")
        .slice(0, 200_000),
      [...labels].join(" "),
      accountId,
      threadId,
    );
  }

  private updateContacts(accountId: string, messages: Message[], myEmails: string[]): void {
    for (const m of messages) {
      if (m.isDraft) continue;
      const mine = myEmails.includes(m.from.email);
      const people = mine ? [...m.to, ...m.cc, ...m.bcc] : [m.from];
      for (const p of people) {
        if (!p.email || myEmails.includes(p.email)) continue;
        if (/no-?reply|notifications?@|mailer-daemon|bounce/i.test(p.email)) continue;
        const weight = mine ? 3 : 1;
        this.db.run(
          `INSERT INTO contacts (account_id, email, name, score, last_contacted, sent_count, recv_count) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, email) DO UPDATE SET
             name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
             last_contacted = MAX(contacts.last_contacted, excluded.last_contacted),
             sent_count = contacts.sent_count + excluded.sent_count,
             recv_count = contacts.recv_count + excluded.recv_count,
             score = contacts.score + excluded.score`,
          accountId,
          p.email,
          p.name ?? "",
          weight,
          m.date,
          mine ? 1 : 0,
          mine ? 0 : 1,
        );
      }
    }
  }

  deleteThread(accountId: string, threadId: string): void {
    this.touch();
    this.db.run("DELETE FROM messages WHERE account_id = ? AND thread_id = ?", accountId, threadId);
    this.db.run("DELETE FROM threads WHERE account_id = ? AND id = ?", accountId, threadId);
    this.db.run("DELETE FROM thread_fts WHERE account_id = ? AND thread_id = ?", accountId, threadId);
  }

  deleteMessages(accountId: string, ids: string[]): string[] {
    this.touch();
    const threads = new Set<string>();
    for (const id of ids) {
      const r = this.db.get<{ thread_id: string }>("SELECT thread_id FROM messages WHERE account_id = ? AND id = ?", accountId, id);
      if (r) threads.add(r.thread_id);
      this.db.run("DELETE FROM messages WHERE account_id = ? AND id = ?", accountId, id);
    }
    return [...threads];
  }

  thread(accountId: string, threadId: string): ThreadSummary | undefined {
    const r = this.db.get<ThreadRow>("SELECT * FROM threads WHERE account_id = ? AND id = ?", accountId, threadId);
    return r ? rowToThread(r) : undefined;
  }

  messages(accountId: string, threadId: string): Message[] {
    return this.db
      .all<MessageRow>("SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date", accountId, threadId)
      .map(rowToMessage);
  }

  message(accountId: string, messageId: string): Message | undefined {
    const r = this.db.get<MessageRow>("SELECT * FROM messages WHERE account_id = ? AND id = ?", accountId, messageId);
    return r ? rowToMessage(r) : undefined;
  }

  threadsWhere(sqlWhere: string, params: (string | number)[], limit = 200, offset = 0): ThreadSummary[] {
    return this.db
      .all<ThreadRow>(`SELECT * FROM threads WHERE ${sqlWhere} ORDER BY last_date DESC LIMIT ? OFFSET ?`, ...params, limit, offset)
      .map(rowToThread);
  }

  threadsByIds(accountId: string, ids: string[]): ThreadSummary[] {
    if (!ids.length) return [];
    const out: ThreadSummary[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      out.push(
        ...this.db
          .all<ThreadRow>(
            `SELECT * FROM threads WHERE account_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
            accountId,
            ...chunk,
          )
          .map(rowToThread),
      );
    }
    return out.sort((a, b) => b.lastDate - a.lastDate);
  }

  /** FTS match → thread ids. `match` must be a valid FTS5 expression. */
  ftsThreadIds(accountId: string, match: string, limit = 2000): string[] {
    try {
      return this.db
        .all<{ thread_id: string }>(
          "SELECT thread_id FROM thread_fts WHERE thread_fts MATCH ? AND account_id = ? ORDER BY rank LIMIT ?",
          match,
          accountId,
          limit,
        )
        .map((r) => r.thread_id);
    } catch {
      return [];
    }
  }

  /** Single-thread FTS text. Note: thread_id is UNINDEXED, so this is a full FTS scan; use ftsHeads/ftsBody in loops. */
  ftsText(accountId: string, threadId: string): { subject: string; from: string; to: string; body: string; labels: string } | undefined {
    return this.db.get(
      "SELECT subject, from_text AS 'from', to_text AS 'to', body, labels FROM thread_fts WHERE account_id = ? AND thread_id = ?",
      accountId,
      threadId,
    );
  }

  /**
   * FTS rowid + sender/recipient text for every indexed thread of an account, in one scan.
   * (Looking threads up one by one is O(n) each because thread_id is UNINDEXED.) First row per thread wins, like ftsText.
   */
  ftsHeads(accountId: string): Map<string, { rowid: number; from: string; to: string }> {
    const out = new Map<string, { rowid: number; from: string; to: string }>();
    for (const r of this.db.all<{ rowid: number; thread_id: string; from_text: string; to_text: string }>(
      "SELECT rowid, thread_id, from_text, to_text FROM thread_fts WHERE account_id = ?",
      accountId,
    )) {
      if (!out.has(r.thread_id)) out.set(r.thread_id, { rowid: r.rowid, from: r.from_text, to: r.to_text });
    }
    return out;
  }

  /** Indexed body text of one FTS row (rowid from ftsHeads; only valid until the thread is re-indexed). */
  ftsBody(rowid: number): string | undefined {
    this.ftsBodyStmt ??= this.db.raw.prepare("SELECT body FROM thread_fts WHERE rowid = ?");
    return (this.ftsBodyStmt.get(rowid) as { body: string } | undefined)?.body;
  }

  setAiLabels(accountId: string, threadId: string, labels: string[]): void {
    this.touch();
    this.db.run("UPDATE threads SET ai_labels_json = ? WHERE account_id = ? AND id = ?", JSON.stringify(labels), accountId, threadId);
  }

  setReturned(accountId: string, threadId: string, at: number | null): void {
    this.touch();
    this.db.run("UPDATE threads SET returned_at = ? WHERE account_id = ? AND id = ?", at, accountId, threadId);
  }

  /** Optimistic local label change for a whole thread. */
  applyLabelsLocal(accountId: string, threadId: string, add: string[], remove: string[], myEmails: string[]): ThreadSummary | null {
    const msgs = this.messages(accountId, threadId);
    if (!msgs.length) return null;
    for (const m of msgs) {
      const s = new Set(m.labelIds);
      for (const l of add) s.add(l);
      for (const l of remove) s.delete(l);
      m.labelIds = [...s];
    }
    return this.saveThread(accountId, threadId, msgs, myEmails);
  }

  // ---------- contacts ----------
  contacts(accountId: string, q: string, limit = 10): Contact[] {
    const like = `%${q.toLowerCase()}%`;
    return this.db
      .all<{ email: string; name: string; score: number; last_contacted: number }>(
        `SELECT email, name, score, last_contacted FROM contacts WHERE account_id = ? AND (lower(email) LIKE ? OR lower(name) LIKE ?)
         ORDER BY (score * 1.0 / (1 + (? - last_contacted) / 2592000000.0)) DESC LIMIT ?`,
        accountId,
        like,
        like,
        Date.now(),
        limit,
      )
      .map((r) => ({ email: r.email, name: r.name, score: r.score, lastContacted: r.last_contacted }));
  }

  contact(accountId: string, email: string): Contact | undefined {
    const r = this.db.get<{ email: string; name: string; score: number; last_contacted: number }>(
      "SELECT email, name, score, last_contacted FROM contacts WHERE account_id = ? AND email = ?",
      accountId,
      email.toLowerCase(),
    );
    return r ? { email: r.email, name: r.name, score: r.score, lastContacted: r.last_contacted } : undefined;
  }

  threadsWithPerson(accountId: string, email: string, limit = 8): ThreadSummary[] {
    const like = `%"${email.toLowerCase()}"%`;
    return this.threadsWhere("account_id = ? AND participants_json LIKE ?", [accountId, like], limit);
  }
}
