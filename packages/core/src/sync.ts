// Gmail sync: initial window + incremental history.
import type { Bus } from "./events.ts";
import { inBackground, type MailProvider } from "./provider.ts";
import type { Store } from "./store.ts";
import type { Message } from "./types.ts";

export async function pmap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface SyncOptions {
  initialSyncDays: number;
  initialSyncMaxThreads: number;
}

export interface NewMessagesHandler {
  (accountId: string, messages: Message[]): void | Promise<void>;
}

export class SyncEngine {
  private running = new Map<string, Promise<void>>();
  private lastLabelSync = new Map<string, number>();
  /** last sync failure per account, cleared by the next successful sync */
  private errors = new Map<string, string>();
  onNewMessages: NewMessagesHandler | null = null;
  private store: Store;
  private provider: (accountId: string) => MailProvider;
  private bus: Bus;
  private opts: () => SyncOptions;

  constructor(store: Store, provider: (accountId: string) => MailProvider, bus: Bus, opts: () => SyncOptions) {
    this.store = store;
    this.provider = provider;
    this.bus = bus;
    this.opts = opts;
  }

  /** Message of the last failed sync of this account, or null when the last sync worked. */
  lastError(accountId: string): string | null {
    return this.errors.get(accountId) ?? null;
  }

  myEmails(accountId: string): string[] {
    return [accountId.toLowerCase()];
  }

  sync(accountId: string, full = false): Promise<void> {
    const cur = this.running.get(accountId);
    if (cur) return cur;
    const p = inBackground(() => this.doSync(accountId, full)).finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return p;
  }

  private async doSync(accountId: string, full: boolean): Promise<void> {
    const acct = this.store.account(accountId);
    if (!acct) throw new Error(`unknown account ${accountId}`);
    const p = this.provider(accountId);
    try {
      if (full || !acct.historyId) {
        await this.initial(accountId, p);
      } else {
        const ok = await this.incremental(accountId, p, acct.historyId);
        if (!ok) await this.initial(accountId, p);
      }
      this.errors.delete(accountId);
      this.bus.emitEvent({ type: "sync", accountId, data: { ok: true } });
    } catch (e) {
      this.errors.set(accountId, (e as Error).message);
      this.bus.emitEvent({ type: "error", accountId, data: { where: "sync", message: (e as Error).message } });
      throw e;
    }
  }

  /** Labels plus the Gmail signature (both change rarely; refreshed on initial sync and every 10 min). */
  async syncLabels(accountId: string, p = this.provider(accountId)): Promise<void> {
    this.store.replaceLabels(accountId, await p.listLabels());
    this.lastLabelSync.set(accountId, Date.now());
    const sig = await p.sendAsSignature?.().catch(() => null);
    if (sig) this.store.setSignature(accountId, sig.signature);
  }

  private async initial(accountId: string, p: MailProvider): Promise<void> {
    // Resume an interrupted initial sync (quota, network): only fetch what is still missing,
    // and keep the history id from the start of that run so no change in between is lost.
    const pendingKey = `initial-sync:${accountId}`;
    const pendingRaw = this.store.db.kvGet(pendingKey);
    const pending = pendingRaw ? (JSON.parse(pendingRaw) as { historyId: string; startedAt: number; remaining: string[] }) : null;
    if (pending && Date.now() - pending.startedAt < 12 * 3600_000) {
      await this.syncLabels(accountId, p);
      await this.finishInitial(accountId, p, pending.historyId, pending.startedAt, pending.remaining);
      return;
    }

    const { historyId } = await p.profile();
    const startedAt = Date.now();
    await this.syncLabels(accountId, p);
    const o = this.opts();
    const ids = new Set<string>();
    // 1) whole inbox (kept hot)
    let page: string | undefined;
    do {
      const r = await p.listThreadIds({ labelIds: ["INBOX"], maxResults: 500, pageToken: page });
      r.ids.forEach((id) => ids.add(id));
      page = r.nextPageToken;
    } while (page && ids.size < o.initialSyncMaxThreads);
    // 2) recent everything else (sent, archived, labels) for search + contacts
    page = undefined;
    do {
      const r = await p.listThreadIds({ q: `newer_than:${o.initialSyncDays}d -in:spam -in:trash`, maxResults: 500, pageToken: page });
      r.ids.forEach((id) => ids.add(id));
      page = r.nextPageToken;
    } while (page && ids.size < o.initialSyncMaxThreads);
    // 3) drafts
    for (const d of await p.listDrafts()) if (d.threadId) ids.add(d.threadId);

    // drop local threads in the inbox that no longer are (archived elsewhere while we were offline)
    const localInbox = this.store.threadsWhere("account_id = ? AND in_inbox = 1", [accountId], 100_000).map((t) => t.id);
    for (const id of localInbox) if (!ids.has(id)) ids.add(id);

    await this.finishInitial(accountId, p, historyId, startedAt, [...ids]);
  }

  private async finishInitial(accountId: string, p: MailProvider, historyId: string, startedAt: number, ids: string[]): Promise<void> {
    const pendingKey = `initial-sync:${accountId}`;
    const failed: string[] = [];
    const doneIds = new Set<string>();
    this.progress.set(accountId, { done: 0, total: ids.length, doneIds });
    // checkpoint so a daemon restart resumes instead of starting over
    const checkpoint = () =>
      this.store.db.kvSet(pendingKey, JSON.stringify({ historyId, startedAt, remaining: ids.filter((id) => !doneIds.has(id)) }));
    checkpoint();
    const timer = setInterval(checkpoint, 5000);
    try {
      // metadata only: the list is complete fast; bodies load on open (see prefetchBodies / Iris.ensureBodies)
      await this.fetchAndSave(accountId, p, ids, false, failed, "metadata");
    } finally {
      clearInterval(timer);
      this.progress.delete(accountId);
    }
    if (failed.length) {
      this.store.db.kvSet(pendingKey, JSON.stringify({ historyId, startedAt, remaining: failed }));
      throw new Error(`Initial sync incomplete: ${failed.length} of ${ids.length} conversations still to fetch (will resume)`);
    }
    this.store.db.kvSet(pendingKey, "");
    this.store.setAccountSync(accountId, historyId);
    void inBackground(() => this.prefetchBodies(accountId)).catch(() => undefined);
  }

  /** Load full bodies for the newest inbox threads so opening them is instant. */
  async prefetchBodies(accountId: string, limit = 30): Promise<void> {
    const ids = this.store.db
      .all<{ thread_id: string }>(
        `SELECT DISTINCT m.thread_id FROM messages m JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
         WHERE m.account_id = ? AND m.body_loaded = 0 AND t.in_inbox = 1 ORDER BY t.last_date DESC LIMIT ?`,
        accountId,
        limit,
      )
      .map((r) => r.thread_id);
    if (ids.length) await this.fetchAndSave(accountId, this.provider(accountId), ids, false, [], "full");
  }


  /** Threads still to load per running backfill. */
  readonly backfillLeft = new Map<string, number>();

  /**
   * Load every thread Gmail has and the cache doesn't (All Mail shows the whole mailbox). Metadata only, no notifications,
   * nothing for the classifier. A rerun relists and only fetches what is still missing, so it resumes after a restart.
   */
  async backfill(accountId: string): Promise<void> {
    if (this.backfillLeft.has(accountId)) return;
    const key = `backfill:${accountId}`;
    this.store.db.kvSet(key, "running");
    this.backfillLeft.set(accountId, 0);
    const p = this.provider(accountId);
    try {
      const known = new Set(this.store.db.all<{ id: string }>("SELECT id FROM threads WHERE account_id = ?", accountId).map((r) => r.id));
      const ids: string[] = [];
      let page: string | undefined;
      do {
        const r = await p.listThreadIds({ q: "-in:spam -in:trash", maxResults: 500, pageToken: page });
        for (const id of r.ids) if (!known.has(id)) ids.push(id);
        page = r.nextPageToken;
      } while (page);
      const failed: string[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        this.backfillLeft.set(accountId, ids.length - i);
        await this.fetchAndSave(accountId, p, ids.slice(i, i + 200), false, failed, "metadata");
      }
      if (failed.length) throw new Error(`Backfill incomplete: ${failed.length} of ${ids.length} conversations failed (retries on the next start)`);
      this.store.db.kvSet(key, "done");
    } finally {
      this.backfillLeft.delete(accountId);
    }
  }

  /** Initial-sync progress per account (for status displays). */
  readonly progress = new Map<string, { done: number; total: number; doneIds?: Set<string> }>();

  private async incremental(accountId: string, p: MailProvider, since: string): Promise<boolean> {
    const h = await p.history(since);
    if (h === "expired") return false;
    const touched = new Set(h.changedThreadIds);
    if (h.deletedMessageIds.length) for (const t of this.store.deleteMessages(accountId, h.deletedMessageIds)) touched.add(t);
    // new mail → full bodies (notifications, AI, instant open); label-only changes → cheap metadata
    const added = new Set(h.addedThreadIds ?? [...touched]);
    const full = [...touched].filter((id) => added.has(id));
    const meta = [...touched].filter((id) => !added.has(id));
    if (full.length) await this.fetchAndSave(accountId, p, full);
    if (meta.length) await this.fetchAndSave(accountId, p, meta, true, undefined, "metadata");
    if (Date.now() - (this.lastLabelSync.get(accountId) ?? 0) > 10 * 60_000) await this.syncLabels(accountId, p);
    this.store.setAccountSync(accountId, h.historyId);
    return true;
  }

  /**
   * Fetch threads from the provider and persist. Returns the ids that changed.
   * One bad thread never aborts the rest: failures go to `failed` if given, otherwise the first error is rethrown at the end.
   */
  async fetchAndSave(
    accountId: string,
    p: MailProvider,
    threadIds: string[],
    notify = true,
    failed?: string[],
    format: "full" | "metadata" = "full",
  ): Promise<string[]> {
    const mine = this.myEmails(accountId);
    const fresh: Message[] = [];
    const changed: string[] = [];
    let firstError: unknown = null;
    const prog = this.progress.get(accountId);
    await pmap(threadIds, 4, async (id) => {
      try {
        const t = await p.getThread(id, format);
        const before = new Set(this.store.messages(accountId, id).map((m) => m.id));
        if (!t) {
          prog?.doneIds?.add(id);
          if (before.size) {
            this.store.deleteThread(accountId, id);
            changed.push(id);
          }
          return;
        }
        this.store.saveThread(accountId, id, t.messages, mine);
        changed.push(id);
        prog?.doneIds?.add(id);
        for (const m of t.messages) if (!before.has(m.id) && !m.isDraft) fresh.push(m);
      } catch (e) {
        failed?.push(id);
        firstError ??= e;
      } finally {
        if (prog) prog.done++;
        if (changed.length && changed.length % 100 === 0) this.bus.emitEvent({ type: "threads-changed", accountId, threadIds: changed.slice(-100) });
      }
    });
    if (changed.length) this.bus.emitEvent({ type: "threads-changed", accountId, threadIds: changed });
    if (notify && fresh.length && this.onNewMessages) await this.onNewMessages(accountId, fresh);
    if (firstError && !failed) throw firstError;
    return changed;
  }

  async refreshThread(accountId: string, threadId: string): Promise<void> {
    await this.fetchAndSave(accountId, this.provider(accountId), [threadId]);
  }
}
