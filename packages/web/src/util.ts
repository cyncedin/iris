import type { Address } from "@iris/core/types.ts";

export function relTime(ms: number): string {
  const now = new Date();
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const diff = now.getTime() - ms;
  if (diff < 6 * 86_400_000 && diff > 0) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function fullTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function futureTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
  if (ms - now.getTime() < 7 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: "long" })}, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

export function nameOf(a: Address | null | undefined): string {
  if (!a) return "";
  return a.name || a.email.split("@")[0];
}

export function firstName(a: Address | null | undefined): string {
  return nameOf(a).split(/[\s,]+/)[0];
}

export function initials(a: Address | null | undefined): string {
  const n = nameOf(a).replace(/[^\p{L}\s]/gu, "").trim();
  const parts = n.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// no purple/magenta (Glass look)
const HUES = [212, 188, 150, 18, 350, 42, 115, 70, 228, 175];
export function avatarColor(email: string): string {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${HUES[h % HUES.length]} 45% 55%)`;
}

export function parseAddresses(s: string): Address[] {
  const out: Address[] = [];
  for (const part of s.split(/[,;\n]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(.*)<([^>]+)>$/);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ""), email: m[2].trim().toLowerCase() });
    else out.push({ name: "", email: p.toLowerCase() });
  }
  return out;
}

export function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Simple fuzzy score: all query chars in order; bonus for word starts and contiguity. */
export function fuzzy(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  if (t.includes(query)) return 100 - t.indexOf(query);
  let ti = 0;
  let score = 0;
  for (const ch of query) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    score += i === ti ? 3 : i === 0 || t[i - 1] === " " ? 2 : 1;
    ti = i + 1;
  }
  return score;
}
