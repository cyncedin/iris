// Gmail REST API provider (threads, messages, history, labels, batchModify, drafts).
import { b64urlDecode, b64urlEncode, parseGmailMessage, type GmailMessage } from "../mime.ts";
import { backgroundWork, ProviderError, type HistoryResult, type MailProvider, type ProviderDraft, type ProviderThread } from "../provider.ts";
import type { Label } from "../types.ts";
import { loadTokens, refreshAccessToken } from "./oauth.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gmail charges quota units per call. The per-user limit is project specific (observed: 6,000 units/min,
 * docs say up to 15,000). A token bucket keeps us at 80% of it and learns the real limit from 403 responses.
 */
export class QuotaLimiter {
  private tokens: number;
  private last = Date.now();
  private lastPenalty = 0;
  private lastIncrease = Date.now();
  rate: number;
  private maxRate: number;
  private readonly minRate: number;
  private readonly burst: number;
  private readonly name: string;
  constructor(unitsPerSecond = 80, burst = 400, minRate = 10, name = "gmail") {
    this.name = name;
    this.rate = unitsPerSecond;
    this.maxRate = unitsPerSecond;
    this.minRate = minRate;
    this.burst = burst;
    this.tokens = burst;
  }
  private refill(): void {
    const now = Date.now();
    // recover after a quiet period: +25% every 15s without quota errors
    if (this.rate < this.maxRate && now - this.lastPenalty > 15_000 && now - this.lastIncrease > 15_000) {
      this.rate = Math.min(this.maxRate, this.rate * 1.25);
      this.lastIncrease = now;
    }
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }
  /**
   * "high" (user-driven: open thread, send, actions) never waits; it borrows from the bucket.
   * "low" (sync, prefetch) waits until the bucket is positive again, so it absorbs the debt.
   */
  async take(units: number, priority: "high" | "low" = "low"): Promise<void> {
    const cost = Math.min(units, this.burst); // a call bigger than the bucket waits for a full bucket, never forever
    if (priority === "high") {
      this.refill();
      this.tokens -= cost;
      return;
    }
    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      await sleep(((cost - this.tokens) / this.rate) * 1000 + 5);
    }
  }
  /**
   * After a quota error: halve the rate (projects can have lower limits than the documented 15,000/min)
   * and drain the bucket so in-flight callers pause too.
   */
  penalize(seconds = 5): void {
    // concurrent requests fail together: halve at most once per 3s
    if (Date.now() - this.lastPenalty > 3000) {
      this.rate = Math.max(this.minRate, this.rate / 2);
      if (process.env.IRIS_QUIET !== "1") console.error(`[${this.name}] quota limit hit, pacing at ${Math.round(this.rate)} units/s`);
    }
    this.lastPenalty = Date.now();
    this.tokens = Math.min(this.tokens, 0) - this.rate * seconds;
  }
  /** Use the limit Google reports (quota_limit_value per minute) and stay at 80% of it. */
  learnLimit(unitsPerMinute: number): void {
    if (!(unitsPerMinute > 0)) return;
    this.maxRate = (unitsPerMinute / 60) * 0.8;
    this.rate = Math.min(this.rate, this.maxRate);
  }
  success(): void {
    /* recovery is time based, see refill() */
  }
}

/** Quota cost per call (https://developers.google.com/gmail/api/reference/quota). */
export function quotaCost(method: string, path: string): number {
  const p = path.split("?")[0];
  if (/\/messages\/send$|\/drafts\/send$/.test(p)) return 100;
  if (/\/batchModify$/.test(p)) return 50;
  if (/^\/history/.test(p)) return 2;
  if (/^\/(profile|labels)/.test(p) && method === "GET") return 1;
  // measured on a real account: format=full costs far more than the documented 10 units (≈100+), metadata is cheap
  if (/^\/threads\/[^/]+$/.test(p) && method === "GET") return /format=metadata/.test(path) ? 20 : 150;
  if (/^\/messages\/[^/]+$/.test(p) && method === "GET") return /format=(metadata|minimal)/.test(path) ? 10 : 50;
  if (/^\/threads/.test(p) || /\/(modify|trash|untrash)$/.test(p) || /^\/drafts/.test(p)) return 10;
  return 5;
}

export class GmailProvider implements MailProvider {
  readonly kind = "gmail" as const;
  private accessToken: string | null = null;
  private expiry = 0;
  private refreshing: Promise<void> | null = null;
  private readonly email: string;
  readonly limiter: QuotaLimiter;

  constructor(email: string, limiter = new QuotaLimiter(Number(process.env.IRIS_GMAIL_UNITS_PER_SEC) || 80, Number(process.env.IRIS_GMAIL_UNITS_PER_SEC) || 400)) {
    this.limiter = limiter;
    this.email = email;
    const t = loadTokens(email);
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
        })
        .finally(() => (this.refreshing = null));
    }
    await this.refreshing;
    return this.accessToken!;
  }

  private async req<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    await this.limiter.take(quotaCost(method, path), backgroundWork.getStore() ? "low" : "high");
    const token = await this.token();
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    const res = await fetch(url, {
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
      const quota = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|Quota exceeded|RESOURCE_EXHAUSTED/.test(text));
      if (quota && attempt < 8) {
        // per-minute windows: wait long enough for the window to roll over
        this.limiter.learnLimit(Number(text.match(/"quota_limit_value":\s*"(\d+)"/)?.[1]));
        this.limiter.penalize();
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
        await sleep(wait + Math.random() * 500);
        return this.req(method, path, body, attempt + 1);
      }
      if (res.status >= 500 && attempt < 5) {
        await sleep(Math.min(16_000, 500 * 2 ** attempt) + Math.random() * 300);
        return this.req(method, path, body, attempt + 1);
      }
      if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project/.test(text)) {
        const project = text.match(/project[ s/=]+(\d+)/)?.[1];
        throw new ProviderError(
          `The Gmail API is not enabled for your Google Cloud project. Enable it at https://console.cloud.google.com/apis/library/gmail.googleapis.com${project ? `?project=${project}` : ""}, wait a minute, then run: iris sync --full`,
          403,
        );
      }
      throw new ProviderError(`Gmail ${method} ${path.split("?")[0]} → ${res.status}: ${text.slice(0, 400)}`, res.status);
    }
    this.limiter.success();
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async profile() {
    const p = await this.req<{ emailAddress: string; historyId: string; threadsTotal?: number }>("GET", "/profile");
    return { email: p.emailAddress.toLowerCase(), historyId: p.historyId, threadsTotal: p.threadsTotal };
  }

  async listLabels(): Promise<Label[]> {
    const r = await this.req<{ labels: { id: string; name: string; type: string; color?: Label["color"]; messagesUnread?: number }[] }>(
      "GET",
      "/labels",
    );
    return (r.labels ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type === "system" ? "system" : "user",
      color: l.color ?? null,
      messagesUnread: l.messagesUnread,
    }));
  }

  async createLabel(name: string): Promise<Label> {
    const l = await this.req<{ id: string; name: string }>("POST", "/labels", {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    });
    return { id: l.id, name: l.name, type: "user" };
  }

  async deleteLabel(id: string) {
    try {
      await this.req("DELETE", `/labels/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 404)) throw e;
    }
  }

  async listThreadIds(opts: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string }) {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    for (const l of opts.labelIds ?? []) p.append("labelIds", l);
    p.set("maxResults", String(opts.maxResults ?? 100));
    if (opts.pageToken) p.set("pageToken", opts.pageToken);
    const r = await this.req<{ threads?: { id: string }[]; nextPageToken?: string }>("GET", `/threads?${p}`);
    return { ids: (r.threads ?? []).map((t) => t.id), nextPageToken: r.nextPageToken };
  }

  async getThread(id: string, format: "full" | "metadata" = "full"): Promise<ProviderThread | null> {
    try {
      const t = await this.req<{ id: string; historyId: string; messages?: GmailMessage[] }>("GET", `/threads/${id}?format=${format}`);
      return {
        id: t.id,
        historyId: t.historyId,
        messages: (t.messages ?? []).map((m) => parseGmailMessage(m, this.email, format)),
      };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async history(startHistoryId: string): Promise<HistoryResult | "expired"> {
    const changed = new Set<string>();
    const added = new Set<string>();
    const deleted: string[] = [];
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    try {
      do {
        const p = new URLSearchParams({ startHistoryId, maxResults: "500" });
        if (pageToken) p.set("pageToken", pageToken);
        const r = await this.req<{
          history?: {
            messages?: { id: string; threadId: string }[];
            messagesAdded?: { message: { id: string; threadId: string } }[];
            messagesDeleted?: { message: { id: string; threadId: string } }[];
          }[];
          historyId: string;
          nextPageToken?: string;
        }>("GET", `/history?${p}`);
        for (const h of r.history ?? []) {
          for (const m of h.messages ?? []) changed.add(m.threadId);
          for (const a of h.messagesAdded ?? []) added.add(a.message.threadId);
          for (const d of h.messagesDeleted ?? []) deleted.push(d.message.id);
        }
        historyId = r.historyId ?? historyId;
        pageToken = r.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return "expired";
      throw e;
    }
    return { historyId, changedThreadIds: [...changed], addedThreadIds: [...added], deletedMessageIds: deleted };
  }

  async modifyThread(id: string, add: string[], remove: string[]) {
    await this.req("POST", `/threads/${id}/modify`, { addLabelIds: add, removeLabelIds: remove });
  }

  async modifyMessages(ids: string[], add: string[], remove: string[]) {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.req("POST", `/messages/batchModify`, { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove });
    }
  }

  async trashThread(id: string) {
    await this.req("POST", `/threads/${id}/trash`);
  }

  async untrashThread(id: string) {
    await this.req("POST", `/threads/${id}/untrash`);
  }

  async send(raw: Buffer, threadId?: string) {
    const r = await this.req<{ id: string; threadId: string }>("POST", `/messages/send`, {
      raw: b64urlEncode(raw),
      ...(threadId ? { threadId } : {}),
    });
    return { id: r.id, threadId: r.threadId };
  }

  private mapDraft(d: { id: string; message: { id: string; threadId: string } }): ProviderDraft {
    return { draftId: d.id, messageId: d.message.id, threadId: d.message.threadId };
  }

  async createDraft(raw: Buffer, threadId?: string) {
    const d = await this.req<{ id: string; message: { id: string; threadId: string } }>("POST", `/drafts`, {
      message: { raw: b64urlEncode(raw), ...(threadId ? { threadId } : {}) },
    });
    return this.mapDraft(d);
  }

  async updateDraft(draftId: string, raw: Buffer, threadId?: string) {
    const d = await this.req<{ id: string; message: { id: string; threadId: string } }>("PUT", `/drafts/${draftId}`, {
      id: draftId,
      message: { raw: b64urlEncode(raw), ...(threadId ? { threadId } : {}) },
    });
    return this.mapDraft(d);
  }

  async deleteDraft(draftId: string) {
    try {
      await this.req("DELETE", `/drafts/${draftId}`);
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 404)) throw e;
    }
  }

  async sendDraft(draftId: string) {
    const r = await this.req<{ id: string; threadId: string }>("POST", `/drafts/send`, { id: draftId });
    return { id: r.id, threadId: r.threadId };
  }

  async listDrafts() {
    const out: ProviderDraft[] = [];
    let pageToken: string | undefined;
    do {
      const p = new URLSearchParams({ maxResults: "200" });
      if (pageToken) p.set("pageToken", pageToken);
      const r = await this.req<{ drafts?: { id: string; message: { id: string; threadId: string } }[]; nextPageToken?: string }>(
        "GET",
        `/drafts?${p}`,
      );
      out.push(...(r.drafts ?? []).map((d) => this.mapDraft(d)));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const r = await this.req<{ data: string }>("GET", `/messages/${messageId}/attachments/${attachmentId}`);
    return b64urlDecode(r.data);
  }

  async getRawMessage(messageId: string) {
    const r = await this.req<{ raw: string }>("GET", `/messages/${messageId}?format=raw`);
    return b64urlDecode(r.raw);
  }

  async listFilters() {
    const r = await this.req<{ filter?: { id: string; criteria: Record<string, unknown>; action: { addLabelIds?: string[]; removeLabelIds?: string[] } }[] }>("GET", "/settings/filters");
    return r.filter ?? [];
  }

  async createFilter(criteria: { from?: string }, action: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
    await this.req("POST", `/settings/filters`, { criteria, action });
  }

  async sendAsSignature() {
    const r = await this.req<{ sendAs: { sendAsEmail: string; displayName?: string; signature?: string; isPrimary?: boolean }[] }>(
      "GET",
      `/settings/sendAs`,
    );
    const p = r.sendAs?.find((s) => s.isPrimary) ?? r.sendAs?.[0];
    return p ? { name: p.displayName ?? "", signature: p.signature ?? "" } : null;
  }
}
