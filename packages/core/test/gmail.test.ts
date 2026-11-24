// The real GmailProvider + sync engine against an in-memory emulation of the Gmail REST API and Google's token endpoint.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "iris-gmail-"));
process.env.IRIS_HOME = HOME;
process.env.IRIS_SECRETS = "file";
process.env.IRIS_GOOGLE_CLIENT_ID = "test-client";
process.env.IRIS_GOOGLE_CLIENT_SECRET = "test-secret";
process.env.IRIS_GMAIL_UNITS_PER_SEC = "100000"; // emulator has no quota; keep tests fast
process.env.IRIS_QUIET = "1";

const { Iris } = await import("../src/service.ts");
const { saveTokens } = await import("../src/gmail/oauth.ts");

const ME = "me@gmail.test";
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

interface GMsg {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string;
  snippet: string;
  payload: Record<string, unknown>;
}

/** Minimal Gmail API: the endpoints and semantics Iris relies on. */
class GmailEmulator {
  messages = new Map<string, GMsg>();
  history: { id: number; messages: { id: string; threadId: string }[]; messagesAdded?: { message: { id: string; threadId: string } }[] }[] = [];
  formats: string[] = [];
  historyId = 5000;
  drafts = new Map<string, string>();
  seq = 1;
  calls: string[] = [];
  refreshes = 0;
  rejectTokenOnce: string | null = null;
  disabled = false;
  rateLimitOnce = false;
  expireHistory = false;
  pageSize = 3;
  failThreadOnce: string | null = null;
  tokenN = 0;

  addMessage(o: { threadId?: string; from: string; to?: string; subject: string; text: string; html?: string; labels?: string[]; ago?: number; attachment?: string; listId?: string }): GMsg {
    const id = `m${(this.seq++).toString(16).padStart(6, "0")}`;
    const threadId = o.threadId ?? `t${id.slice(1)}`;
    const headers = [
      { name: "From", value: o.from },
      { name: "To", value: o.to ?? ME },
      { name: "Subject", value: o.subject },
      { name: "Date", value: new Date(Date.now() - (o.ago ?? 0)).toUTCString() },
      { name: "Message-ID", value: `<${id}@mail.test>` },
      ...(o.listId ? [{ name: "List-Id", value: o.listId }, { name: "List-Unsubscribe", value: "<https://unsub.test/x>" }] : []),
    ];
    const alt = {
      mimeType: "multipart/alternative",
      parts: [
        { partId: "0.0", mimeType: "text/plain", body: { data: b64(o.text), size: o.text.length } },
        { partId: "0.1", mimeType: "text/html", body: { data: b64(o.html ?? `<p>${o.text}</p>`), size: 10 } },
      ],
    };
    const payload = o.attachment
      ? { mimeType: "multipart/mixed", headers, parts: [alt, { partId: "1", mimeType: "application/pdf", filename: o.attachment, body: { attachmentId: `att_${id}`, size: 2048 } }] }
      : { ...alt, headers };
    const m: GMsg = { id, threadId, labelIds: o.labels ?? ["INBOX", "UNREAD"], internalDate: String(Date.now() - (o.ago ?? 0)), snippet: o.text.slice(0, 80), payload };
    this.messages.set(id, m);
    this.history.push({ id: ++this.historyId, messages: [{ id, threadId }], messagesAdded: [{ message: { id, threadId } }] });
    return m;
  }

  record(m: { id: string; threadId: string }) {
    this.history.push({ id: ++this.historyId, messages: [{ id: m.id, threadId: m.threadId }] });
  }

  threadMsgs(tid: string) {
    return [...this.messages.values()].filter((m) => m.threadId === tid).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  }

  json(data: unknown, status = 200) {
    return new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (typeof init.body === "string" ? init.body : String(init.body)) : "";
    if (url.hostname === "oauth2.googleapis.com") {
      const p = new URLSearchParams(body);
      assert.equal(p.get("grant_type"), "refresh_token");
      assert.equal(p.get("client_id"), "test-client");
      this.refreshes++;
      return this.json({ access_token: `tok${++this.tokenN}`, expires_in: 3600 });
    }
    assert.equal(url.hostname, "gmail.googleapis.com", `unexpected host ${url.hostname}`);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (this.rejectTokenOnce && auth === `Bearer ${this.rejectTokenOnce}`) {
      this.rejectTokenOnce = null;
      return this.json({ error: { code: 401 } }, 401);
    }
    if (!/^Bearer tok\d+$/.test(auth)) return this.json({ error: { code: 401 } }, 401);
    const p = url.pathname.replace("/gmail/v1/users/me", "");
    this.calls.push(`${method} ${p}`);
    if (this.disabled)
      return this.json({ error: { code: 403, message: "Gmail API has not been used in project 499322712571 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }, 403);
    if (this.rateLimitOnce) {
      this.rateLimitOnce = false;
      return this.json({ error: { code: 429, message: "rateLimitExceeded", details: [{ metadata: { quota_limit_value: "6000" } }] } }, 429);
    }
    const parsed = body ? JSON.parse(body) : {};
    let m: RegExpMatchArray | null;
    if (p === "/profile") return this.json({ emailAddress: ME, historyId: String(this.historyId) });
    if (p === "/labels" && method === "GET")
      return this.json({ labels: ["INBOX", "SENT", "DRAFT", "STARRED", "IMPORTANT", "UNREAD", "SPAM", "TRASH"].map((id) => ({ id, name: id, type: "system" })).concat([{ id: "Label_1", name: "Clients", type: "user" }]) });
    if (p === "/labels" && method === "POST") return this.json({ id: `Label_${this.seq++}`, name: parsed.name });
    if (p === "/threads" && method === "GET") {
      const labelIds = url.searchParams.getAll("labelIds");
      const q = url.searchParams.get("q") ?? "";
      const tids = new Map<string, number>();
      for (const msg of this.messages.values()) {
        if (labelIds.length && !labelIds.every((l) => msg.labelIds.includes(l))) continue;
        if (!q.includes("in:trash") && (msg.labelIds.includes("TRASH") || msg.labelIds.includes("SPAM"))) continue;
        const words = q.split(/\s+/).filter((w) => w && !w.includes(":"));
        const hay = JSON.stringify(msg.payload).toLowerCase();
        if (words.some((w) => !hay.includes(w.toLowerCase()))) continue;
        tids.set(msg.threadId, Math.max(tids.get(msg.threadId) ?? 0, Number(msg.internalDate)));
      }
      const all = [...tids.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => ({ id }));
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const page = all.slice(start, start + this.pageSize);
      return this.json({ threads: page, nextPageToken: start + this.pageSize < all.length ? String(start + this.pageSize) : undefined });
    }
    if ((m = p.match(/^\/threads\/([^/]+)$/)) && method === "GET" && this.failThreadOnce === m[1]) {
      this.failThreadOnce = null;
      return this.json({ error: { code: 400, message: "emulated failure" } }, 400);
    }
    if ((m = p.match(/^\/threads\/([^/]+)$/)) && method === "GET") {
      const msgs = this.threadMsgs(m[1]);
      if (!msgs.length) return this.json({ error: { code: 404 } }, 404);
      const format = url.searchParams.get("format") ?? "full";
      this.formats.push(format);
      if (format === "metadata") {
        const meta = msgs.map((x) => ({ ...x, payload: { mimeType: x.payload.mimeType, headers: (x.payload.headers as unknown[]) ?? [] } }));
        return this.json({ id: m[1], historyId: String(this.historyId), messages: meta });
      }
      assert.equal(format, "full");
      return this.json({ id: m[1], historyId: String(this.historyId), messages: msgs });
    }
    if ((m = p.match(/^\/threads\/([^/]+)\/modify$/))) {
      for (const msg of this.threadMsgs(m[1])) {
        msg.labelIds = [...new Set([...msg.labelIds, ...(parsed.addLabelIds ?? [])])].filter((l) => !(parsed.removeLabelIds ?? []).includes(l));
        this.record(msg);
      }
      return this.json({ id: m[1] });
    }
    if ((m = p.match(/^\/threads\/([^/]+)\/(trash|untrash)$/))) {
      for (const msg of this.threadMsgs(m[1])) {
        msg.labelIds = m[2] === "trash" ? [...msg.labelIds.filter((l) => l !== "INBOX"), "TRASH"] : msg.labelIds.filter((l) => l !== "TRASH");
        this.record(msg);
      }
      return this.json({ id: m[1] });
    }
    if (p === "/history") {
      if (this.expireHistory) return this.json({ error: { code: 404 } }, 404);
      const since = Number(url.searchParams.get("startHistoryId"));
      return this.json({ history: this.history.filter((h) => h.id > since), historyId: String(this.historyId) });
    }
    if (p === "/messages/send") {
      const raw = Buffer.from(parsed.raw, "base64url").toString();
      const subject = raw.match(/^Subject: (.*)$/m)?.[1] ?? "";
      const sent = this.addMessage({ threadId: parsed.threadId, from: `Me <${ME}>`, to: raw.match(/^To: (.*)$/m)?.[1] ?? "", subject, text: raw.split(/\r?\n\r?\n/).slice(1).join("\n"), labels: ["SENT"] });
      (sent as GMsg & { raw?: string }).raw = raw;
      return this.json({ id: sent.id, threadId: sent.threadId });
    }
    if (p === "/drafts" && method === "GET") return this.json({ drafts: [...this.drafts].map(([id, mid]) => ({ id, message: { id: mid, threadId: this.messages.get(mid)!.threadId } })) });
    if (p === "/drafts" && method === "POST") {
      const raw = Buffer.from(parsed.message.raw, "base64url").toString();
      const d = this.addMessage({ threadId: parsed.message.threadId, from: ME, subject: raw.match(/^Subject: (.*)$/m)?.[1] ?? "", text: "draft", labels: ["DRAFT"] });
      const id = `r${this.seq++}`;
      this.drafts.set(id, d.id);
      return this.json({ id, message: { id: d.id, threadId: d.threadId } });
    }
    if ((m = p.match(/^\/drafts\/([^/]+)$/)) && method === "DELETE") {
      const mid = this.drafts.get(m[1]);
      if (!mid) return this.json({ error: { code: 404 } }, 404);
      this.drafts.delete(m[1]);
      const msg = this.messages.get(mid)!;
      this.messages.delete(mid);
      this.record(msg);
      return new Response(null, { status: 204 });
    }
    if ((m = p.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/))) return this.json({ data: b64("%PDF-1.4 test"), size: 13 });
    if (p === "/settings/sendAs") return this.json({ sendAs: [{ sendAsEmail: ME, displayName: "Me Test", signature: "<b>Me</b> · Iris", isPrimary: true }] });
    if (p === "/settings/filters") return this.json({ id: "f1" });
    return this.json({ error: { code: 404, message: `emulator: no route ${method} ${p}` } }, 404);
  }
}

const gmail = new GmailEmulator();
const realFetch = globalThis.fetch;
let iris: InstanceType<typeof Iris>;

before(async () => {
  globalThis.fetch = ((i: string | URL | Request, init?: RequestInit) => gmail.fetch(i, init)) as typeof fetch;
  const H = 3600_000;
  gmail.addMessage({ from: "Anna Weber <anna@acme.test>", subject: "Pilot timeline", text: "Can we start on Nov 18?", labels: ["INBOX", "UNREAD", "IMPORTANT"], ago: 2 * H });
  gmail.addMessage({ from: "Bank <noreply@bank.test>", subject: "Statement", text: "Your statement is ready", attachment: "statement.pdf", ago: 3 * H });
  gmail.addMessage({ from: "News <news@list.test>", subject: "Weekly digest", text: "Top stories", listId: "<digest.list.test>", ago: 4 * H });
  gmail.addMessage({ from: "Old <old@x.test>", subject: "Archived thing", text: "old", labels: [], ago: 5 * H });
  gmail.addMessage({ from: "Jonas <jonas@partner.test>", subject: "Pricing", text: "What does 50k cases cost?", labels: ["INBOX"], ago: 6 * H });
  saveTokens(ME, { refresh_token: "refresh-1" }); // no access token yet → first call refreshes
  iris = new Iris({ home: path.join(HOME, "data") });
  iris.store.upsertAccount({ id: ME, email: ME, name: "Me Test", provider: "gmail" });
  iris.settings.undoSendSeconds = 0;
});

after(() => {
  globalThis.fetch = realFetch;
  iris?.close();
});

test("initial sync: token refresh, pagination, parsing, splits", async () => {
  await iris.sync.sync(ME, true);
  assert.ok(gmail.formats.length >= 5 && gmail.formats.slice(0, 5).every((f) => f === "metadata"), "initial sync fetches metadata only");
  await new Promise((r) => setTimeout(r, 300)); // background body prefetch for the newest inbox threads
  assert.ok(gmail.formats.includes("full"), "prefetched bodies for inbox threads");
  assert.equal(gmail.refreshes, 1, "refreshed the access token once");
  const inbox = iris.list({ accountId: ME, view: "inbox" });
  assert.equal(inbox.total, 4, "INBOX threads across 2 pages (page size 3)");
  assert.ok(gmail.calls.filter((c) => c === "GET /threads").length >= 2, "followed nextPageToken");
  const all = iris.list({ accountId: ME, view: "all" });
  assert.equal(all.total, 5, "recent archived mail synced too");
  const bank = inbox.threads.find((t) => t.subject === "Statement")!;
  assert.ok(bank.hasAttachments);
  const t = await iris.thread(ME, bank.id);
  assert.equal(t!.messages[0].attachments[0].filename, "statement.pdf");
  assert.match(t!.messages[0].bodyHtml, /<p>Your statement is ready<\/p>/, "prefers text/html part");
  assert.equal(t!.messages[0].bodyText, "Your statement is ready");
  const att = await iris.attachment(ME, t!.messages[0].id, t!.messages[0].attachments[0].id);
  assert.match(att.data.toString(), /^%PDF/);
  iris.ensureDefaultSplits(ME);
  const splits = iris.splitsWithCounts(ME);
  assert.equal(splits.find((s) => s.builtin === "important")!.count, 1);
  assert.equal(iris.searchLocal(ME, "list:*").length, 1);
});

test("lazy bodies: metadata refresh keeps bodies, ensureBodies loads on demand", async () => {
  const archived = iris.list({ accountId: ME, view: "all" }).threads.find((t) => t.subject === "Archived thing")!;
  assert.ok(iris.store.messages(ME, archived.id).every((m) => m.bodyLoaded === false), "archived thread not prefetched");
  assert.ok(iris.searchLocal(ME, "archived").length >= 1, "metadata is searchable");
  const t = await iris.thread(ME, archived.id);
  assert.equal(t!.messages[0].bodyText, "old", "body fetched on open");
  // a label-only change re-syncs as metadata but must not drop the body
  await iris.sync.fetchAndSave(ME, iris.provider(ME), [archived.id], false, undefined, "metadata");
  assert.equal(iris.store.messages(ME, archived.id)[0].bodyText, "old");
  const bank = iris.list({ accountId: ME, view: "inbox" }).threads.find((x) => x.subject === "Statement")!;
  assert.ok(bank.hasAttachments, "attachment flag known before bodies load");
});

test("401 → refresh → retry", async () => {
  gmail.rejectTokenOnce = `tok${gmail.tokenN}`;
  const before = gmail.refreshes;
  const r = await iris.provider(ME).profile();
  assert.equal(r.email, ME);
  assert.equal(gmail.refreshes, before + 1);
});

test("429 is retried with backoff", async () => {
  gmail.rateLimitOnce = true;
  const labels = await iris.provider(ME).listLabels();
  assert.ok(labels.some((l) => l.name === "Clients"));
});

test("mark done / undo hit threads.modify; incremental sync picks up new mail", async () => {
  const anna = iris.list({ accountId: ME, view: "inbox", q: "pilot" }).threads[0];
  const r = iris.markDone(ME, [anna.id]);
  await iris.flush(ME);
  assert.ok(!gmail.threadMsgs(anna.id).some((m) => m.labelIds.includes("INBOX")), "INBOX removed in Gmail");
  iris.undo(r.undoId);
  await iris.flush(ME);
  assert.ok(gmail.threadMsgs(anna.id).every((m) => m.labelIds.includes("INBOX")), "undo restored INBOX in Gmail");

  const events: string[] = [];
  const off = iris.bus.onEvent((e) => e.type === "notification" && events.push((e.data as { title: string }).title));
  gmail.addMessage({ threadId: anna.id, from: "Anna Weber <anna@acme.test>", subject: "Re: Pilot timeline", text: "Also: on-prem?" });
  gmail.addMessage({ from: "New Person <new@x.test>", subject: "Hello", text: "Nice to meet you" });
  await iris.sync.sync(ME);
  off();
  const inbox = iris.list({ accountId: ME, view: "inbox" });
  assert.ok(inbox.threads.some((t) => t.subject === "Hello"));
  assert.equal(inbox.threads.find((t) => t.id === anna.id)!.messageCount, 2);
  assert.deepEqual(events.sort(), ["Anna Weber", "New Person"]);
});

test("reply goes out threaded via messages.send; drafts round-trip", async () => {
  const anna = iris.list({ accountId: ME, view: "inbox", q: "pilot" }).threads[0];
  const draft = iris.replyDraft(ME, anna.id, "replyAll");
  const saved = await iris.saveDraft({ ...draft, html: "<p>Yes, Nov 18.</p>" });
  assert.ok(gmail.drafts.has(saved.draftId));
  const item = iris.send({ ...draft, html: "<p>Yes, Nov 18.</p>", draftId: saved.draftId }, { instant: true });
  await iris.processOutbox();
  assert.equal(iris.outboxItem(item.id)!.status, "sent");
  assert.ok(!gmail.drafts.has(saved.draftId), "draft deleted after send");
  const sent = [...gmail.messages.values()].find((m) => m.labelIds.includes("SENT") && m.threadId === anna.id) as GMsg & { raw: string };
  assert.ok(sent, "sent into the same Gmail thread");
  assert.match(sent.raw, /^In-Reply-To: <m[0-9a-f]+@mail\.test>/m);
  assert.match(sent.raw, /^To: .*anna@acme\.test/m);
  assert.match(sent.raw, /data-iris-signature><b>Me<\/b>/, "Gmail signature (from settings/sendAs) appended");
  const t = await iris.thread(ME, anna.id);
  assert.ok(t!.messages.some((m) => m.isSent));
});

test("expired history id falls back to a full resync", async () => {
  gmail.expireHistory = true;
  gmail.addMessage({ from: "Late <late@x.test>", subject: "After expiry", text: "hi" });
  await iris.sync.sync(ME);
  gmail.expireHistory = false;
  assert.ok(iris.list({ accountId: ME, view: "inbox" }).threads.some((t) => t.subject === "After expiry"));
});

test("an interrupted initial sync resumes with only the missing threads", async () => {
  const anna = iris.list({ accountId: ME, view: "inbox", q: "pilot" }).threads[0];
  iris.db.run("UPDATE accounts SET history_id = NULL WHERE id = ?", ME);
  gmail.failThreadOnce = anna.id;
  await assert.rejects(iris.sync.sync(ME), /Initial sync incomplete: 1 of \d+/);
  assert.ok(iris.list({ accountId: ME, view: "inbox" }).total >= 5, "everything else was saved");
  const n = gmail.calls.length;
  await iris.sync.sync(ME);
  const resumed = gmail.calls.slice(n).filter((c) => c.startsWith("GET /threads/"));
  assert.deepEqual(resumed, [`GET /threads/${anna.id}`], "resume fetched only the failed thread");
  assert.ok(iris.store.account(ME)!.historyId, "history id set after resume");
});

test("quota limiter paces calls", async () => {
  const { QuotaLimiter, quotaCost } = await import("../src/gmail/client.ts");
  assert.equal(quotaCost("GET", "/threads/abc?format=full"), 150);
  assert.equal(quotaCost("GET", "/threads/abc?format=metadata"), 20);
  assert.equal(quotaCost("POST", "/messages/send"), 100);
  assert.equal(quotaCost("GET", "/history?startHistoryId=1"), 2);
  const l = new QuotaLimiter(1000, 100);
  const t0 = Date.now();
  await l.take(100); // burst
  await l.take(100);
  await l.take(100);
  const dt = Date.now() - t0;
  assert.ok(dt >= 180 && dt < 600, `waited ${dt}ms for 200 extra units at 1000/s`);
  const t1 = Date.now();
  await l.take(5000); // bigger than the bucket: waits for a full bucket instead of forever
  assert.ok(Date.now() - t1 < 400);
  const t2 = Date.now();
  await l.take(100, "high"); // user-driven calls never wait
  assert.ok(Date.now() - t2 < 20);
});

test("disabled Gmail API gives an actionable error", async () => {
  gmail.disabled = true;
  await assert.rejects(iris.provider(ME).profile(), /Gmail API is not enabled.*console\.cloud\.google\.com.*project=499322712571/);
  gmail.disabled = false;
});
