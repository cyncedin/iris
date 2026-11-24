// iris: command line for the Iris mail daemon. Human-readable output by default, --json for agents.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import {
  deleteSecret,
  importClientFile,
  irisHome,
  setSecret,
  textToHtml,
  type Calendar,
  type CalendarEvent,
  type Goal,
  type PersonResearch,
  type Thread,
  type ThreadSummary,
  type TimeRange,
} from "@iris/core";
import { connect, daemonHome, findDaemon, readDaemonInfo, startDaemonDetached, IrisApiError, type IrisClient } from "@iris/server/client";

const HELP = `iris — keyboard-first mail with an API for AI agents

Daemon
  iris start [--demo]              start the background daemon (auto-started by other commands)
  iris serve [--demo] [--port N]   run the daemon in the foreground
  iris stop [--demo] | status | open [--demo]
  iris daemon install|uninstall    start Iris at login (launchd)

Accounts & AI
  iris auth client <client_secret.json>   import a Google OAuth Desktop client
  iris auth login [--hint you@gmail.com]  connect a Gmail account (browser consent)
  iris auth logout <email> | iris accounts
  iris ai key [--clear]            store the Anthropic API key in the macOS Keychain
  iris ai status

Mail
  iris inbox [--split NAME] [--unread] [--limit N]      (--account all: every account in one list)
  iris list <starred|drafts|sent|done|reminders|scheduled|all|spam|trash|muted|label:NAME>
  iris search "<gmail query>" [--local] [--limit N]
  iris read <threadId> [--html] [--no-mark]
  iris done|undone|star|unstar|read-mark|unread|important|unimportant|trash|untrash|spam|mute|unmute <threadId...>
  iris label add|remove <label> <threadId...>   iris move <label> <threadId...>   iris labels
  iris remind <threadId...> --when "tomorrow 9am" [--if-no-reply] [--note TEXT]
  iris reminders | iris undo | iris zero [--before WHEN] | iris sync [--full]
  iris splits [add NAME "QUERY" | rm ID]

Writing (drafts by default; --send queues with undo window; agents need Settings → Allow sending)
  iris compose --to A [--cc B] [--bcc C] --subject S (--body TEXT | --body-file F | stdin) [--send [--at WHEN]]
  iris reply <threadId> [--all] (--body TEXT | ...) [--send [--at WHEN]] [--done]
  iris forward <threadId> --to A [--body TEXT] [--send]
  iris drafts | iris outbox | iris cancel <outboxId> | iris send-now <outboxId>
  iris snippets [add NAME --body TEXT | rm ID | expand NAME --to ADDR]
  iris unsubscribe <threadId> [--then none|done|trash] | iris block <email|@domain>
  iris contacts <query> | iris person <email>

Calendar (Google Calendar of the same account)
  iris cal [today|tomorrow|week|<date>] [--days N] [--calendars ID,ID]
  iris cal add "<natural language>" [--attendees a,b] [--meet] [--calendar ID]   e.g. "Lunch with Anna tomorrow 1pm for 1h"
  iris cal rsvp <calendarId> <eventId> yes|no|maybe [--all]   iris cal rsvp --thread <threadId> yes|no|maybe
  iris cal free [--days 5] [--duration 30]   (availability text to paste into a reply)
  iris cal calendars | iris cal show <calendarId> <eventId> | iris cal delete <calendarId> <eventId> [--all] | iris cal sync

AI (Claude Sonnet 5.5)
  iris summarize <threadId> [--force]
  iris write "<instruction>" [--thread ID] [--to A] [--draft]   (--draft saves it as a Gmail draft)
  iris replies <threadId>
  iris classify                                 status: categories, unclassified threads, classifier cost
  iris classify propose | accept                Sonnet designs the labels from your mail, accept makes them live
  iris classify run [--sonnet] [--account A]    label unclassified threads (default: ai.classifyModel on OpenRouter)
  iris classify load-all [--account A]          load every older thread from Gmail into Iris (metadata, in the background)
  iris labels backup [--account A]              save label assignments, show what a purge would delete
  iris labels purge --account A --expect N [--keep NAME]   delete all user labels of the account (mail stays)
  iris ai openrouter-key                        OpenRouter key for the classifier (stdin or hidden prompt)
  iris translate <threadId> [--message ID] [--to LANGUAGE]   (Claude Haiku 5.5; default: latest message)
  iris ask "<question about your mail>"

Person research (Claude Opus 5.5 + web search, plus what your mail and calendar know)
  iris research "<name>" [--email A] [--context "what you know"] [--event <calendarId>/<eventId>] [--force]   waits, prints the report
  iris research list [--limit N] | iris research show <id> | iris research rm <id>

Goals
  iris goals                                  progress of all goals
  iris goals add "<title>" --due "in 12 weeks" [--why TEXT] [--steps "a,b,c"]
  iris goals add "<title>" --due DATE --kind metric --start 115 --target 105 --unit kg | --kind habit
  iris goals set <goalId> [--kind K] [--start N] [--target N] [--unit U] [--due DATE] [--title T] [--why TEXT]
  iris goals log <goalId> 112.4 [--date YYYY-MM-DD] | iris goals log <goalId> --done [--date YYYY-MM-DD]
  iris goals unlog <goalId> --date YYYY-MM-DD
  iris goals step <goalId> "<title>" | iris goals check <goalId> <stepId> [--undo] | iris goals rm <goalId>

Agents
  iris mcp [--demo]                MCP server on stdio (claude mcp add iris -- iris mcp)
  iris agent allow-send on|off     let agents send without review (asks for confirmation)

Global flags: --json  --demo (use the demo mailbox)  --account EMAIL (inbox/list/search/reminders/drafts/outbox/cal: also "all")`;

// ------------------------------------------------------------ args

const BOOL = new Set([
  "json", "demo", "unread", "all", "send", "local", "html", "full", "force", "if-no-reply", "foreground", "clear", "yes", "no-mark",
  "instant", "done", "draft", "starred", "important", "help", "remote", "meet", "no-notify",
]);

interface Args {
  _: string[];
  f: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], f: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out.f[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const k = a.slice(2);
        if (BOOL.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) out.f[k] = true;
        else out.f[k] = argv[++i];
      }
    } else if (a === "-h") out.f.help = true;
    else out._.push(a);
  }
  return out;
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

// ------------------------------------------------------------ output helpers

const tty = process.stdout.isTTY;
const c = {
  el: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  purple: (s: string) => (tty ? `\x1b[38;5;141m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
};

function pad(s: string, n: number): string {
  const chars = [...s];
  if (chars.length > n) return chars.slice(0, n - 1).join("") + "…";
  return s + " ".repeat(n - chars.length);
}

function ago(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h`;
  const dt = new Date(ms);
  if (d < 6 * 86_400_000) return dt.toLocaleDateString("en-US", { weekday: "short" });
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: dt.getFullYear() === new Date().getFullYear() ? undefined : "2-digit" });
}

function who(t: ThreadSummary): string {
  const p = t.lastFrom ?? t.participants[0];
  return p ? p.name || p.email : "";
}

const isAll = (account: string | undefined) => account?.toLowerCase() === "all";

/** `showAccount`: unified lists (--account all) print the account of every row (pass it as --account to act on it). */
function printThreads(list: ThreadSummary[], total?: number, showAccount = false): void {
  if (!list.length) {
    console.log(c.el("Nothing here. Inbox zero ✨"));
    return;
  }
  const w = Math.max(60, Math.min(process.stdout.columns ?? 120, 160));
  const acctW = showAccount ? Math.min(26, Math.max(...list.map((t) => t.accountId.length))) + 2 : 0;
  const subjW = Math.max(20, w - 16 - 22 - 8 - 6 - acctW);
  for (const t of list) {
    const flags = `${t.unread ? c.purple("●") : " "}${t.starred ? "★" : " "}`;
    const rem = t.reminder ? c.el(" ⏰") : "";
    const ai = t.aiLabels?.length ? c.el(` [${t.aiLabels.join(", ")}]`) : "";
    const subj = pad(`${t.subject || "(no subject)"}${t.messageCount > 1 ? ` (${t.messageCount})` : ""}`, subjW);
    const acct = showAccount ? c.el(pad(t.accountId, acctW - 2)) + "  " : "";
    console.log(`${flags} ${c.el(t.id)}  ${acct}${pad(who(t), 20)}  ${t.unread ? c.bold(subj) : subj} ${pad(ago(t.lastDate), 6)}${rem}${ai}`);
  }
  if (total !== undefined && total > list.length) console.log(c.el(`… ${total - list.length} more (use --limit)`));
}

function htmlToTextLite(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function printThread(t: Thread, html: boolean): void {
  console.log(c.bold(t.subject || "(no subject)"));
  console.log(c.el(`${t.id} · ${t.messageCount} message${t.messageCount === 1 ? "" : "s"} · ${t.labelIds.join(", ")}`));
  if (t.reminder) console.log(c.purple(`⏰ Reminder: ${new Date(t.reminder.remindAt).toLocaleString()}${t.reminder.ifNoReply ? " (if no reply)" : ""}`));
  for (const m of t.messages) {
    console.log("\n" + "─".repeat(Math.min(process.stdout.columns ?? 80, 80)));
    const from = m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email;
    console.log(`${c.bold(from)}${m.isDraft ? c.red("  [DRAFT]") : ""}  ${c.el(new Date(m.date).toLocaleString())}`);
    console.log(c.el(`to ${m.to.map((a) => a.email).join(", ")}${m.cc.length ? ` · cc ${m.cc.map((a) => a.email).join(", ")}` : ""} · id ${m.id}`));
    const atts = m.attachments.filter((a) => !a.inline);
    if (atts.length) console.log(c.el(`📎 ${atts.map((a) => `${a.filename} (${Math.round(a.size / 1024)} KB)`).join(", ")}`));
    console.log();
    console.log(html ? m.bodyHtml : (m.bodyText || htmlToTextLite(m.bodyHtml)).trim());
  }
}

function out(json: boolean, data: unknown, human?: () => void): void {
  if (json || !human) console.log(JSON.stringify(data, null, 2));
  else human();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const w = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) w.call(rl, question);
        else if (s.includes("\n")) w.call(rl, "\n");
      };
    }
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// ------------------------------------------------------------ commands

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  const f = args.f;
  const json = !!f.json;
  const demo = !!f.demo || process.env.IRIS_DEMO === "1";
  const account = str(f.account);
  if (!cmd || f.help || cmd === "help") {
    console.log(HELP);
    return;
  }

  // ---- commands that do not need a running daemon
  switch (cmd) {
    case "serve": {
      const { startServer } = await import("@iris/server");
      const port = str(f.port) ? Number(f.port) : undefined;
      const srv = await startServer({ demo, port });
      const stop = async () => {
        await srv.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "mcp": {
      const { runMcpServer } = await import("@iris/mcp");
      await runMcpServer({ demo });
      return;
    }
    case "start": {
      const existing = await findDaemon({ demo });
      if (existing) return void out(json, existing.info, () => console.log(`Iris is already running at ${existing.url}`));
      const info = await startDaemonDetached({ demo, port: str(f.port) ? Number(f.port) : undefined });
      return void out(json, info, () => console.log(`Iris ${demo ? "(demo) " : ""}started at ${info.url}`));
    }
    case "stop": {
      const info = readDaemonInfo(daemonHome(demo));
      if (!info) return void console.log("Iris is not running.");
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 50 && readDaemonInfo(daemonHome(demo)); i++) await new Promise((r) => setTimeout(r, 100));
      return void console.log("Iris stopped.");
    }
    case "daemon":
      return daemonCmd(rest[0], demo);
    case "auth":
      if (rest[0] === "client") {
        const file = rest[1];
        if (!file) throw new Error("Usage: iris auth client <client_secret.json>");
        const cl = importClientFile(path.resolve(file));
        return void console.log(`Google OAuth client stored in Keychain (${cl.client_id.slice(0, 18)}…). Next: iris auth login`);
      }
      break;
    case "ai":
      if (rest[0] === "key") {
        if (f.clear) {
          deleteSecret("anthropic-api-key");
          console.log("Anthropic API key removed.");
        } else {
          let key = (await readStdin()).trim();
          if (!key && interactive()) key = await ask("Anthropic API key (input hidden): ", true);
          if (!/^sk-ant-/.test(key)) throw new Error("That does not look like an Anthropic API key (sk-ant-…)");
          setSecret("anthropic-api-key", key);
          console.log("Stored in macOS Keychain (service \"Iris Mail\"). AI features use claude-sonnet-5-5.");
        }
        const d = await findDaemon({ demo, client: "cli" });
        if (d) await d.post("/api/ai/reload").catch(() => undefined);
        return;
      }
      if (rest[0] === "openrouter-key") {
        let key = (await readStdin()).trim();
        if (!key && interactive()) key = await ask("OpenRouter API key (input hidden): ", true);
        if (!/^sk-or-/.test(key)) throw new Error("That does not look like an OpenRouter API key (sk-or-…)");
        setSecret("openrouter-api-key", key);
        console.log("Stored in macOS Keychain (service \"Iris Mail\").");
        return;
      }
      break;
  }

  if (cmd === "status" && !(await findDaemon({ demo }))) {
    return out(json, { running: false }, () => console.log(`Iris ${demo ? "(demo) " : ""}is not running. Start it with: iris start`));
  }
  const api = await connect({ demo, client: "cli" });

  switch (cmd) {
    case "status": {
      const s = await api.get<{ accounts: { email: string; inbox: number; unread: number; threads: number; lastSyncAt: number | null; syncing: { done: number; total: number } | null }[]; ai: { available: boolean; model: string }; demo: boolean }>("/api/status");
      return out(json, { url: api.url, ...s }, () => {
        console.log(`Iris ${s.demo ? "(demo) " : ""}running at ${api.url}`);
        if (!s.accounts.length) console.log("No account connected. Run: iris auth login");
        for (const a of s.accounts)
          console.log(`  ${c.bold(a.email)}  inbox ${a.inbox} (${a.unread} unread) · ${a.threads} threads cached · ${a.syncing ? `initial sync ${a.syncing.done}/${a.syncing.total}` : `synced ${a.lastSyncAt ? (ago(a.lastSyncAt) === "now" ? "just now" : ago(a.lastSyncAt) + " ago") : "never"}`}`);
        console.log(`  AI: ${s.ai.available ? c.green(`on (${s.ai.model})`) : c.red("no API key — run: iris ai key")}`);
      });
    }
    case "open": {
      spawn("open", [api.url], { stdio: "ignore", detached: true }).unref();
      return void console.log(api.url);
    }
    case "auth": {
      if (rest[0] === "login") {
        const r = await api.post<{ loginId: string; url: string }>("/api/accounts/gmail", { loginHint: str(f.hint) });
        console.error(`Opening Google sign-in in your browser…\nIf it does not open, visit:\n${r.url}\n`);
        for (;;) {
          await new Promise((res) => setTimeout(res, 1000));
          const s = await api.get<{ status: string; email?: string; error?: string }>(`/api/accounts/login/${r.loginId}`);
          if (s.status === "done") return void out(json, s, () => console.log(c.green(`Connected ${s.email}. Initial sync is running (iris status).`)));
          if (s.status === "error") throw new Error(s.error);
        }
      }
      if (rest[0] === "logout") {
        if (!rest[1]) throw new Error("Usage: iris auth logout <email>");
        await api.del(`/api/accounts/${encodeURIComponent(rest[1])}`);
        return void console.log(`Removed ${rest[1]}`);
      }
      throw new Error("Usage: iris auth client|login|logout");
    }
    case "accounts":
      return out(json, await api.get("/api/accounts"), undefined);
    case "ai": {
      if (rest[0] === "status" || !rest[0]) return out(json, await api.get("/api/ai/status"), undefined);
      throw new Error("Usage: iris ai key|status");
    }
    case "sync":
      return out(json, await api.post("/api/sync", { account, full: !!f.full }), () => console.log("Synced."));

    case "inbox":
    case "list": {
      let view = cmd === "inbox" ? "inbox" : (rest[0] ?? "inbox");
      let label: string | undefined;
      if (view.startsWith("label:")) {
        const name = view.slice(6);
        const labels = await api.get<{ id: string; name: string }[]>("/api/labels", { account });
        label = labels.find((l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name)?.id;
        if (!label) throw new Error(`Unknown label: ${name}`);
        view = "label";
      }
      let split: string | undefined;
      if (str(f.split)) {
        const splits = await api.get<{ id: string; name: string }[]>("/api/splits", { account });
        split = splits.find((s) => s.name.toLowerCase() === String(f.split).toLowerCase() || s.id === f.split)?.id;
        if (!split) throw new Error(`Unknown split: ${f.split}. Splits: ${splits.map((s) => s.name).join(", ")}`);
      }
      const filter = f.unread ? "unread" : f.starred ? "starred" : f.important ? "important" : undefined;
      const r = await api.get<{ threads: ThreadSummary[]; total: number }>("/api/threads", {
        account,
        view: split ? "split" : view,
        split,
        label,
        filter,
        q: str(f.q),
        limit: str(f.limit) ?? 50,
      });
      return out(json, r, () => printThreads(r.threads, r.total, isAll(account)));
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) throw new Error('Usage: iris search "<query>"');
      const r = await api.get<ThreadSummary[]>("/api/search", { account, q, remote: f.local ? 0 : 1, limit: str(f.limit) ?? 30 });
      return out(json, r, () => printThreads(r, undefined, isAll(account)));
    }
    case "read":
    case "show": {
      const id = rest[0];
      if (!id) throw new Error("Usage: iris read <threadId>");
      const t = await api.get<Thread>(`/api/threads/${id}`, { account });
      if (!f["no-mark"] && t.unread) await api.post("/api/actions/read", { account, threadIds: [id] });
      return out(json, t, () => printThread(t, !!f.html));
    }
    case "done":
    case "archive":
    case "undone":
    case "star":
    case "unstar":
    case "read-mark":
    case "unread":
    case "important":
    case "unimportant":
    case "trash":
    case "untrash":
    case "spam":
    case "mute":
    case "unmute": {
      if (!rest.length) throw new Error(`Usage: iris ${cmd} <threadId...>`);
      const action = cmd === "read-mark" ? "read" : cmd;
      const r = await api.post<{ count: number; description: string; undoId: string }>(`/api/actions/${action}`, { account, threadIds: rest, wait: true });
      return out(json, r, () => console.log(`${r.description ?? "Done"} (${r.count}). Undo: iris undo`));
    }
    case "label": {
      const [op, name, ...ids] = rest;
      if (!["add", "remove"].includes(op) || !name || !ids.length) throw new Error("Usage: iris label add|remove <label> <threadId...>");
      return out(json, await api.post(`/api/actions/${op === "add" ? "addLabel" : "removeLabel"}`, { account, threadIds: ids, label: name, wait: true }), () =>
        console.log(`${op === "add" ? "Added" : "Removed"} label ${name}.`),
      );
    }
    case "move": {
      const [name, ...ids] = rest;
      if (!name || !ids.length) throw new Error("Usage: iris move <label> <threadId...>");
      return out(json, await api.post("/api/actions/move", { account, threadIds: ids, label: name, wait: true }), () => console.log(`Moved to ${name}.`));
    }
    case "classify": {
      if (rest[0] === "propose" || rest[0] === "accept") {
        const cats = await api.post<{ name: string; description: string }[]>(`/api/ai/labels/${rest[0]}`);
        return out(json, cats, () => cats.forEach((x) => console.log(`${c.bold(x.name)}\n  ${c.el(x.description)}`)));
      }
      if (rest[0] === "load-all") return out(json, await api.post("/api/mailbox/backfill", { account }), () => console.log("Loading in the background. Progress: Iris → All Mail."));
      if (rest[0] === "run") {
        const engine = f.sonnet ? "sonnet" : "classifier";
        const accounts = account ? [account] : (await api.get<{ id: string }[]>("/api/accounts")).map((a) => a.id);
        for (const a of accounts) {
          const pending = await api.get<string[]>("/api/ai/labels/pending", { account: a });
          const batches: string[][] = [];
          for (let i = 0; i < pending.length; i += 15) batches.push(pending.slice(i, i + 15));
          let done = 0;
          let failed = 0;
          let next = 0;
          // resumable: a rerun only picks up threads that still have no labels
          await Promise.all(
            Array.from({ length: Number(str(f.parallel) ?? 5) }, async () => {
              while (next < batches.length) {
                const batch = batches[next++];
                try {
                  done += (await api.post<unknown[]>("/api/ai/autolabel", { account: a, threadIds: batch, engine })).length;
                } catch (e) {
                  failed += batch.length;
                  console.error(`  batch failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                console.log(`${a}: ${done} of ${pending.length} labelled${failed ? `, ${failed} failed` : ""}`);
              }
            }),
          );
        }
        return;
      }
      const s = await api.get<{ categories: string[]; autoLabels: boolean; classifier: { model: string; key: boolean; costUsd: number }; accounts: { id: string; pending: number }[] }>("/api/ai/labels/status");
      return out(json, s, () => {
        console.log(`Categories: ${s.categories.join(", ")}`);
        console.log(`Classifier: ${s.classifier.model} · key ${s.classifier.key ? "set" : "missing"} · new mail ${s.autoLabels ? "on" : "off"} · $${s.classifier.costUsd.toFixed(4)} so far`);
        s.accounts.forEach((a) => console.log(`${a.id}: ${a.pending} unclassified`));
      });
    }
    case "labels": {
      if (rest[0] === "backup") {
        const r = await api.post<{ file: string; labels: { name: string; threads: number }[]; filters: number }>("/api/labels/backup", { account });
        return out(json, r, () => {
          r.labels.forEach((l) => console.log(`${pad(l.name, 36)} ${l.threads}`));
          console.log(c.el(`\n${r.labels.length} labels · ${r.filters} Gmail filters use them\nBackup: ${r.file}`));
        });
      }
      if (rest[0] === "purge") {
        if (!account || !str(f.expect)) throw new Error("Usage: iris labels purge --account A --expect N");
        const r = await api.post<{ deleted: string[]; failed: { name: string; error: string }[] }>("/api/labels/purge", { account, expected: Number(str(f.expect)), keep: str(f.keep) ? [str(f.keep)] : undefined });
        return out(json, r, () => {
          console.log(`Deleted ${r.deleted.length} labels.`);
          r.failed.forEach((x) => console.error(`Failed: ${x.name}: ${x.error}`));
        });
      }
      const labels = await api.get<{ id: string; name: string; type: string }[]>("/api/labels", { account });
      return out(json, labels, () => labels.filter((l) => l.type === "user").forEach((l) => console.log(l.name)));
    }
    case "remind":
    case "snooze": {
      const when = str(f.when) ?? str(f.at);
      if (!rest.length || !when) throw new Error('Usage: iris remind <threadId...> --when "tomorrow 9am" [--if-no-reply]');
      const r = await api.post<{ when: string }>("/api/remind", { account, threadIds: rest, when, ifNoReply: !!f["if-no-reply"], note: str(f.note) });
      return out(json, r, () => console.log(`Reminder set for ${r.when}${f["if-no-reply"] ? " if nobody replies" : ""}.`));
    }
    case "reminders": {
      const r = await api.get<{ accountId: string; threadId: string; subject: string; when: string; ifNoReply: boolean }[]>("/api/reminders", { account });
      return out(json, r, () => {
        if (!r.length) console.log(c.el("No reminders."));
        for (const x of r) console.log(`${pad(x.when, 22)} ${c.el(x.threadId)}  ${isAll(account) ? c.el(`${x.accountId}  `) : ""}${x.subject}${x.ifNoReply ? c.el(" (if no reply)") : ""}`);
      });
    }
    case "undo": {
      const r = await api.post<{ ok: boolean; description?: string }>("/api/undo", { wait: true });
      return out(json, r, () => console.log(r.ok ? r.description : "Nothing to undo."));
    }
    case "zero": {
      const before = str(f.before);
      let at = Date.now();
      if (before) {
        const w = await api.get<{ at: number | null }>("/api/when", { input: before });
        if (!w.at) throw new Error(`Could not understand: ${before}`);
        at = w.at;
      }
      const r = await api.post<{ count: number }>("/api/get-me-to-zero", { account, before: at });
      return out(json, r, () => console.log(`Marked ${r.count} conversations done. Undo: iris undo`));
    }
    case "splits": {
      if (rest[0] === "add") {
        if (!rest[1] || !rest[2]) throw new Error('Usage: iris splits add NAME "QUERY"');
        return out(json, await api.post("/api/splits", { name: rest[1], query: rest.slice(2).join(" ") }, ), undefined);
      }
      if (rest[0] === "rm") return out(json, await api.del(`/api/splits/${rest[1]}`), undefined);
      const s = await api.get<{ id: string; name: string; query: string; count: number; unread: number; enabled: boolean }[]>("/api/splits", { account });
      return out(json, s, () => s.forEach((x) => console.log(`${pad(x.name, 16)} ${pad(`${x.count} (${x.unread} unread)`, 16)} ${c.el(!x.enabled ? "disabled" : x.query || "(everything else)")} ${c.el(x.id)}`)));
    }

    // ---- writing
    case "compose":
    case "reply":
    case "forward":
      return writeCmd(api, cmd, rest, f, account, json);
    case "drafts": {
      const d = await api.get<{ draftId: string; threadId: string; subject: string; to: { email: string }[]; date: number }[]>("/api/drafts", { account });
      return out(json, d, () => d.forEach((x) => console.log(`${c.el(x.draftId)}  ${pad(x.to.map((a) => a.email).join(", "), 28)} ${x.subject} ${c.el(`thread ${x.threadId}`)}`)));
    }
    case "outbox": {
      const o = await api.get<{ id: string; status: string; sendAt: number; draft: { subject: string; to: unknown } }[]>("/api/outbox", { account });
      return out(json, o, () => {
        if (!o.length) console.log(c.el("Outbox empty."));
        o.forEach((x) => console.log(`${c.el(x.id)}  ${pad(x.status, 8)} ${new Date(x.sendAt).toLocaleString()}  ${x.draft.subject}`));
      });
    }
    case "cancel":
      return out(json, await api.post(`/api/outbox/${rest[0]}/cancel`), () => console.log("Send cancelled; message kept in outbox history."));
    case "send-now":
      return out(json, await api.post(`/api/outbox/${rest[0]}/send-now`), () => console.log("Sending now."));
    case "snippets": {
      if (rest[0] === "add") {
        const body = str(f.body) ?? (await readStdin());
        if (!rest[1] || !body) throw new Error("Usage: iris snippets add NAME --body TEXT");
        return out(json, await api.post("/api/snippets", { name: rest[1], html: textToHtml(body), subject: str(f.subject) }), () => console.log(`Saved snippet ${rest[1]}.`));
      }
      if (rest[0] === "rm") return out(json, await api.del(`/api/snippets/${rest[1]}`), () => console.log("Deleted."));
      if (rest[0] === "expand") return out(json, await api.post(`/api/snippets/${encodeURIComponent(rest[1])}/expand`, { to: str(f.to), account }), undefined);
      const s = await api.get<{ id: string; name: string; html: string }[]>("/api/snippets");
      return out(json, s, () => s.forEach((x) => console.log(`${pad(x.name, 20)} ${c.el(htmlToTextLite(x.html).slice(0, 70))}`)));
    }
    case "unsubscribe": {
      const r = await api.post<{ ok: boolean; method: string; url?: string; sender?: string }>("/api/unsubscribe", { account, threadId: rest[0], then: str(f.then) ?? "done" });
      return out(json, r, () => console.log(r.ok ? `Unsubscribed from ${r.sender} (${r.method}).` : r.url ? `Open to unsubscribe: ${r.url}` : `Could not unsubscribe (${r.method}).`));
    }
    case "block": {
      const v = rest[0];
      if (!v) throw new Error("Usage: iris block <email|@domain>");
      const r = await api.post<{ trashed: number }>("/api/block", { account, value: v, kind: v.startsWith("@") ? "block_domain" : "block_sender" });
      return out(json, r, () => console.log(`Blocked ${v}. Trashed ${r.trashed} conversation(s).`));
    }
    case "contacts":
      return out(json, await api.get("/api/contacts", { account, q: rest.join(" "), limit: str(f.limit) ?? 10 }), undefined);
    case "person":
      return out(json, await api.get(`/api/people/${encodeURIComponent(rest[0] ?? "")}`, { account }), undefined);

    // ---- calendar
    case "cal":
    case "calendar":
      return calCmd(api, rest, f, account, json, demo);

    // ---- AI
    case "summarize":
    case "summary": {
      const r = await api.post<{ tldr: string; bullets: string[]; action_items: string[]; needs_reply: boolean }>("/api/ai/summarize", { account, threadId: rest[0], force: !!f.force });
      return out(json, r, () => {
        console.log(c.bold(r.tldr));
        r.bullets.forEach((b) => console.log(`  • ${b}`));
        if (r.action_items.length) {
          console.log(c.purple("\nTo do:"));
          r.action_items.forEach((b) => console.log(`  ☐ ${b}`));
        }
        if (r.needs_reply) console.log(c.purple("\n↩ Needs a reply"));
      });
    }
    case "translate": {
      const t = await api.get<{ messages: { id: string; isDraft: boolean }[] }>(`/api/threads/${rest[0]}`, { account });
      const messageId = str(f.message) ?? t.messages.filter((m) => !m.isDraft).at(-1)?.id;
      if (!messageId) throw new Error("Usage: iris translate <threadId> [--message ID] [--to LANGUAGE]");
      const r = await api.post<{ sourceLanguage: string; targetLanguage: string; text: string }>("/api/ai/translate", { account, threadId: rest[0], messageId, target: str(f.to) });
      return out(json, r, () => {
        console.log(c.el(`${r.sourceLanguage} → ${r.targetLanguage}\n`));
        console.log(r.text);
      });
    }
    case "goals": {
      const number = (v: string | undefined) => {
        if (v === undefined) return undefined;
        const n = Number(v.replace(",", "."));
        if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
        return n;
      };
      if (rest[0] === "add") {
        if (!rest[1] || !str(f.due)) throw new Error('Usage: iris goals add "<title>" --due "in 12 weeks" [--why TEXT] [--steps "a,b,c"] [--kind metric --start N --target N --unit U | --kind habit]');
        return out(
          json,
          await api.post("/api/goals", { title: rest[1], dueAt: str(f.due), why: str(f.why), steps: str(f.steps)?.split(","), kind: str(f.kind), startValue: number(str(f.start)), targetValue: number(str(f.target)), unit: str(f.unit) }),
          () => console.log(`Created goal ${rest[1]}.`),
        );
      }
      if (rest[0] === "set") {
        if (!rest[1]) throw new Error("Usage: iris goals set <goalId> [--kind K] [--start N] [--target N] [--unit U] [--due DATE] [--title T] [--why TEXT]");
        return out(json, await api.patch(`/api/goals/${rest[1]}`, { title: str(f.title), why: str(f.why), dueAt: str(f.due), kind: str(f.kind), startValue: number(str(f.start)), targetValue: number(str(f.target)), unit: str(f.unit) }), () => console.log("Updated."));
      }
      if (rest[0] === "log") {
        if (!rest[1] || (!f.done && rest[2] === undefined) || (f.done && rest[2] !== undefined)) throw new Error("Usage: iris goals log <goalId> <value> [--date YYYY-MM-DD] | iris goals log <goalId> --done [--date YYYY-MM-DD]");
        const g = await api.post<Goal>(`/api/goals/${rest[1]}/entries`, { value: number(rest[2]), date: str(f.date) });
        return out(json, g, () => console.log(`Logged for ${str(f.date) ?? "today"}. ${g.progress.percent}% · ${g.progress.pace.replace("_", " ")}`));
      }
      if (rest[0] === "unlog") {
        if (!rest[1] || !str(f.date)) throw new Error("Usage: iris goals unlog <goalId> --date YYYY-MM-DD");
        return out(json, await api.del(`/api/goals/${rest[1]}/entries/${str(f.date)}`), () => console.log("Entry deleted."));
      }
      if (rest[0] === "step") return out(json, await api.post(`/api/goals/${rest[1]}/steps`, { title: rest[2] }), () => console.log("Step added."));
      if (rest[0] === "check") return out(json, await api.patch(`/api/goals/${rest[1]}/steps/${rest[2]}`, { done: !f.undo }), () => console.log(f.undo ? "Step reopened." : "Step done."));
      if (rest[0] === "rm") return out(json, await api.del(`/api/goals/${rest[1]}`), () => console.log("Deleted."));
      const goals = await api.get<Goal[]>("/api/goals");
      return out(json, goals, () =>
        goals.forEach((g) => {
          const p = g.progress;
          console.log(`${c.bold(g.title)} ${c.el(g.id)}\n  ${p.percent}% · ${p.pace.replace("_", " ")} · day ${p.day} of ${p.totalDays} · ${p.daysLeft} days left`);
          g.steps.forEach((s) => console.log(`  ${s.doneAt ? "☑" : "☐"} ${s.title} ${c.el(s.id)}`));
          if (p.metric) console.log(`  now ${p.metric.current} ${g.unit} · today's target ${p.metric.expected} ${g.unit} · goal ${g.targetValue} ${g.unit}`);
          if (p.habit) console.log(`  ${p.habit.loggedDays} of ${p.habit.elapsedDays} days · streak ${p.habit.streak} · last 7 days ${p.habit.last7}/${p.habit.last7Target}`);
        }),
      );
    }
    case "write": {
      const instruction = rest.join(" ");
      const thread = str(f.thread);
      const r = await api.post<{ subject?: string; text: string; html: string }>("/api/ai/write", { account, instruction, threadId: thread, to: str(f.to) });
      if (f.draft) {
        let draft: Record<string, unknown>;
        if (thread) draft = { ...(await api.post<Record<string, unknown>>("/api/compose", { account, threadId: thread, kind: f.all ? "replyAll" : "reply" })), html: r.html };
        else draft = { account, to: str(f.to) ?? "", subject: r.subject ?? "", html: r.html };
        const d = await api.post<{ draftId: string; threadId: string }>("/api/drafts", draft);
        return out(json, { ...r, ...d }, () => console.log(`${r.subject ? `Subject: ${r.subject}\n\n` : ""}${r.text}\n\n${c.green(`Saved as draft ${d.draftId}`)}`));
      }
      return out(json, r, () => console.log(`${r.subject ? `Subject: ${r.subject}\n\n` : ""}${r.text}`));
    }
    case "replies": {
      const r = await api.post<{ label: string; body: string }[]>("/api/ai/replies", { account, threadId: rest[0] });
      return out(json, r, () => r.forEach((x, i) => console.log(`${c.bold(`${i + 1}. ${x.label}`)}\n${x.body}\n`)));
    }
    case "ask": {
      const q = rest.join(" ");
      if (!q) throw new Error('Usage: iris ask "<question>"');
      const r = await api.post<{ answer: string; threadIds: string[] }>("/api/ai/ask", { account, question: q });
      return out(json, r, () => {
        console.log(r.answer);
        if (r.threadIds.length) console.log(c.el(`\nThreads: ${r.threadIds.join(" ")}`));
      });
    }
    case "research":
      return researchCmd(api, rest, f, account, json);
    case "agent": {
      if (rest[0] !== "allow-send" || !["on", "off"].includes(rest[1])) throw new Error("Usage: iris agent allow-send on|off");
      const on = rest[1] === "on";
      if (on) {
        if (!interactive()) throw new Error("Run this in an interactive terminal: agents cannot grant themselves send permission.");
        const a = await ask("Allow AI agents (MCP/CLI) to send email without your review? Type 'yes': ");
        if (a !== "yes") return void console.log("Unchanged.");
      }
      const human = await connect({ demo, client: "cli-human" });
      await human.patch("/api/settings", { agent: { allowSend: on } });
      return void console.log(on ? "Agents may now send (still with the undo-send window)." : "Agents now save drafts instead of sending.");
    }
    case "config": {
      if (rest[0] === "set") {
        const [key, raw] = rest.slice(1);
        if (!key || raw === undefined) throw new Error("Usage: iris config set <key.path> <value>");
        if (key.startsWith("agent.")) throw new Error("Use: iris agent allow-send on|off");
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          /* string */
        }
        const patch: Record<string, unknown> = {};
        let cur = patch;
        const parts = key.split(".");
        parts.slice(0, -1).forEach((p) => (cur = (cur[p] = {}) as Record<string, unknown>));
        cur[parts[parts.length - 1]] = value;
        return out(json, await api.patch("/api/settings", patch), undefined);
      }
      return out(json, await api.get("/api/settings"), undefined);
    }
    default:
      throw new Error(`Unknown command: ${cmd}. Run: iris help`);
  }
}

// ------------------------------------------------------------ person research

const CONFIDENCE: Record<string, string> = { high: "sure", medium: "probably", low: "unsure" };

function printResearch(r: PersonResearch): void {
  const conf = r.confidence ? c.el(` · ${CONFIDENCE[r.confidence] ?? r.confidence}`) : "";
  console.log(`${c.bold(r.name)}${r.email ? c.el(` <${r.email}>`) : ""}${conf}`);
  if (r.eventTitle) console.log(c.el(`Meeting: ${r.eventTitle}`));
  if (r.status === "running") return void console.log(c.el(`running… ${r.progress}`));
  if (r.status === "failed") return void console.log(c.red(`Failed: ${r.error}`));
  if (r.tldr) console.log(`\n${r.tldr}`);
  console.log(`\n${r.report}`);
  if (r.sources.length) {
    console.log(c.el("\nSources"));
    r.sources.forEach((s, i) => console.log(c.el(`  ${i + 1}. ${s.title} – ${s.url}`)));
  }
}

async function researchCmd(api: IrisClient, rest: string[], f: Record<string, string | boolean>, account: string | undefined, json: boolean): Promise<void> {
  if (rest[0] === "list") {
    const list = await api.get<PersonResearch[]>("/api/research", { account: account ?? "all", limit: str(f.limit) ?? 20 });
    return out(json, list, () => {
      if (!list.length) return void console.log(c.el('No research yet. Try: iris research "Name" --context "…"'));
      for (const r of list) console.log(`${c.el(r.id)}  ${pad(r.name, 24)}  ${pad(r.status === "done" ? r.tldr : r.status === "failed" ? `failed: ${r.error}` : `running… ${r.progress}`, 70)}  ${c.el(ago(r.createdAt))}`);
    });
  }
  if (rest[0] === "show") {
    if (!rest[1]) throw new Error("Usage: iris research show <id>");
    const r = await api.get<PersonResearch>(`/api/research/${encodeURIComponent(rest[1])}`);
    return out(json, r, () => printResearch(r));
  }
  if (rest[0] === "rm" || rest[0] === "delete") {
    if (!rest[1]) throw new Error("Usage: iris research rm <id>");
    return out(json, await api.del(`/api/research/${encodeURIComponent(rest[1])}`), () => console.log("Deleted."));
  }
  const name = rest.join(" ").trim();
  const email = str(f.email);
  if (!name && !email) throw new Error('Usage: iris research "<name>" [--email A] [--context "…"] [--event <calendarId>/<eventId>] [--force]');
  const event = str(f.event);
  const cut = event ? event.lastIndexOf("/") : -1;
  if (event && cut <= 0) throw new Error("--event takes <calendarId>/<eventId> (see: iris cal)");
  let r = await api.post<PersonResearch>("/api/research", {
    account,
    name,
    email,
    context: str(f.context),
    calendarId: event ? event.slice(0, cut) : undefined,
    eventId: event ? event.slice(cut + 1) : undefined,
    force: !!f.force,
  });
  // research runs a few minutes: long-poll and show the live progress line on stderr
  const deadline = Date.now() + 15 * 60_000;
  let shown = "";
  while (r.status === "running" && Date.now() < deadline) {
    if (!json && r.progress && r.progress !== shown) {
      shown = r.progress;
      process.stderr.write(c.el(`… ${shown}\n`));
    }
    r = await api.get<PersonResearch>(`/api/research/${encodeURIComponent(r.id)}`, { wait: 4 });
  }
  if (r.status === "failed" && !json) throw new Error(r.error || "Research failed");
  return out(json, r, () => printResearch(r));
}

async function bodyFrom(f: Record<string, string | boolean>): Promise<string> {
  if (str(f.body) !== undefined) return String(f.body).replace(/\\n/g, "\n");
  if (str(f["body-file"])) return fs.readFileSync(String(f["body-file"]), "utf8");
  return (await readStdin()).trim();
}

async function writeCmd(api: IrisClient, cmd: string, rest: string[], f: Record<string, string | boolean>, account: string | undefined, json: boolean) {
  const text = await bodyFrom(f);
  let draft: Record<string, unknown>;
  if (cmd === "compose") {
    if (!str(f.to)) throw new Error("Usage: iris compose --to A --subject S --body TEXT [--send]");
    draft = { account, to: f.to, cc: str(f.cc), bcc: str(f.bcc), subject: str(f.subject) ?? "", html: textToHtml(text) };
  } else {
    const threadId = rest[0];
    if (!threadId) throw new Error(`Usage: iris ${cmd} <threadId> --body TEXT`);
    const kind = cmd === "forward" ? "forward" : f.all ? "replyAll" : "reply";
    const base = await api.post<Record<string, unknown>>("/api/compose", { account, threadId, kind, messageId: str(f.message) });
    const html = textToHtml(text) + (cmd === "forward" ? String(base.html ?? "") : "");
    draft = { ...base, html };
    if (str(f.to)) draft.to = f.to;
    if (str(f.cc)) draft.cc = f.cc;
    if (str(f.bcc)) draft.bcc = f.bcc;
    if (str(f.subject)) draft.subject = f.subject;
    if (!text && cmd === "reply") throw new Error("Reply body is empty (use --body, --body-file or stdin)");
  }
  draft.accountId = account ?? draft.accountId;
  const v = await api.post<{ errors: string[]; warnings: string[] }>("/api/validate", draft);
  if (v.errors.length) throw new Error(v.errors.join("; "));
  for (const w of v.warnings) console.error(c.red(`warning: ${w}`));

  if (!f.send) {
    const d = await api.post<{ draftId: string; threadId: string }>("/api/drafts", draft);
    return out(json, { status: "drafted", ...d, warnings: v.warnings }, () => console.log(c.green(`Draft saved (${d.draftId}). Review it in Iris, or re-run with --send.`)));
  }
  // A human at a terminal confirms; agents (no TTY) are subject to Settings → Allow sending.
  let client = api;
  if (interactive() && !json) {
    const to = Array.isArray(draft.to) ? (draft.to as { email: string }[]).map((a) => a.email).join(", ") : String(draft.to);
    const yes = f.yes || (await ask(`Send "${draft.subject}" to ${to}? [y/N] `)).toLowerCase().startsWith("y");
    if (!yes) return void console.log("Not sent.");
    client = await connect({ client: "cli-human", demo: !!f.demo || process.env.IRIS_DEMO === "1" });
  }
  const r = await client.post<{ id?: string; status: string; sendAt?: number; draftId?: string; message?: string }>("/api/send", {
    draft,
    sendAt: str(f.at),
    markDone: !!f.done,
  });
  return out(json, r, () => {
    if (r.status === "drafted") console.log(c.purple(r.message ?? "Saved as draft."));
    else console.log(c.green(`Queued ${r.id}, sends ${new Date(r.sendAt!).toLocaleString()}. Cancel: iris cancel ${r.id}`));
  });
}

// ------------------------------------------------------------ calendar

const DAY_MS = 86_400_000;
const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

function printEvents(list: CalendarEvent[]): void {
  if (!list.length) return void console.log(c.el("No events."));
  let day = "";
  for (const e of list) {
    const d = new Date(Math.max(e.start, 0)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    if (d !== day) {
      console.log(`${day ? "\n" : ""}${c.bold(d)}`);
      day = d;
    }
    const when = e.allDayRow ? pad("all day", 11) : `${hm(e.start)}–${hm(e.end)}`;
    const me = e.selfResponse && e.selfResponse !== "accepted" ? c.purple(` [${e.selfResponse === "needsAction" ? "not answered" : e.selfResponse}]`) : "";
    const meet = e.conferenceUrl ? c.el(" · video") : "";
    const guests = e.attendees.filter((a) => !a.self).length;
    console.log(`  ${when}  ${e.selfResponse === "declined" ? c.el(e.summary || "(No title)") : e.summary || "(No title)"}${me}${meet}${guests ? c.el(` · ${guests} guest${guests === 1 ? "" : "s"}`) : ""}  ${c.el(`${e.calendarId} ${e.id}`)}`);
  }
}

function printEvent(e: CalendarEvent): void {
  console.log(c.bold(e.summary || "(No title)"));
  const when = e.allDay
    ? `${new Date(e.start).toLocaleDateString()} (all day${e.end - e.start > DAY_MS ? `, until ${new Date(e.end - 1).toLocaleDateString()}` : ""})`
    : `${new Date(e.start).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} – ${hm(e.end)}`;
  console.log(`  When   ${when}${e.recurringEventId ? " (recurring)" : ""}`);
  if (e.location) console.log(`  Where  ${e.location}`);
  if (e.conferenceUrl) console.log(`  Video  ${e.conferenceUrl}`);
  for (const a of e.attendees) console.log(`  ${a.organizer ? "Host " : "Guest"}  ${a.name ? `${a.name} <${a.email}>` : a.email}  ${c.el(a.responseStatus)}${a.self ? c.el(" (you)") : ""}`);
  if (e.description) console.log(`\n${e.description}`);
  console.log(c.el(`\n${e.calendarId} ${e.id} · ${e.htmlLink}`));
}

/** A human at a terminal confirms actions that email other people; agents (no TTY) stay subject to Settings → Allow sending. */
async function humanClient(api: IrisClient, f: Record<string, string | boolean>, json: boolean, demo: boolean, question: string): Promise<IrisClient | null> {
  if (!interactive() || json) return api;
  const yes = f.yes || (await ask(`${question} [y/N] `)).toLowerCase().startsWith("y");
  if (!yes) return null;
  return connect({ client: "cli-human", demo });
}

async function calCmd(api: IrisClient, rest: string[], f: Record<string, string | boolean>, account: string | undefined, json: boolean, demo: boolean): Promise<void> {
  const sub = rest[0] ?? "today";
  const enc = encodeURIComponent;
  switch (sub) {
    case "calendars": {
      const cals = await api.get<Calendar[]>("/api/calendars", { account });
      return out(json, cals, () =>
        cals.forEach((x) => console.log(`${x.selected ? "●" : "○"} ${pad(x.summary + (x.primary ? " (primary)" : ""), 34)} ${c.el(`${x.accessRole} · ${x.id}`)}`)),
      );
    }
    case "sync":
      return out(json, await api.post("/api/calendar/sync", { account, full: !!f.full }), () => console.log("Calendar synced."));
    case "add":
    case "new": {
      const text = rest.slice(1).join(" ").trim();
      if (!text && !str(f.start)) throw new Error('Usage: iris cal add "Lunch with Anna tomorrow 1pm for 1h" [--attendees a,b] [--meet]');
      const attendees = str(f.attendees)?.split(",").map((x) => x.trim()).filter(Boolean);
      const client = attendees?.length ? await humanClient(api, f, json, demo, `Create the event and email invitations to ${attendees.join(", ")}?`) : api;
      if (!client) return void console.log("Not created.");
      const e = await client.post<CalendarEvent>("/api/events", {
        account,
        text: text || undefined,
        summary: str(f.title),
        start: str(f.start),
        end: str(f.end),
        attendees,
        conference: f.meet ? true : undefined,
        calendarId: str(f.calendar),
        location: str(f.location),
      });
      return out(json, e, () => {
        console.log(c.green("Event scheduled."));
        printEvent(e);
      });
    }
    case "show": {
      const [, cal, id] = rest;
      if (!cal || !id) throw new Error("Usage: iris cal show <calendarId> <eventId>");
      const e = await api.get<CalendarEvent>(`/api/events/${enc(cal)}/${enc(id)}`, { account });
      return out(json, e, () => printEvent(e));
    }
    case "delete":
    case "rm": {
      const [, cal, id] = rest;
      if (!cal || !id) throw new Error("Usage: iris cal delete <calendarId> <eventId> [--all]");
      const e = await api.get<CalendarEvent>(`/api/events/${enc(cal)}/${enc(id)}`, { account });
      const guests = e.attendees.filter((a) => !a.self);
      const client = guests.length && !f["no-notify"] ? await humanClient(api, f, json, demo, `Delete "${e.summary}" and email ${guests.length} guest(s) a cancellation?`) : api;
      if (!client) return void console.log("Not deleted.");
      const r = await client.request("DELETE", `/api/events/${enc(cal)}/${enc(id)}`, { account, scope: f.all ? "all" : undefined, notify: f["no-notify"] ? false : undefined });
      return out(json, r, () => console.log("Event deleted."));
    }
    case "rsvp": {
      const thread = str(f.thread);
      const [cal, id, answer] = thread ? [undefined, undefined, rest[1]] : rest.slice(1);
      if (!answer || (!thread && (!cal || !id))) throw new Error("Usage: iris cal rsvp <calendarId> <eventId> yes|no|maybe [--all]  |  iris cal rsvp --thread <threadId> yes|no|maybe");
      const response = { yes: "accepted", no: "declined", maybe: "tentative" }[answer.toLowerCase()] ?? answer;
      const client = await humanClient(api, f, json, demo, `RSVP "${answer}" (the organizer gets an email)?`);
      if (!client) return void console.log("No RSVP sent.");
      const scope = f.all ? "all" : undefined;
      const r = thread
        ? (await client.post<{ event: CalendarEvent }>(`/api/threads/${enc(thread)}/invite/rsvp`, { account, response, scope, markDone: f.done ? true : undefined })).event
        : await client.post<CalendarEvent>(`/api/events/${enc(cal!)}/${enc(id!)}/rsvp`, { account, response, scope });
      return out(json, r, () => console.log(c.green(`Responded ${{ accepted: "Yes", declined: "No", tentative: "Maybe" }[response] ?? response}: ${r.summary}`)));
    }
    case "free":
    case "availability": {
      const r = await api.get<{ slots: TimeRange[]; text: string }>("/api/availability", { account, days: str(f.days), duration: str(f.duration) });
      return out(json, r, () => console.log(r.text));
    }
    default: {
      // iris cal [today|tomorrow|week|<date>]
      const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
      let from = today;
      let days = 1;
      if (sub === "tomorrow") from = today + DAY_MS;
      else if (sub === "week") days = 7;
      else if (sub !== "today") {
        const input = rest.join(" ");
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(input) ? new Date(`${input}T00:00:00`).getTime() : NaN;
        const at = Number.isFinite(iso) ? iso : (await api.get<{ at: number | null }>("/api/when", { input })).at;
        if (!at) throw new Error(`Unknown calendar command or date: ${input}. Run: iris help`);
        from = new Date(new Date(at).setHours(0, 0, 0, 0)).getTime();
      }
      if (str(f.days)) days = Number(f.days);
      const list = await api.get<CalendarEvent[]>("/api/calendar/events", { account, from, to: from + days * DAY_MS, calendars: str(f.calendars) });
      return out(json, list, () => printEvents(list));
    }
  }
}

// ------------------------------------------------------------ launchd

const LABEL = "app.iris.daemon";

function daemonCmd(sub: string | undefined, demo: boolean): void {
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const uid = process.getuid?.() ?? 501;
  if (sub === "install") {
    if (demo) throw new Error("The demo daemon is not installed at login.");
    const run = path.resolve(import.meta.dirname, "../../server/src/run.ts");
    const log = path.join(irisHome(), "daemon.log");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>--no-warnings=ExperimentalWarning</string><string>${run}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const running = readDaemonInfo(irisHome());
    if (running) {
      try {
        process.kill(running.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    spawnSync("launchctl", ["bootout", `gui/${uid}`, plist], { stdio: "ignore" });
    fs.writeFileSync(plist, xml);
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr}`);
    console.log(`Installed ${plist}. Iris now starts at login.`);
    return;
  }
  if (sub === "uninstall") {
    spawnSync("launchctl", ["bootout", `gui/${uid}`, plist], { stdio: "ignore" });
    fs.rmSync(plist, { force: true });
    console.log("Iris no longer starts at login.");
    return;
  }
  throw new Error("Usage: iris daemon install|uninstall");
}

main().catch((e: unknown) => {
  if (e instanceof IrisApiError && e.code === "ai_unavailable") console.error(c.red(`${e.message}`));
  else console.error(c.red(`error: ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
