// Iris daemon: local HTTP API (REST + SSE) for the web UI, the CLI and the MCP server.
// Binds to 127.0.0.1 only, checks the Host header (DNS rebinding) and requires the local API token.
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  AIUnavailableError,
  Iris,
  IrisAI,
  apiToken,
  attendeeEmails,
  deleteSecret,
  NotImplementedError,
  renderAvailabilityText,
  getClient,
  guests,
  irisHome,
  setSecret,
  openRouterApiKey,
  type DraftInput,
  type EventInput,
  type RecurrenceScope,
  type GoalKind,
  type IrisEvent,
  type IrisSettings,
  type ListQuery,
  type ResearchNameSource,
  type ThreadRef,
  type ViewName,
} from "@iris/core";
import { daemonHome, daemonInfoPath, type DaemonInfo } from "./client.ts";

export interface AppContext {
  iris: Iris;
  ai: IrisAI;
  token: string;
  port: number;
  webDir?: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const WEB_DIR = path.resolve(import.meta.dirname, "../../web/dist");
const REPO = path.resolve(import.meta.dirname, "../../..");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// Attachment types that are safe to show inline (no script execution possible).
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|heic|bmp)|application\/pdf|text\/plain|audio\/|video\/)/i;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function body<T = Record<string, unknown>>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function ids(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out = list.map((x) => String(x).trim()).filter(Boolean);
  if (!out.length) throw new HttpError(400, "threadIds required");
  return out;
}

/** `refs: [{ account, threadId }]` (cross-account actions). */
function refList(v: unknown): ThreadRef[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, "refs must be a non-empty array of { account, threadId }");
  return v.map((r) => {
    const x = (r ?? {}) as Record<string, unknown>;
    if (typeof x.threadId !== "string" || !x.threadId) throw new HttpError(400, "every ref needs a threadId");
    const account = typeof x.account === "string" && x.account ? x.account : typeof x.accountId === "string" && x.accountId ? x.accountId : undefined;
    return { account, threadId: x.threadId };
  });
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Callers other than the Iris UI are treated as agents (CLI, MCP, scripts). Cooperative policy, not a sandbox. */
function isAgent(c: Context): boolean {
  const who = (c.req.header("x-iris-client") ?? "agent").toLowerCase();
  return who !== "ui" && who !== "cli-human";
}

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

interface PendingLogin {
  status: "pending" | "done" | "error";
  url?: string;
  email?: string;
  error?: string;
}

export function createApp(ctx: AppContext): Hono {
  const { iris, ai, token } = ctx;
  const webDir = ctx.webDir ?? WEB_DIR;
  const app = new Hono();
  // ctx.port is read per request so the server can bind to port 0 and fill it in afterwards
  const allowedHost = (h: string) => [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`, `[::1]:${ctx.port}`].includes(h);
  const logins = new Map<string, PendingLogin>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof AIUnavailableError) return c.json({ error: err.message, code: "ai_unavailable" }, 503);
    if (err instanceof NotImplementedError) return c.json({ error: err.message, code: "not_implemented" }, 501);
    const message = err instanceof Error ? err.message : String(err);
    if (/^Calendar access not granted/.test(message)) return c.json({ error: message, code: "calendar_scope" }, 403);
    if (/Google Calendar API is not enabled/.test(message)) return c.json({ error: message, code: "calendar_disabled" }, 403);
    const status = /^(Unknown|No account|Thread not found|Unknown snippet)/.test(message) ? 404 : 400;
    return c.json({ error: message }, status);
  });

  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (host && !allowedHost(host)) return c.text("Forbidden host", 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const t = c.req.header("x-iris-token") ?? (c.req.method === "GET" ? c.req.query("token") : undefined);
    if (!t || !safeEqual(t, token)) return c.json({ error: "unauthorized" }, 401);
    c.header("Cache-Control", "no-store");
    await next();
  });

  const acct = (c: Context) => c.req.query("account") || undefined;

  // ------------------------------------------------------------ status / settings / accounts

  app.get("/api/status", (c) => c.json({ ...iris.status(), ai: { available: ai.available(), model: ai.model }, pid: process.pid, home: iris.home, repo: REPO, node: process.execPath }));

  app.get("/api/settings", (c) => c.json(iris.settings));
  app.patch("/api/settings", async (c) => {
    const patch = await body<Partial<IrisSettings>>(c);
    if (patch.agent && isAgent(c)) throw new HttpError(403, "Agent permissions can only be changed in the Iris app (Settings) or with `iris agent allow-send` in a terminal.");
    const s = iris.updateSettings(patch);
    if (patch.ai) ai.resetClient();
    return c.json(s);
  });

  app.get("/api/accounts", (c) => c.json(iris.accountInfos()));

  // sidebar: counts for All Inboxes and every account
  app.get("/api/mailboxes", (c) => c.json(iris.mailboxes()));

  app.post("/api/accounts/gmail", async (c) => {
    if (!getClient()) throw new HttpError(400, "No Google OAuth client configured. Run: iris auth client <client_secret.json>");
    const { loginHint } = await body<{ loginHint?: string }>(c);
    const id = crypto.randomUUID();
    const state: PendingLogin = { status: "pending" };
    logins.set(id, state);
    const url = await new Promise<string>((resolve, reject) => {
      iris
        .addGmailAccount((u) => {
          state.url = u;
          resolve(u);
        }, loginHint)
        .then((a) => {
          state.status = "done";
          state.email = a.email;
        })
        .catch((e: Error) => {
          state.status = "error";
          state.error = e.message;
          reject(e);
          iris.bus.emitEvent({ type: "error", data: { where: "login", message: e.message } });
        });
    });
    return c.json({ loginId: id, url });
  });

  app.get("/api/accounts/login/:id", (c) => {
    const s = logins.get(c.req.param("id"));
    if (!s) throw new HttpError(404, "Unknown login");
    return c.json(s);
  });

  app.delete("/api/accounts/:id", (c) => {
    iris.removeAccount(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/sync", async (c) => {
    const b = await body<{ account?: string; full?: boolean }>(c);
    const accounts = b.account ? [iris.acct(b.account)] : iris.accounts().map((a) => a.id);
    await Promise.all(accounts.map((a) => iris.sync.sync(a, !!b.full)));
    return c.json({ ok: true, accounts });
  });

  // ------------------------------------------------------------ labels / splits

  app.get("/api/labels", (c) => c.json(iris.labels(iris.acct(acct(c)))));

  app.get("/api/splits", (c) => c.json(iris.splitsWithCounts(acct(c))));
  app.post("/api/splits", async (c) => {
    const b = await body<{ name: string; query: string; leaveInImportantOther?: boolean; position?: number }>(c);
    if (!b.name || !b.query) throw new HttpError(400, "name and query required");
    return c.json(iris.createSplit(iris.acct(acct(c)), b));
  });
  app.patch("/api/splits/:id", async (c) => {
    const s = iris.updateSplit(iris.acct(acct(c)), c.req.param("id"), await body(c));
    if (!s) throw new HttpError(404, "Unknown split");
    return c.json(s);
  });
  app.delete("/api/splits/:id", (c) => {
    iris.deleteSplit(iris.acct(acct(c)), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ threads / search

  app.get("/api/threads", (c) => {
    const q = c.req.query();
    const query: ListQuery = {
      accountId: q.account || undefined,
      view: (q.view as ViewName) || "inbox",
      splitId: q.split || undefined,
      labelId: q.label || undefined,
      q: q.q || undefined,
      filter: (q.filter as ListQuery["filter"]) || null,
      hideLabels: q.hideLabels ? q.hideLabels.split("\n") : undefined,
      hideUnlabeled: q.hideUnlabeled === "1",
      limit: num(q.limit),
      offset: num(q.offset),
    };
    return c.json(iris.list(query));
  });

  app.get("/api/mailbox/labels", (c) => c.json(iris.mailboxLabels(acct(c))));
  app.get("/api/mailbox/coverage", async (c) => c.json(await iris.mailboxCoverage(acct(c))));
  app.post("/api/mailbox/backfill", async (c) => {
    const b = await body<{ account?: string }>(c);
    iris.loadWholeMailbox(b.account);
    return c.json({ ok: true });
  });

  app.get("/api/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const remote = c.req.query("remote") !== "0";
    return c.json(await iris.search(acct(c), q, { remote, limit: num(c.req.query("limit")) }));
  });

  app.get("/api/threads/:id", async (c) => {
    const t = await iris.thread(acct(c), c.req.param("id"));
    if (!t) throw new HttpError(404, "Thread not found");
    return c.json(t);
  });

  app.get("/api/messages/:id/raw", async (c) => {
    const raw = await iris.rawMessage(acct(c), c.req.param("id"));
    c.header("Content-Security-Policy", "sandbox");
    return c.text(raw);
  });

  app.get("/api/attachments/:messageId/:attachmentId", async (c) => {
    const a = await iris.attachment(acct(c), c.req.param("messageId"), decodeURIComponent(c.req.param("attachmentId")));
    const inline = c.req.query("download") !== "1" && INLINE_SAFE.test(a.mimeType);
    return new Response(new Uint8Array(a.data), {
      headers: {
        "Content-Type": inline ? a.mimeType : "application/octet-stream",
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", a.filename),
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  // ------------------------------------------------------------ actions (optimistic, undoable)

  type Act = (account: string | undefined, threadIds: string[], b: Record<string, unknown>) => unknown;
  const label = (b: Record<string, unknown>) => {
    if (typeof b.label !== "string" || !b.label) throw new HttpError(400, "label required");
    return b.label;
  };
  const actions: Record<string, Act> = {
    done: (a, t) => iris.markDone(a, t),
    archive: (a, t) => iris.markDone(a, t),
    undone: (a, t) => iris.markNotDone(a, t),
    inbox: (a, t) => iris.markNotDone(a, t),
    star: (a, t) => iris.star(a, t, true),
    unstar: (a, t) => iris.star(a, t, false),
    toggleStar: (a, t) => iris.toggleStar(a, t),
    read: (a, t) => iris.markRead(a, t, true),
    unread: (a, t) => iris.markUnread(a, t),
    toggleRead: (a, t) => iris.toggleRead(a, t),
    important: (a, t) => iris.markImportant(a, t, true),
    unimportant: (a, t) => iris.markImportant(a, t, false),
    spam: (a, t) => iris.spam(a, t, true),
    notSpam: (a, t) => iris.spam(a, t, false),
    trash: (a, t) => iris.trash(a, t),
    untrash: (a, t) => iris.untrash(a, t),
    addLabel: (a, t, b) => iris.addLabel(a, t, label(b)),
    removeLabel: (a, t, b) => iris.removeLabel(a, t, label(b)),
    removeAllLabels: (a, t) => iris.removeAllLabels(a, t),
    move: (a, t, b) => iris.move(a, t, label(b)),
    mute: (a, t) => iris.mute(a, t, true),
    unmute: (a, t) => iris.mute(a, t, false),
    cancelReminder: (a, t) => iris.cancelReminder(a, t),
  };

  app.post("/api/actions/:action", async (c) => {
    const name = c.req.param("action");
    const fn = actions[name];
    if (!fn) throw new HttpError(404, `Unknown action: ${name}. Known: ${Object.keys(actions).join(", ")}`);
    const b = await body<Record<string, unknown>>(c);
    if (b.refs !== undefined) {
      // threads of several accounts: grouped per account, ONE undo entry for all of them
      const groups = iris.groupRefs(refList(b.refs));
      const act = name === "toggleStar" ? (iris.allStarred(groups) ? "unstar" : "star") : name === "toggleRead" ? (iris.anyUnread(groups) ? "read" : "unread") : name;
      const result = await iris.forGroups(groups, async (a, t) => (await actions[act](a, t, b)) as { count?: number; undoId?: string; description?: string });
      if (b.wait) await iris.flush();
      return c.json(result);
    }
    const account = (b.account as string | undefined) ?? acct(c);
    const result = await fn(account, ids(b.threadIds), b);
    if (b.wait) await iris.flush(iris.acct(account));
    return c.json(result);
  });

  app.post("/api/undo", async (c) => {
    const b = await body<{ undoId?: string; wait?: boolean }>(c);
    const r = iris.undo(b.undoId);
    if (b.wait) await iris.flush();
    return c.json(r);
  });

  app.post("/api/get-me-to-zero", async (c) => {
    const b = await body<{ account?: string; before?: number }>(c);
    return c.json(iris.getMeToZero(b.account, b.before ?? Date.now()));
  });

  // ------------------------------------------------------------ reminders / time parsing

  app.get("/api/reminders", (c) => c.json(iris.reminders(acct(c))));
  app.get("/api/when", (c) => {
    const input = c.req.query("input");
    if (!input) return c.json({ presets: iris.reminderPresets() });
    const at = iris.parseWhen(input);
    return c.json({ at, iso: at ? new Date(at).toISOString() : null });
  });
  app.post("/api/remind", async (c) => {
    const b = await body<{ account?: string; threadIds: string[]; refs?: unknown; when: string | number; ifNoReply?: boolean; note?: string }>(c);
    if (b.when === undefined || b.when === "") throw new HttpError(400, "when required");
    if (b.refs !== undefined) return c.json(await iris.remindRefs(refList(b.refs), b.when, { ifNoReply: b.ifNoReply, note: b.note }));
    return c.json(await iris.remind(b.account, ids(b.threadIds), b.when, { ifNoReply: b.ifNoReply, note: b.note }));
  });

  // ------------------------------------------------------------ compose / drafts / send

  app.post("/api/compose", async (c) => {
    const b = await body<{ account?: string; threadId: string; kind?: "reply" | "replyAll" | "forward"; messageId?: string }>(c);
    if (!b.threadId) throw new HttpError(400, "threadId required");
    await iris.ensureBodies(b.account, b.threadId); // forward quotes the body
    return c.json(iris.replyDraft(b.account, b.threadId, b.kind ?? "replyAll", b.messageId));
  });

  app.post("/api/validate", async (c) => c.json(iris.validateDraft(await body<DraftInput>(c))));

  app.get("/api/drafts", async (c) => c.json(await iris.drafts(acct(c))));
  app.post("/api/drafts", async (c) => c.json(await iris.saveDraft(await body<DraftInput>(c))));
  app.delete("/api/drafts/:id", async (c) => {
    await iris.deleteDraft(acct(c), c.req.param("id"), c.req.query("threadId") || undefined);
    return c.json({ ok: true });
  });

  app.post("/api/send", async (c) => {
    const b = await body<{ draft: DraftInput; sendAt?: number | string; markDone?: boolean; instant?: boolean }>(c);
    if (!b.draft) throw new HttpError(400, "draft required");
    const v = iris.validateDraft(b.draft);
    if (v.errors.length) throw new HttpError(400, v.errors.join("; "));
    if (isAgent(c) && !iris.settings.agent.allowSend) {
      const d = await iris.saveDraft(b.draft);
      return c.json({
        status: "drafted",
        ...d,
        warnings: v.warnings,
        message: "Agent sending is off, so this was saved as a Gmail draft. Review and send it in Iris (or enable Settings → Agents → Allow sending).",
      });
    }
    let sendAt: number | undefined;
    if (b.sendAt !== undefined && b.sendAt !== "") {
      sendAt = typeof b.sendAt === "number" ? b.sendAt : (iris.parseWhen(b.sendAt) ?? undefined);
      if (!sendAt) throw new HttpError(400, `Could not understand time: ${b.sendAt}`);
    }
    const item = iris.send(b.draft, { sendAt, markDone: b.markDone, instant: b.instant });
    return c.json({ ...item, warnings: v.warnings });
  });

  app.get("/api/outbox", (c) => c.json(iris.outbox(acct(c))));
  app.get("/api/outbox/:id", (c) => {
    const o = iris.outboxItem(c.req.param("id"));
    if (!o) throw new HttpError(404, "Unknown outbox item");
    return c.json(o);
  });
  app.post("/api/outbox/:id/cancel", (c) => c.json(iris.cancelSend(c.req.param("id")) ?? null));
  app.post("/api/outbox/:id/send-now", (c) => c.json(iris.sendNow(c.req.param("id")) ?? null));
  app.post("/api/outbox/:id/reschedule", async (c) => {
    const b = await body<{ sendAt: number | string }>(c);
    const at = typeof b.sendAt === "number" ? b.sendAt : iris.parseWhen(String(b.sendAt ?? ""));
    if (!at) throw new HttpError(400, "sendAt required");
    return c.json(iris.reschedule(c.req.param("id"), at) ?? null);
  });

  // ------------------------------------------------------------ snippets

  app.get("/api/snippets", (c) => c.json(iris.snippets()));
  app.post("/api/snippets", async (c) => {
    const b = await body<{ id?: string; name: string; html: string; subject?: string; to?: string; cc?: string; bcc?: string }>(c);
    if (!b.name || b.html === undefined) throw new HttpError(400, "name and html required");
    return c.json(iris.saveSnippet(b));
  });
  app.delete("/api/snippets/:id", (c) => {
    iris.deleteSnippet(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/snippets/:id/expand", async (c) => {
    const b = await body<{ to?: string; account?: string }>(c);
    return c.json(iris.expandSnippet(c.req.param("id"), { to: b.to, accountId: b.account }));
  });

  // ------------------------------------------------------------ goals

  app.get("/api/goals", (c) => c.json(iris.goals.list()));
  app.post("/api/goals", async (c) => {
    const b = await body<{ title: string; why?: string; dueAt: number | string; steps?: string[]; kind?: GoalKind; startValue?: number; targetValue?: number; unit?: string }>(c);
    if (!b.title || b.dueAt === undefined) throw new HttpError(400, "title and dueAt required");
    return c.json(iris.goals.create(b));
  });
  app.patch("/api/goals/:id", async (c) => {
    const b = await body<{ title?: string; why?: string; dueAt?: number | string; status?: "active" | "done"; kind?: GoalKind; startValue?: number; targetValue?: number; unit?: string }>(c);
    if (b.status && b.status !== "active" && b.status !== "done") throw new HttpError(400, "status must be active or done");
    return c.json(iris.goals.update(c.req.param("id"), b));
  });
  app.delete("/api/goals/:id", (c) => {
    iris.goals.delete(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/goals/:id/entries", async (c) => {
    const b = await body<{ date?: string; value?: number | null }>(c);
    return c.json(iris.goals.logEntry(c.req.param("id"), b));
  });
  app.delete("/api/goals/:id/entries/:date", (c) => c.json(iris.goals.deleteEntry(c.req.param("id"), c.req.param("date"))));
  app.post("/api/goals/:id/steps", async (c) => {
    const b = await body<{ title: string }>(c);
    return c.json(iris.goals.addStep(c.req.param("id"), b.title));
  });
  app.patch("/api/goals/:id/steps/:stepId", async (c) => {
    const b = await body<{ title?: string; done?: boolean }>(c);
    return c.json(iris.goals.updateStep(c.req.param("id"), c.req.param("stepId"), b));
  });
  app.delete("/api/goals/:id/steps/:stepId", (c) => c.json(iris.goals.deleteStep(c.req.param("id"), c.req.param("stepId"))));
  app.post("/api/goals/:id/threads", async (c) => {
    const b = await body<{ account?: string; threadId: string }>(c);
    if (!b.threadId) throw new HttpError(400, "threadId required");
    return c.json(iris.goals.linkThread(c.req.param("id"), b.account, b.threadId));
  });
  app.delete("/api/goals/:id/threads/:threadId", (c) => c.json(iris.goals.unlinkThread(c.req.param("id"), acct(c), c.req.param("threadId"))));

  // ------------------------------------------------------------ label cleanup (not exposed to MCP agents)

  const noMcp = (c: Context) => {
    if (c.req.header("x-iris-client") === "mcp") throw new HttpError(403, "Deleting labels is only available in the CLI.");
  };
  app.post("/api/labels/backup", async (c) => {
    noMcp(c);
    const b = await body<{ account?: string }>(c);
    return c.json(await iris.backupLabels(b.account));
  });
  app.post("/api/labels/purge", async (c) => {
    noMcp(c);
    const b = await body<{ account?: string; expected: number; keep?: string[] }>(c);
    if (typeof b.expected !== "number") throw new HttpError(400, "expected (label count) required");
    return c.json(await iris.purgeLabels(b.account, b.expected, b.keep));
  });

  // ------------------------------------------------------------ unsubscribe / block / contacts

  app.post("/api/unsubscribe", async (c) => {
    const b = await body<{ account?: string; threadId: string; then?: "none" | "done" | "trash" }>(c);
    if (!b.threadId) throw new HttpError(400, "threadId required");
    if (isAgent(c) && !iris.settings.agent.allowSend) throw new HttpError(403, "Unsubscribing contacts the sender; agents need Settings → Agents → Allow sending.");
    return c.json(await iris.unsubscribe(b.account, b.threadId, b.then ?? "done"));
  });
  app.get("/api/rules", (c) => c.json(iris.rules(iris.acct(acct(c)))));
  app.post("/api/block", async (c) => {
    const b = await body<{ account?: string; value: string; kind?: "block_sender" | "block_domain" }>(c);
    if (!b.value) throw new HttpError(400, "value required");
    return c.json(await iris.block(b.account, b.value, b.kind));
  });
  app.get("/api/contacts", (c) => c.json(iris.contacts(acct(c), c.req.query("q") ?? "", num(c.req.query("limit")))));
  app.get("/api/people/:email", (c) => c.json(iris.person(acct(c), c.req.param("email"))));

  // ------------------------------------------------------------ AI (Claude Sonnet 5.5)

  app.get("/api/ai/status", (c) => c.json({ available: ai.available(), model: ai.model, enabled: iris.settings.ai.enabled }));
  app.post("/api/ai/key", async (c) => {
    if (isAgent(c)) throw new HttpError(403, "Set the API key in the Iris app or with `iris ai key` in a terminal.");
    const b = await body<{ key?: string }>(c);
    if (b.key) {
      if (!/^sk-ant-/.test(b.key.trim())) throw new HttpError(400, "That does not look like an Anthropic API key (sk-ant-…)");
      setSecret("anthropic-api-key", b.key.trim());
    } else deleteSecret("anthropic-api-key");
    ai.resetClient();
    return c.json({ available: ai.available() });
  });
  app.post("/api/ai/reload", (c) => {
    ai.resetClient();
    return c.json({ available: ai.available() });
  });
  app.post("/api/ai/summarize", async (c) => {
    const b = await body<{ account?: string; threadId: string; force?: boolean }>(c);
    return c.json(await ai.summarize(b.account, b.threadId, !!b.force));
  });
  app.post("/api/ai/replies", async (c) => {
    const b = await body<{ account?: string; threadId: string }>(c);
    return c.json(await ai.replies(b.account, b.threadId));
  });
  app.post("/api/ai/translate", async (c) => {
    const b = await body<{ account?: string; threadId: string; messageId: string; target?: string; force?: boolean }>(c);
    if (!b.threadId || !b.messageId) throw new HttpError(400, "threadId and messageId required");
    return c.json(await ai.translate(b.account, b.threadId, b.messageId, { target: b.target, force: !!b.force }));
  });
  app.post("/api/ai/ask", async (c) => {
    const b = await body<{ account?: string; question: string; history?: { role: "user" | "assistant"; content: string }[] }>(c);
    if (!b.question) throw new HttpError(400, "question required");
    return c.json(await ai.ask(b.account, b.question, b.history ?? []));
  });
  app.post("/api/ai/autolabel", async (c) => {
    const b = await body<{ account?: string; threadIds: string[]; engine?: "classifier" | "sonnet" }>(c);
    return c.json(await ai.autoLabel(b.account, ids(b.threadIds), { engine: b.engine }));
  });
  app.post("/api/ai/labels/propose", async (c) => c.json(await ai.proposeLabels()));
  app.post("/api/ai/labels/accept", (c) => c.json(ai.acceptLabels()));
  app.get("/api/ai/labels/status", (c) =>
    c.json({
      categories: iris.settings.ai.autoLabelCategories,
      autoLabels: iris.settings.ai.autoLabels,
      classifier: { model: iris.settings.ai.classifyModel, key: !!openRouterApiKey(), costUsd: Number(iris.db.kvGet("classifier_cost_usd") ?? 0) },
      proposal: JSON.parse(iris.db.kvGet("label_proposal") ?? "null"),
      accounts: iris.store.accounts().map((a) => ({ id: a.id, pending: iris.unclassifiedThreads(a.id).length })),
    }),
  );
  app.get("/api/ai/labels/pending", (c) => c.json(iris.unclassifiedThreads(acct(c))));
  app.post("/api/ai/write", async (c) => {
    const b = await body<{ account?: string; instruction: string; threadId?: string; draft?: string; to?: string; stream?: boolean }>(c);
    const req = { instruction: b.instruction ?? "", threadId: b.threadId, draft: b.draft, to: b.to };
    if (!b.stream) return c.json(await ai.write(b.account, req));
    if (!ai.available()) throw new AIUnavailableError("No Anthropic API key. Set ANTHROPIC_API_KEY or run: iris ai key");
    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      try {
        const r = await ai.writeStream(b.account, req, (d) => void stream.writeSSE({ event: "delta", data: JSON.stringify(d) }), ctrl.signal);
        await stream.writeSSE({ event: "done", data: JSON.stringify(r) });
      } catch (e) {
        if (!ctrl.signal.aborted) await stream.writeSSE({ event: "error", data: JSON.stringify({ error: (e as Error).message }) });
      }
    });
  });

  // ------------------------------------------------------------ person research

  app.post("/api/research", async (c) => {
    const b = await body<{ account?: string; name?: string; email?: string; context?: string; eventId?: string; calendarId?: string; force?: boolean; nameSource?: ResearchNameSource }>(c);
    if (!b.name?.trim() && !b.email?.trim()) throw new HttpError(400, "name or email required");
    if (!ai.available()) throw new AIUnavailableError("No Anthropic API key. Set ANTHROPIC_API_KEY or run: iris ai key");
    const r = ai.startResearch(b.account, { name: b.name, email: b.email, context: b.context, eventId: b.eventId, calendarId: b.calendarId, force: !!b.force, nameSource: b.nameSource });
    return c.json(r, r.status === "running" ? 202 : 200);
  });
  app.get("/api/research", (c) => c.json(ai.listResearch({ accountId: acct(c), eventId: c.req.query("eventId") || undefined, limit: num(c.req.query("limit")) })));
  // ?wait=N (seconds, max 60): long-poll until the run is no longer running (CLI / MCP)
  app.get("/api/research/:id", async (c) => {
    const id = c.req.param("id");
    const wait = Math.max(0, Math.min(num(c.req.query("wait")) ?? 0, 60));
    if (!ai.research(id)) throw new HttpError(404, "Research not found");
    return c.json(wait ? await ai.waitResearch(id, wait * 1000) : ai.research(id));
  });
  app.delete("/api/research/:id", (c) => {
    if (!ai.research(c.req.param("id"))) throw new HttpError(404, "Research not found");
    ai.deleteResearch(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ live events (SSE)

  const liveEvents = (c: Context) =>
    streamSSE(c, async (stream) => {
      const queue: IrisEvent[] = [];
      let wake: (() => void) | null = null;
      const off = iris.bus.onEvent((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ at: Date.now() }) });
      while (!stream.aborted && !stream.closed) {
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        }
        const timedOut = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), 20_000);
          wake = () => {
            clearTimeout(t);
            resolve(false);
          };
        });
        wake = null;
        if (timedOut) await stream.writeSSE({ event: "ping", data: "" });
      }
      off();
    });

  // ------------------------------------------------------------ calendar

  const AGENT_INVITES =
    "Adding guests emails them an invitation, so agents need Settings → Agents → Allow sending. Create the event without attendees, or let the user add guests in Iris.";
  const AGENT_RSVP = "An RSVP emails the organizer, so agents need Settings → Agents → Allow sending. Ask the user to respond in Iris.";
  const agentBlocked = (c: Context) => isAgent(c) && !iris.settings.agent.allowSend;
  const ms = (v: string | number | undefined | null): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(String(v));
    if (Number.isFinite(t)) return t;
    throw new HttpError(400, `Invalid time: ${v} (epoch ms or ISO 8601)`);
  };
  const bool = (v: unknown): boolean | undefined => (v === undefined || v === null || v === "" ? undefined : v === true || v === "1" || v === "true");
  const scopeOf = (v: unknown): RecurrenceScope | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (v === "this" || v === "following" || v === "all") return v;
    throw new HttpError(400, 'scope must be "this", "following" or "all"');
  };
  const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const calAccount = (c: Context, b?: { account?: string }) => b?.account || acct(c);
  const ev = (c: Context) => ({ calendarId: c.req.param("calendarId")!, eventId: c.req.param("eventId")! });
  const list = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

  const calendarEvents = async (c: Context) => {
    const q = c.req.query();
    const from = ms(q.from) ?? startOfToday();
    const to = ms(q.to) ?? from + (num(q.days) ?? 7) * 86_400_000;
    if (!(to > from)) throw new HttpError(400, "to must be after from");
    return c.json(await iris.calendar.events(q.account || undefined, from, to, list(q.calendars)));
  };

  // GET /api/events is both the SSE stream (EventSource, no query) and the calendar event list (account/from/to/calendars/days).
  app.get("/api/events", (c) => {
    const q = c.req.query();
    const accept = c.req.header("accept") ?? "";
    const wantsList =
      !accept.includes("text/event-stream") &&
      (q.from !== undefined || q.to !== undefined || q.calendars !== undefined || q.days !== undefined || q.account !== undefined || accept.includes("application/json"));
    return wantsList ? calendarEvents(c) : liveEvents(c);
  });
  app.get("/api/calendar/events", calendarEvents); // unambiguous alias

  app.get("/api/calendars", async (c) => c.json(await iris.calendar.calendars(acct(c))));
  app.patch("/api/calendars/:id", async (c) => {
    const b = await body<{ selected?: boolean; color?: string | null; notify?: boolean; account?: string }>(c);
    if (b.selected === undefined && b.color === undefined && b.notify === undefined) throw new HttpError(400, "selected, color or notify required");
    return c.json(await iris.calendar.updateCalendar(calAccount(c, b), c.req.param("id"), { selected: b.selected, color: b.color, notify: b.notify }));
  });

  app.get("/api/events/:calendarId/:eventId", async (c) => {
    const { calendarId, eventId } = ev(c);
    return c.json(await iris.calendar.event(acct(c), calendarId, eventId));
  });

  // who to research in this meeting (the event popover's Research button), same extraction as the meeting-start prompt
  app.get("/api/events/:calendarId/:eventId/people", async (c) => {
    const { calendarId, eventId } = ev(c);
    const e = await iris.calendar.event(acct(c), calendarId, eventId);
    return c.json({ people: ai.meetingPeople(e.accountId, e) });
  });

  app.post("/api/events", async (c) => {
    const b = await body<EventInput>(c);
    if ((attendeeEmails(b.attendees) ?? []).length && agentBlocked(c)) throw new HttpError(403, AGENT_INVITES);
    return c.json(await iris.calendar.createEvent({ ...b, account: calAccount(c, b) }));
  });

  app.patch("/api/events/:calendarId/:eventId", async (c) => {
    const b = await body<EventInput>(c);
    const { calendarId, eventId } = ev(c);
    const account = calAccount(c, b);
    const scope = scopeOf(b.scope);
    if (agentBlocked(c)) {
      const cur = await iris.calendar.event(account, calendarId, eventId);
      const adding = (attendeeEmails(b.attendees) ?? []).length > 0;
      if (adding || guests(cur).length)
        throw new HttpError(403, `${guests(cur).length ? "This event has guests; changing it emails them" : "Adding guests emails them an invitation"}, so agents need Settings → Agents → Allow sending.`);
    }
    return c.json(await iris.calendar.updateEvent(account, calendarId, eventId, { ...b, scope, notify: bool(b.notify) }));
  });

  app.delete("/api/events/:calendarId/:eventId", async (c) => {
    const { calendarId, eventId } = ev(c);
    const b = await body<{ notify?: boolean; scope?: string; account?: string }>(c);
    const account = calAccount(c, b);
    const opts = { notify: bool(b.notify ?? c.req.query("notify")), scope: scopeOf(b.scope ?? c.req.query("scope")) };
    if (agentBlocked(c)) {
      const cur = await iris.calendar.event(account, calendarId, eventId);
      if (guests(cur).length) throw new HttpError(403, "This event has guests; deleting it emails them a cancellation, so agents need Settings → Agents → Allow sending.");
    }
    return c.json(await iris.calendar.deleteEvent(account, calendarId, eventId, opts));
  });

  /** RSVP + optional Mark Done of the thread. */
  const rsvpDone = (account: string | undefined, threadId: string | undefined, markDone: boolean | undefined) => {
    if (threadId && (markDone ?? iris.settings.calendar.rsvpAndDone)) iris.markDone(account, [threadId]);
    return !!threadId && !!(markDone ?? iris.settings.calendar.rsvpAndDone);
  };

  app.post("/api/events/:calendarId/:eventId/rsvp", async (c) => {
    const b = await body<{ response?: string; account?: string; scope?: "this" | "all"; markDone?: boolean; threadId?: string }>(c);
    if (!b.response) throw new HttpError(400, "response required: accepted | declined | tentative");
    if (agentBlocked(c)) throw new HttpError(403, AGENT_RSVP);
    if (b.scope !== undefined && b.scope !== "this" && b.scope !== "all") throw new HttpError(400, 'scope must be "this" or "all"');
    const { calendarId, eventId } = ev(c);
    const account = calAccount(c, b);
    const e = await iris.calendar.rsvp(account, calendarId, eventId, b.response, { scope: b.scope });
    const done = rsvpDone(account, b.threadId, b.markDone);
    return c.json(done ? { ...e, markedDone: true } : e);
  });

  // RSVP from an invite mail: by iCalUID, importing the event from the ICS when it is not on the calendar yet
  app.post("/api/threads/:id/invite/rsvp", async (c) => {
    const b = await body<{ response?: string; account?: string; messageId?: string; scope?: "this" | "all"; markDone?: boolean }>(c);
    if (!b.response) throw new HttpError(400, "response required: accepted | declined | tentative");
    if (agentBlocked(c)) throw new HttpError(403, AGENT_RSVP);
    const account = iris.acct(calAccount(c, b));
    const threadId = c.req.param("id");
    const t = await iris.thread(account, threadId);
    if (!t) throw new HttpError(404, "Thread not found");
    const r = await iris.calendar.rsvpInvite(account, t.messages, b.response, { messageId: b.messageId, scope: b.scope });
    return c.json({ ...r, markedDone: rsvpDone(account, threadId, b.markDone) });
  });

  app.get("/api/freebusy", async (c) => {
    const from = ms(c.req.query("from")) ?? Date.now();
    const to = ms(c.req.query("to")) ?? from + 7 * 86_400_000;
    return c.json(await iris.calendar.freeBusy(acct(c), from, to, list(c.req.query("calendars"))));
  });

  app.get("/api/availability", async (c) => {
    const q = c.req.query();
    return c.json(
      await iris.calendar.availability(acct(c), {
        days: num(q.days),
        duration: num(q.duration),
        from: ms(q.from),
        workStart: num(q.workStart),
        workEnd: num(q.workEnd),
        maxRangesPerDay: num(q.maxRangesPerDay),
      }),
    );
  });

  app.post("/api/availability/text", async (c) => {
    const b = await body<{ slots?: { start: number | string; end: number | string }[]; duration?: number; timeZone?: string; attendees?: string[]; account?: string }>(c);
    if (!Array.isArray(b.slots)) throw new HttpError(400, "slots required: [{ start, end }]");
    const slots = b.slots.map((s) => ({ start: ms(s.start)!, end: ms(s.end)! }));
    if (slots.some((s) => !(s.end > s.start))) throw new HttpError(400, "every slot needs start < end");
    if (b.timeZone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: b.timeZone });
      } catch {
        throw new HttpError(400, `Unknown time zone: ${b.timeZone}`);
      }
    }
    const me = iris.accounts().length ? iris.acct(calAccount(c, b)) : undefined;
    const text = renderAvailabilityText({ slots, duration: b.duration ?? 30, timeZone: b.timeZone, attendees: attendeeEmails(b.attendees), me });
    return c.json({ text, html: text.split("\n").map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("<br>") });
  });

  app.post("/api/calendar/sync", async (c) => {
    const b = await body<{ account?: string; full?: boolean }>(c);
    const accounts = b.account ? [iris.acct(b.account)] : iris.accounts().map((a) => a.id);
    await Promise.all(accounts.map((a) => iris.calendar.sync(a, { full: !!b.full })));
    return c.json({ ok: true, accounts });
  });

  app.all("/api/*", (c) => c.json({ error: `No route: ${c.req.method} ${c.req.path}` }, 404));

  // ------------------------------------------------------------ web UI

  const indexHtml = () => {
    const file = path.join(webDir, "index.html");
    const boot = `<script>window.__IRIS__=${JSON.stringify({ token, demo: iris.demo })}</script>`;
    if (!fs.existsSync(file)) {
      return `<!doctype html><meta charset="utf-8"><title>Iris</title>${boot}<body style="font:15px -apple-system;background:#1f1e1d;color:#ddd;padding:40px"><h2>Iris daemon is running</h2><p>The web UI is not built yet. Run <code>npm run build</code> in the Iris repo.</p></body>`;
    }
    return fs.readFileSync(file, "utf8").replace("</head>", `${boot}</head>`);
  };

  app.get("*", (c) => {
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
    if (rel && rel !== "index.html") {
      const file = path.resolve(webDir, rel);
      if (file.startsWith(webDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
        const immutable = rel.startsWith("assets/");
        return new Response(fs.readFileSync(file), {
          headers: { "Content-Type": type, "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
        });
      }
      if (path.extname(rel)) return c.text("Not found", 404);
    }
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self' blob: data:; connect-src 'self'; font-src 'self' data:");
    return c.html(indexHtml());
  });

  return app;
}

export interface StartOptions {
  demo?: boolean;
  port?: number;
  home?: string;
  log?: (msg: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  iris: Iris;
  ai: IrisAI;
  token: string;
  close: () => Promise<void>;
}

/** Start the daemon in this process: Iris engine + HTTP API + web UI. */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const home = opts.home ?? daemonHome(opts.demo);
  if (opts.demo && !opts.home) {
    // demo always starts from a fresh seeded mailbox
    if (path.basename(home) === "demo" && path.dirname(home) === irisHome()) fs.rmSync(home, { recursive: true, force: true });
  }
  const iris = new Iris({ home, demo: opts.demo });
  const ai = new IrisAI(iris);
  const port = opts.port ?? (opts.demo ? 7788 : iris.settings.port);
  const token = apiToken(home);
  const ctx: AppContext = { iris, ai, token, port };
  const app = createApp(ctx);
  const server = createAdaptorServer({ fetch: app.fetch, hostname: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      iris.close();
      reject(e.code === "EADDRINUSE" ? new Error(`Port ${port} is in use (is Iris already running? try: iris status)`) : e);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  ctx.port = actualPort;
  const url = `http://127.0.0.1:${actualPort}`;
  const info: DaemonInfo = { pid: process.pid, port: actualPort, url, demo: !!opts.demo, home, startedAt: Date.now() };
  fs.writeFileSync(daemonInfoPath(home), JSON.stringify(info, null, 2), { mode: 0o600 });
  iris.bus.onEvent((e) => {
    if (e.type === "error") log(`[iris] ${(e.data as { where?: string })?.where ?? "error"}: ${(e.data as { message?: string })?.message ?? ""}`);
  });
  iris.start();
  log(`Iris ${opts.demo ? "(demo) " : ""}running at ${url}`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    iris.stop();
    await iris.flush().catch(() => undefined);
    await new Promise<void>((r) => {
      server.close(() => r());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    try {
      const cur = JSON.parse(fs.readFileSync(daemonInfoPath(home), "utf8")) as DaemonInfo;
      if (cur.pid === process.pid) fs.rmSync(daemonInfoPath(home), { force: true });
    } catch {
      /* gone */
    }
    iris.close();
  };
  return { url, port: actualPort, iris, ai, token, close };
}
