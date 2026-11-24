import { useEffect, useState } from "react";
import type { Snippet } from "@iris/core/types.ts";
import { api, DEMO } from "../api";
import {
  ALL,
  boot,
  defaultAccount,
  errorToast,
  getState,
  loadMailboxes,
  loadSplits,
  refreshStatus,
  resolveTheme,
  setState,
  toast,
  useApp,
  type Settings as S,
  type SplitWithCount,
} from "../state";
import { Icon } from "./Icon";
import { AccountDot } from "./Overlays";

/** Native <select> (keeps its keyboard model) with a chevron-down Icon overlay. */
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select">
      <select {...props} />
      <Icon name="chevron-down" size={14} />
    </span>
  );
}

const SECTIONS = [
  ["accounts", "Accounts"],
  ["general", "General"],
  ["splits", "Split Inbox"],
  ["snippets", "Snippets"],
  ["ai", "Iris AI"],
  ["agents", "Agents & MCP"],
] as const;

async function save(patch: Partial<S> | Record<string, unknown>) {
  try {
    await api.patch("/api/settings", patch);
    await refreshStatus();
  } catch (e) {
    errorToast(e);
  }
}

function Accounts() {
  const status = useApp((s) => s.status);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ loginId: string; url: string }>("/api/accounts/gmail", {});
      toast({ text: "Finish signing in with Google in your browser…" }, 8000);
      for (let i = 0; i < 300; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const s = await api.get<{ status: string; email?: string; error?: string }>(`/api/accounts/login/${r.loginId}`);
        if (s.status === "done") {
          toast({ text: `Connected ${s.email}. Syncing…` });
          await boot();
          break;
        }
        if (s.status === "error") throw new Error(s.error);
      }
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {status?.accounts.map((a, i) => (
        <div key={a.id} className="set-row">
          <AccountDot id={a.id} size={10} />
          <div className="set-grow">
            <div className="set-strong">
              {a.email}
              {i < 9 && status.accounts.length > 1 && <span className="set-key">⌃{i + 1}</span>}
            </div>
            <div className="set-el">
              {a.provider === "fake" ? "Demo mailbox" : "Gmail"} · {a.threads} conversations cached · last sync {a.lastSyncAt ? new Date(a.lastSyncAt).toLocaleTimeString() : "never"}
            </div>
          </div>
          {a.provider !== "fake" && (
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (!confirm(`Disconnect ${a.email}? Local cache is removed; nothing is deleted in Gmail.`)) return;
                await api.del(`/api/accounts/${encodeURIComponent(a.id)}`);
                await boot();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      ))}
      {!DEMO && (
        <button className="primary" disabled={busy} onClick={() => void add()}>
          <Icon name="plus" size={14} />
          {busy ? "Waiting for Google…" : "Connect Gmail account"}
        </button>
      )}
    </>
  );
}

function General() {
  const s = useApp((st) => st.status?.settings);
  if (!s) return null;
  return (
    <>
      <div className="set-row">
        <span>Undo Send window</span>
        <Select value={s.undoSendSeconds} onChange={(e) => void save({ undoSendSeconds: Number(e.target.value) })}>
          {[0, 5, 10, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n ? `${n} seconds` : "Off"}
            </option>
          ))}
        </Select>
      </div>
      <div className="set-row">
        <span>After Done / Trash</span>
        <Select value={s.autoAdvance} onChange={(e) => void save({ autoAdvance: e.target.value as S["autoAdvance"] })}>
          <option value="next">Open next conversation</option>
          <option value="previous">Open previous conversation</option>
          <option value="list">Return to list</option>
        </Select>
      </div>
      <div className="set-row">
        <span>Reminder default time</span>
        <Select value={s.defaultReminderHour} onChange={(e) => void save({ defaultReminderHour: Number(e.target.value) })}>
          {[6, 7, 8, 9, 10, 13, 17].map((h) => (
            <option key={h} value={h}>
              {h}:00
            </option>
          ))}
        </Select>
      </div>
      <div className="set-row">
        <span>Theme</span>
        <Select
          value={s.theme}
          onChange={(e) => {
            const theme = e.target.value as S["theme"];
            void save({ theme });
            setState({ theme: resolveTheme(theme) });
          }}
        >
          <option value="glass">Glass (light)</option>
          <option value="graphite">Graphite (dark)</option>
          <option value="paper">Paper (classic light)</option>
          <option value="system">System (Glass / Graphite)</option>
        </Select>
      </div>
      <div className="set-row">
        <span>Block remote images (tracking pixels)</span>
        <input type="checkbox" checked={s.blockRemoteImages} onChange={(e) => void save({ blockRemoteImages: e.target.checked })} />
      </div>
      <div className="set-row">
        <span>Desktop notifications</span>
        <button className="btn" onClick={() => void Notification.requestPermission().then((p) => toast({ text: `Notifications: ${p}` }))}>
          {typeof Notification !== "undefined" && Notification.permission === "granted" ? "Enabled" : "Enable"}
        </button>
      </div>
    </>
  );
}

/** Splits are per account: pick the account (All Inboxes shows the built-in Important/Other of every account). */
function Splits() {
  const accounts = useApp((s) => s.status?.accounts ?? []);
  const [account, setAccount] = useState(() => defaultAccount() ?? "");
  const [splits, setSplits] = useState<SplitWithCount[]>([]);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const reload = async () => {
    try {
      setSplits(await api.get<SplitWithCount[]>("/api/splits", { account: account || undefined }));
    } catch (e) {
      errorToast(e);
    }
  };
  useEffect(() => void reload(), [account]);
  // the top bar shows the route's splits: refresh them when they are this account's (or the unified ones)
  const changed = async () => {
    await reload();
    const scope = getState().route.account;
    if (scope === account || scope === ALL) await loadSplits();
    void loadMailboxes();
  };
  const q = { account: account || undefined };
  const add = async () => {
    try {
      await api.post("/api/splits", { name, query }, q);
      setName("");
      setQuery("");
      await changed();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <>
      <p className="set-el">Splits are saved searches that sit above your inbox. Matching conversations leave Important/Other. Query examples: from:@stripe.com · list:* · subject:invoice · label:clients</p>
      {accounts.length > 1 && (
        <div className="set-row">
          <span>Account</span>
          <Select value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </Select>
        </div>
      )}
      {splits.map((s) => (
        <div key={s.id} className="set-row">
          <div>
            <div className="set-strong">{s.name}</div>
            <div className="set-el">{s.builtin === "other" ? "Everything else" : s.query}</div>
          </div>
          <div className="set-actions">
            <input
              type="checkbox"
              title="Enabled"
              checked={s.enabled}
              disabled={!!s.builtin}
              onChange={async (e) => {
                await api.patch(`/api/splits/${s.id}`, { enabled: e.target.checked }, q);
                await changed();
              }}
            />
            {!s.builtin && (
              <button
                className="icon-btn sm"
                title="Delete split"
                aria-label="Delete split"
                onClick={async () => {
                  await api.del(`/api/splits/${s.id}`, q);
                  await changed();
                }}
              >
                <Icon name="trash" />
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="set-form">
        <input placeholder="Name (e.g. Team)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Query (e.g. from:@northstar.ai)" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button className="primary" disabled={!name || !query} onClick={() => void add()}>
          Add split
        </button>
      </div>
    </>
  );
}

function Snippets() {
  const [list, setList] = useState<Snippet[]>([]);
  const [edit, setEdit] = useState<Partial<Snippet> | null>(null);
  const load = () => void api.get<Snippet[]>("/api/snippets").then(setList).catch(errorToast);
  useEffect(load, []);
  const saveSnippet = async () => {
    if (!edit?.name || !edit.html) return;
    try {
      await api.post("/api/snippets", { ...edit, html: edit.html.includes("<") ? edit.html : edit.html.replace(/\n/g, "<br>") });
      setEdit(null);
      load();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <>
      <p className="set-el">Type ; in a message (or ⌘;) to insert. Variables: {"{first_name} {last_name} {full_name} {email} {my_first_name} {my_name} {date} {weekday}"}</p>
      {list.map((s) => (
        <div key={s.id} className="set-row">
          <div>
            <div className="set-strong">{s.name}</div>
            <div className="set-el">{s.html.replace(/<[^>]+>/g, " ").slice(0, 90)}</div>
          </div>
          <div className="set-actions">
            <button className="btn sm" onClick={() => setEdit({ ...s, html: s.html.replace(/<br\s*\/?>/g, "\n").replace(/<\/?div>/g, "\n").replace(/\n{2,}/g, "\n").trim() })}>
              Edit
            </button>
            <button
              className="icon-btn sm"
              title="Delete snippet"
              aria-label="Delete snippet"
              onClick={async () => {
                await api.del(`/api/snippets/${s.id}`);
                load();
              }}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
      ))}
      {edit ? (
        <div className="set-form col">
          <input placeholder="Name (e.g. intro)" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <input placeholder="Subject (optional)" value={edit.subject ?? ""} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
          <textarea rows={6} placeholder="Hi {first_name}, …" value={edit.html ?? ""} onChange={(e) => setEdit({ ...edit, html: e.target.value })} />
          <div className="set-actions">
            <button className="primary" onClick={() => void saveSnippet()}>
              Save snippet
            </button>
            <button className="btn" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="primary" onClick={() => setEdit({ name: "", html: "" })}>
          <Icon name="plus" size={14} />
          New snippet
        </button>
      )}
    </>
  );
}

function AI() {
  const status = useApp((s) => s.status);
  const [key, setKey] = useState("");
  const s = status?.settings;
  if (!s) return null;
  return (
    <>
      <div className="set-row">
        <div>
          <div className="set-strong">Claude API</div>
          <div className="set-el">
            Model: {s.ai.model} · {status?.ai.available ? "connected" : "no API key"}
          </div>
        </div>
        <span className={`pill ${status?.ai.available ? "ok" : "warn"}`}>
          {status?.ai.available ? <Icon name="check" size={12} stroke={2} /> : <Icon name="alert" size={12} stroke={2} />}
          {status?.ai.available ? "On" : "Off"}
        </span>
      </div>
      <div className="set-form">
        <input type="password" autoComplete="off" placeholder="sk-ant-… (stored in macOS Keychain)" value={key} onChange={(e) => setKey(e.target.value)} />
        <button
          className="primary"
          disabled={!key}
          onClick={async () => {
            try {
              await api.post("/api/ai/key", { key });
              setKey("");
              await refreshStatus();
              toast({ text: "API key saved to Keychain" });
            } catch (e) {
              errorToast(e);
            }
          }}
        >
          Save key
        </button>
      </div>
      <div className="set-row">
        <span>Auto-label new mail with {s.ai.classifyModel}</span>
        <input type="checkbox" checked={s.ai.autoLabels} onChange={(e) => void save({ ai: { ...s.ai, autoLabels: e.target.checked } })} />
      </div>
      <div className="set-row">
        <span>Translate mail into (⇧T, Claude Haiku 5.5)</span>
        <select value={s.ai.translateTo} aria-label="Translation language" onChange={(e) => void save({ ai: { ...s.ai, translateTo: e.target.value } })}>
          {["German", "English", "Greek"].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </div>
      <div className="set-row">
        <span>AI enabled</span>
        <input type="checkbox" checked={s.ai.enabled} onChange={(e) => void save({ ai: { ...s.ai, enabled: e.target.checked } })} />
      </div>
      <p className="set-el">Summaries (I), Write with AI (⌘J), Instant Reply, Translate (⇧T) and Ask AI (?) run through your own Anthropic API key. Mail content goes to the Claude API only when you use an AI feature.</p>
    </>
  );
}

function Agents() {
  const s = useApp((st) => st.status?.settings);
  const root = useApp((st) => st.status?.repo ?? "");
  const node = useApp((st) => st.status?.node ?? "node");
  const [copied, setCopied] = useState("");
  if (!s) return null;
  const cmds = [
    ["Claude Code", `claude mcp add --scope user iris -- "${node}" --no-warnings=ExperimentalWarning "${root}/packages/mcp/src/main.ts"`],
    ["Codex (~/.codex/config.toml)", `[mcp_servers.iris]\ncommand = "${node}"\nargs = ["--no-warnings=ExperimentalWarning", "${root}/packages/mcp/src/main.ts"]`],
    ["Any MCP client (JSON)", JSON.stringify({ mcpServers: { iris: { command: node, args: ["--no-warnings=ExperimentalWarning", `${root}/packages/mcp/src/main.ts`] } } }, null, 2)],
    ["CLI (agents: add --json)", `iris inbox --json\niris search "from:anna newer_than:7d" --json\niris read <threadId> --json\niris reply <threadId> --body "…"   # saves a draft`],
  ];
  return (
    <>
      <div className="set-row">
        <div>
          <div className="set-strong">Allow agents to send email</div>
          <div className="set-el">Off: agents (MCP/CLI) can read, triage and write drafts; send_email saves a draft for you to review. On: they send through the undo-send window.</div>
        </div>
        <input type="checkbox" checked={s.agent.allowSend} onChange={(e) => void save({ agent: { allowSend: e.target.checked } })} />
      </div>
      {cmds.map(([name, cmd]) => (
        <div key={name} className="codeblock">
          <div className="code-head">
            <span>{name}</span>
            <button
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(cmd);
                setCopied(name);
              }}
            >
              {copied === name ? <Icon name="check" size={14} /> : null}
              {copied === name ? "Copied" : "Copy"}
            </button>
          </div>
          <pre>{cmd}</pre>
        </div>
      ))}
    </>
  );
}

export function SettingsPanel({ section }: { section?: string }) {
  const [sec, setSec] = useState(section ?? "accounts");
  useEffect(() => setSec(section ?? "accounts"), [section]);
  return (
    <div className="modal-backdrop" onMouseDown={() => setState({ overlay: null })}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && setState({ overlay: null }))} tabIndex={-1} ref={(el) => {
          if (el && !el.contains(document.activeElement)) el.focus();
        }}>
        <nav>
          <div className="settings-head">
            <Icon name="settings" />
            Settings
          </div>
          {SECTIONS.map(([id, label]) => (
            <button key={id} className={sec === id ? "on" : ""} onClick={() => setSec(id)}>
              {label}
            </button>
          ))}
        </nav>
        <section>
          <h3>{SECTIONS.find(([id]) => id === sec)?.[1]}</h3>
          {sec === "accounts" && <Accounts />}
          {sec === "general" && <General />}
          {sec === "splits" && <Splits />}
          {sec === "snippets" && <Snippets />}
          {sec === "ai" && <AI />}
          {sec === "agents" && <Agents />}
        </section>
      </div>
    </div>
  );
}
