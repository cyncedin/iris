import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface IrisSettings {
  port: number;
  undoSendSeconds: number;
  syncIntervalSeconds: number;
  initialSyncDays: number;
  initialSyncMaxThreads: number;
  defaultReminderHour: number; // local hour for "tomorrow", "next week" ...
  autoAdvance: "next" | "previous" | "list";
  /** "glass" = light default (macOS-style glass), "graphite" = dark, "paper" = classic light, "system" = glass/graphite by OS */
  theme: "glass" | "graphite" | "paper" | "system";
  blockRemoteImages: boolean;
  ai: {
    enabled: boolean;
    model: string;
    autoSummarize: boolean;
    autoLabels: boolean;
    autoLabelCategories: string[];
    /** what each category means, shown to the classifier */
    autoLabelGuide: Record<string, string>;
    /** OpenRouter model that labels new mail */
    classifyModel: string;
    /** target language of "Translate" (Claude Haiku 5.5) */
    translateTo: string;
    /** language of person research reports (Claude Opus 5.5) */
    researchLanguage: string;
    /** ask "Research nötig?" when a meeting with other people starts */
    researchPrompt: boolean;
    /** the user's nicknames ("Alex", "Al"): never guessed as the other person from a meeting title */
    researchSelfNames: string[];
  };
  agent: {
    /** MCP/CLI agents may send mail without a human click. Default false => drafts only. */
    allowSend: boolean;
  };
  calendar: {
    /** meeting notification lead time: 60, 120 or 300 seconds */
    notifyLeadSeconds: number;
    /** add a Meet link to new events unless the request says otherwise */
    defaultMeetingLink: "meet" | null;
    /** RSVP from an invite also marks the thread done */
    rsvpAndDone: boolean;
  };
}

export const DEFAULT_SETTINGS: IrisSettings = {
  port: 7787,
  undoSendSeconds: 10,
  syncIntervalSeconds: 30,
  initialSyncDays: 30,
  initialSyncMaxThreads: 1500,
  defaultReminderHour: 8,
  autoAdvance: "next",
  theme: "glass",
  blockRemoteImages: false,
  ai: {
    enabled: true,
    model: "claude-haiku-5-5",
    autoSummarize: false,
    autoLabels: false,
    autoLabelCategories: ["Needs Reply", "FYI", "Newsletter", "Marketing", "Notification", "Calendar", "Receipt", "Cold Pitch"],
    autoLabelGuide: {},
    classifyModel: "typesafe/jev-router",
    translateTo: "English",
    researchLanguage: "English",
    researchPrompt: true,
    researchSelfNames: [],
  },
  agent: { allowSend: false },
  calendar: { notifyLeadSeconds: 120, defaultMeetingLink: null, rsvpAndDone: false },
};

export function irisHome(): string {
  const env = process.env.IRIS_HOME;
  if (env) return path.resolve(env);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Iris");
  return path.join(os.homedir(), ".iris");
}

export function ensureHome(home = irisHome()): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export function loadSettings(home = irisHome()): IrisSettings {
  const file = path.join(home, "settings.json");
  let s = DEFAULT_SETTINGS;
  try {
    s = deepMerge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    /* defaults */
  }
  if (process.env.IRIS_PORT) s = { ...s, port: Number(process.env.IRIS_PORT) };
  return s;
}

export function saveSettings(patch: Partial<IrisSettings>, home = irisHome()): IrisSettings {
  ensureHome(home);
  const next = deepMerge(loadSettings(home), patch);
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Local API token shared by daemon, CLI, MCP and UI. Protects the localhost API from other local web pages. */
export function apiToken(home = irisHome()): string {
  ensureHome(home);
  const file = path.join(home, "api-token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* create */
  }
  const t = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

// ---------------------------------------------------------------- accounts

/** `account=all` on reads: every connected account at once (All Inboxes). */
export const ALL_ACCOUNTS = "all";

export function isAllAccounts(accountId: string | null | undefined): boolean {
  return typeof accountId === "string" && accountId.toLowerCase() === ALL_ACCOUNTS;
}

/**
 * Account colors by connection order: Apple blue, orange, green, pink, teal, indigo. Darkened where needed so the
 * dot keeps >= 3.6:1 (non-text contrast) on the white sheet and on a light glass pane (#f5f8fb).
 */
export const ACCOUNT_COLORS = ["#007aff", "#c46a00", "#248a3d", "#e3204b", "#0a84a0", "#5856d6"] as const;

export function accountColor(index: number): string {
  const n = ACCOUNT_COLORS.length;
  return ACCOUNT_COLORS[((Math.max(0, index) % n) + n) % n];
}

/** Unified built-in split ids: select the Important / Other split of every account. */
export const BUILTIN_SPLITS = { important: "builtin:important", other: "builtin:other" } as const;

export function builtinSplitKind(splitId: string | null | undefined): "important" | "other" | null {
  return splitId === BUILTIN_SPLITS.important ? "important" : splitId === BUILTIN_SPLITS.other ? "other" : null;
}
