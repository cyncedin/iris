// Secret storage: macOS Keychain (via `security`) with a 0600 JSON file fallback.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureHome, irisHome } from "./config.ts";

const SERVICE = "Iris Mail";

function useKeychain(): boolean {
  return process.platform === "darwin" && process.env.IRIS_SECRETS !== "file";
}

function fileStore(): string {
  return path.join(ensureHome(irisHome()), "secrets.json");
}

function readFileStore(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(fileStore(), "utf8"));
  } catch {
    return {};
  }
}

export function getSecret(key: string): string | null {
  if (useKeychain()) {
    try {
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", key, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trimEnd();
    } catch {
      return null;
    }
  }
  return readFileStore()[key] ?? null;
}

export function setSecret(key: string, value: string): void {
  if (useKeychain()) {
    // -U updates an existing item. The value is passed via argv to `security`, which is local-only.
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", key, "-w", value], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return;
  }
  const s = readFileStore();
  s[key] = value;
  fs.writeFileSync(fileStore(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function deleteSecret(key: string): void {
  if (useKeychain()) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", key], { stdio: "ignore" });
    } catch {
      /* absent */
    }
    return;
  }
  const s = readFileStore();
  delete s[key];
  fs.writeFileSync(fileStore(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** OpenRouter key (mail classifier): env first, then the secret store. */
export function openRouterApiKey(): string | null {
  return process.env.OPENROUTER_API_KEY || getSecret("openrouter-api-key");
}

/** Anthropic key: env first, then the secret store. */
export function anthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || getSecret("anthropic-api-key");
}
