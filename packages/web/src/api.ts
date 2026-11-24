// Thin client for the local Iris daemon.
import type { IrisEvent } from "@iris/core/types.ts";

interface Boot {
  token?: string;
  demo?: boolean;
}
const boot: Boot = (window as unknown as { __IRIS__?: Boot }).__IRIS__ ?? {};
export const TOKEN = boot.token ?? "";
export const DEMO = !!boot.demo;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(q?: Query): string {
  if (!q) return "";
  const s = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
}

async function req<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await fetch(`${path}${qs(query)}`, {
    method,
    headers: { "x-iris-token": TOKEN, "x-iris-client": "ui", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string } | null;
    throw new ApiError(res.status, d?.error ?? res.statusText, d?.code);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string, q?: Query) => req<T>("GET", p, undefined, q),
  post: <T>(p: string, b: unknown = {}, q?: Query) => req<T>("POST", p, b, q),
  patch: <T>(p: string, b: unknown, q?: Query) => req<T>("PATCH", p, b, q),
  del: <T>(p: string, q?: Query) => req<T>("DELETE", p, undefined, q),
};

/** `account`: the message's account (unified views mix accounts; without it the daemon uses the first one). */
export function attachmentUrl(messageId: string, attachmentId: string, download = false, account?: string): string {
  return `/api/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}${qs({ token: TOKEN, account, download: download ? 1 : undefined })}`;
}

const EVENT_TYPES = ["sync", "threads-changed", "thread-updated", "outbox", "reminder", "notification", "error", "account", "calendar-changed", "goals-changed", "research-changed", "hello"];

/** Subscribe to daemon events (auto-reconnects). */
export function subscribe(fn: (e: IrisEvent) => void, onConnection?: (up: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const open = () => {
    es = new EventSource(`/api/events${qs({ token: TOKEN })}`);
    for (const t of EVENT_TYPES)
      es.addEventListener(t, (m) => {
        if (t === "hello") return onConnection?.(true);
        try {
          fn(JSON.parse((m as MessageEvent).data) as IrisEvent);
        } catch {
          /* ignore */
        }
      });
    es.onerror = () => {
      onConnection?.(false);
      es?.close();
      if (!closed) retry = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}

export interface WriteResult {
  subject?: string;
  text: string;
  html: string;
}

/** Streams "Write with AI" output. */
export async function streamWrite(
  body: { account?: string; instruction: string; threadId?: string; draft?: string; to?: string },
  onDelta: (d: string) => void,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const res = await fetch("/api/ai/write", {
    method: "POST",
    headers: { "x-iris-token": TOKEN, "x-iris-client": "ui", "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) {
    const d = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(res.status, d.error ?? res.statusText, d.code);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: WriteResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (ev === "delta") onDelta(JSON.parse(data));
      else if (ev === "done") result = JSON.parse(data);
      else if (ev === "error") throw new Error(JSON.parse(data).error);
    }
  }
  if (!result) throw new Error("AI stream ended unexpectedly");
  return result;
}
