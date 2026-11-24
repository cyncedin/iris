// HTTP client for the Iris daemon (used by the CLI and the MCP server). Finds the daemon via
// <home>/daemon.json and starts it in the background when it is not running.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { apiToken, ensureHome, irisHome } from "@iris/core";

export interface DaemonInfo {
  pid: number;
  port: number;
  url: string;
  demo: boolean;
  home: string;
  startedAt: number;
}

export class IrisApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function daemonHome(demo?: boolean): string {
  return demo ? path.join(irisHome(), "demo") : irisHome();
}

export function daemonInfoPath(home: string): string {
  return path.join(home, "daemon.json");
}

export function readDaemonInfo(home: string): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(daemonInfoPath(home), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class IrisClient {
  readonly url: string;
  readonly token: string;
  readonly clientName: string;
  readonly info: DaemonInfo | null;

  constructor(url: string, token: string, clientName = "cli", info: DaemonInfo | null = null) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.clientName = clientName;
    this.info = info;
  }

  async request<T = unknown>(method: string, p: string, body?: unknown, query?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    const res = await fetch(`${this.url}${p}${qs ? `?${qs}` : ""}`, {
      method,
      headers: {
        "x-iris-token": this.token,
        "x-iris-client": this.clientName,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* plain text */
    }
    if (!res.ok) {
      const d = data as { error?: string; code?: string } | null;
      throw new IrisApiError(res.status, d?.error ?? (typeof data === "string" ? data : res.statusText), d?.code);
    }
    return data as T;
  }

  get<T = unknown>(p: string, query?: Record<string, string | number | boolean | undefined | null>) {
    return this.request<T>("GET", p, undefined, query);
  }
  post<T = unknown>(p: string, body: unknown = {}) {
    return this.request<T>("POST", p, body);
  }
  patch<T = unknown>(p: string, body: unknown) {
    return this.request<T>("PATCH", p, body);
  }
  del<T = unknown>(p: string, query?: Record<string, string | undefined>) {
    return this.request<T>("DELETE", p, undefined, query);
  }
}

async function ping(url: string, token: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/status`, { headers: { "x-iris-token": token }, signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Return a client for a running daemon or null. */
export async function findDaemon(opts: { demo?: boolean; client?: string } = {}): Promise<IrisClient | null> {
  const home = daemonHome(opts.demo);
  const info = readDaemonInfo(home);
  if (!info) return null;
  if (!alive(info.pid)) {
    fs.rmSync(daemonInfoPath(home), { force: true });
    return null;
  }
  const token = apiToken(home);
  return (await ping(info.url, token)) ? new IrisClient(info.url, token, opts.client, info) : null;
}

const RUN_SCRIPT = path.resolve(import.meta.dirname, "run.ts");

/** Spawn the daemon detached (logs to <home>/daemon.log) and wait until it answers. */
export async function startDaemonDetached(opts: { demo?: boolean; port?: number; timeoutMs?: number } = {}): Promise<DaemonInfo> {
  const home = daemonHome(opts.demo);
  ensureHome(irisHome());
  const logFile = path.join(opts.demo ? irisHome() : home, opts.demo ? "demo-daemon.log" : "daemon.log");
  const fd = fs.openSync(logFile, "a");
  const args = ["--no-warnings=ExperimentalWarning", RUN_SCRIPT];
  if (opts.demo) args.push("--demo");
  if (opts.port) args.push("--port", String(opts.port));
  const started = Date.now();
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
  const deadline = started + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readDaemonInfo(home);
    if (info && info.startedAt >= started - 1000 && (await ping(info.url, apiToken(home)))) return info;
    if (child.exitCode !== null) break;
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n") : "";
  throw new Error(`Iris daemon did not start. Log (${logFile}):\n${tail}`);
}

/** Connect to the daemon, starting it if needed. */
export async function connect(opts: { demo?: boolean; client?: string; autostart?: boolean } = {}): Promise<IrisClient> {
  const demo = opts.demo ?? process.env.IRIS_DEMO === "1";
  const existing = await findDaemon({ demo, client: opts.client });
  if (existing) return existing;
  if (opts.autostart === false) throw new Error("Iris daemon is not running. Start it with: iris start");
  const info = await startDaemonDetached({ demo });
  return new IrisClient(info.url, apiToken(daemonHome(demo)), opts.client, info);
}
