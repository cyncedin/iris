// Google OAuth 2.0 for installed apps: loopback redirect + PKCE.
import http from "node:http";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { getSecret, setSecret, deleteSecret } from "../secrets.ts";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
/** One consent for mail and calendar (read, create, edit, RSVP). */
export const GMAIL_SCOPES = ["https://mail.google.com/", CALENDAR_SCOPE, "openid", "email", "profile"];
export const CALENDAR_SCOPE_ERROR = "Calendar access not granted yet. Run: iris auth login";

/** false when a granted scope string is known to lack calendar access (accounts authorized before calendar support). */
export function scopeAllowsCalendar(scope: string | undefined): boolean {
  if (!scope) return true; // unknown: let the API decide
  return scope.split(/\s+/).includes(CALENDAR_SCOPE);
}

export interface OAuthClient {
  client_id: string;
  client_secret: string;
}

export interface TokenSet {
  refresh_token: string;
  access_token?: string;
  expiry?: number; // epoch ms
  scope?: string;
}

const CLIENT_KEY = "google-oauth-client";

export function importClientFile(file: string): OAuthClient {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = json.installed ?? json.web;
  if (!c?.client_id || !c?.client_secret) throw new Error("Not a Google OAuth client JSON (expected an 'installed' Desktop client)");
  const client = { client_id: c.client_id as string, client_secret: c.client_secret as string };
  setSecret(CLIENT_KEY, JSON.stringify(client));
  return client;
}

export function getClient(): OAuthClient | null {
  const env = process.env.IRIS_GOOGLE_CLIENT_ID && process.env.IRIS_GOOGLE_CLIENT_SECRET;
  if (env) return { client_id: process.env.IRIS_GOOGLE_CLIENT_ID!, client_secret: process.env.IRIS_GOOGLE_CLIENT_SECRET! };
  const raw = getSecret(CLIENT_KEY);
  return raw ? (JSON.parse(raw) as OAuthClient) : null;
}

const tokenKey = (email: string) => `google-token:${email.toLowerCase()}`;

export function loadTokens(email: string): TokenSet | null {
  const raw = getSecret(tokenKey(email));
  return raw ? (JSON.parse(raw) as TokenSet) : null;
}

export function saveTokens(email: string, t: TokenSet): void {
  setSecret(tokenKey(email), JSON.stringify(t));
}

export function forgetTokens(email: string): void {
  deleteSecret(tokenKey(email));
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open manually */
  }
}

export interface LoginResult {
  email: string;
  name: string;
  tokens: TokenSet;
}

/**
 * Runs the browser consent flow. Resolves after Google redirects back to the loopback server.
 * `onUrl` receives the consent URL (printed by the CLI in case the browser does not open).
 */
export async function loginWithBrowser(opts: { loginHint?: string; onUrl?: (url: string) => void; timeoutMs?: number } = {}): Promise<LoginResult> {
  const client = getClient();
  if (!client) throw new Error("No Google OAuth client configured. Run: iris auth client <path-to-client_secret.json>");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  opts.onUrl?.(url);
  openBrowser(url);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth login timed out")), opts.timeoutMs ?? 5 * 60_000);
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const got = u.searchParams.get("code");
      const okState = u.searchParams.get("state") === state;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (err || !got || !okState) {
        res.end(`<h2>Iris: login failed</h2><p>${err ?? "missing code/state"}</p>`);
        clearTimeout(timer);
        reject(new Error(`OAuth error: ${err ?? "invalid callback"}`));
        return;
      }
      res.end(`<html><body style="font-family:-apple-system;background:#1f1e1d;color:#eee;display:grid;place-items:center;height:100vh"><div><h2>Iris is connected ✓</h2><p>You can close this tab.</p></div></body></html>`);
      clearTimeout(timer);
      resolve(got);
    });
  }).finally(() => server.close());

  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tok = (await tokRes.json()) as Record<string, unknown>;
  if (!tokRes.ok || !tok.refresh_token) throw new Error(`Token exchange failed: ${JSON.stringify(tok)}`);
  const tokens: TokenSet = {
    refresh_token: tok.refresh_token as string,
    access_token: tok.access_token as string,
    expiry: Date.now() + Number(tok.expires_in ?? 3600) * 1000,
    scope: tok.scope as string,
  };
  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }).then((r) => r.json() as Promise<{ email?: string; name?: string }>);
  if (!info.email) throw new Error("Could not read account email from Google");
  saveTokens(info.email, tokens);
  return { email: info.email.toLowerCase(), name: info.name ?? "", tokens };
}

export async function refreshAccessToken(email: string): Promise<TokenSet> {
  const client = getClient();
  const t = loadTokens(email);
  if (!client || !t) throw new Error(`No credentials for ${email}. Run: iris auth login`);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const e = new Error(`Token refresh failed for ${email}: ${body.error ?? res.status} ${body.error_description ?? ""}`);
    (e as Error & { authExpired?: boolean }).authExpired = body.error === "invalid_grant";
    throw e;
  }
  const next: TokenSet = {
    ...t,
    access_token: body.access_token as string,
    expiry: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    ...(typeof body.scope === "string" && body.scope ? { scope: body.scope } : {}),
  };
  saveTokens(email, next);
  return next;
}
