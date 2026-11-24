// Gmail-style query language, evaluated locally (split inboxes, offline search).
// Supports: from: to: cc: bcc: subject: label: in: is: has: list: category: filename: newer_than: older_than: after: before:
// plus free text, "quoted phrases", -negation, OR, and ( ) grouping.

export type QNode =
  | { t: "and"; c: QNode[] }
  | { t: "or"; c: QNode[] }
  | { t: "not"; c: QNode }
  | { t: "op"; op: string; v: string }
  | { t: "text"; v: string };

function tokenize(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      out.push(ch === "{" ? "(" : ch === "}" ? ")" : ch);
      i++;
      continue;
    }
    let tok = "";
    let inQ = false;
    while (i < q.length) {
      const c = q[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && (/\s/.test(c) || c === "(" || c === ")")) break;
      tok += c;
      i++;
    }
    out.push(tok);
  }
  return out;
}

export function parseQuery(q: string): QNode {
  const toks = tokenize(q);
  let pos = 0;
  const peek = () => toks[pos];
  function orExpr(): QNode {
    const parts = [andExpr()];
    while (peek() === "OR" || peek() === "|") {
      pos++;
      parts.push(andExpr());
    }
    return parts.length === 1 ? parts[0] : { t: "or", c: parts };
  }
  function andExpr(): QNode {
    const parts: QNode[] = [];
    while (pos < toks.length && peek() !== ")" && peek() !== "OR" && peek() !== "|") parts.push(unary());
    return parts.length === 1 ? parts[0] : { t: "and", c: parts };
  }
  function unary(): QNode {
    const tok = peek();
    if (tok.startsWith("-") && tok.length > 1) {
      toks[pos] = tok.slice(1);
      return { t: "not", c: unary() };
    }
    return primary();
  }
  function primary(): QNode {
    const tok = toks[pos++];
    if (tok === "(") {
      const e = orExpr();
      if (peek() === ")") pos++;
      return e;
    }
    const m = tok.match(/^([a-z_]+):(.*)$/i);
    if (m && m[2] !== "") return { t: "op", op: m[1].toLowerCase(), v: unquote(m[2]).toLowerCase() };
    if (m && m[2] === "" && peek() === "(") {
      // from:(a OR b)
      pos++;
      const inner = orExpr();
      if (peek() === ")") pos++;
      return mapText(inner, m[1].toLowerCase());
    }
    return { t: "text", v: unquote(tok).toLowerCase() };
  }
  if (!toks.length) return { t: "and", c: [] };
  return orExpr();
}

function mapText(n: QNode, op: string): QNode {
  switch (n.t) {
    case "text":
      return { t: "op", op, v: n.v };
    case "and":
    case "or":
      return { ...n, c: n.c.map((c) => mapText(c, op)) };
    case "not":
      return { t: "not", c: mapText(n.c, op) };
    default:
      return n;
  }
}

function unquote(s: string): string {
  return s.replace(/^"(.*)"$/, "$1");
}

/** What the evaluator needs to know about a thread. */
export interface QueryTarget {
  subject: string;
  from: string; // lowercased "name email" of all senders
  to: string; // to/cc/bcc text
  cc?: string;
  body: string; // lowercased text incl. attachment names
  labelIds: string[];
  labelNames: string[]; // lowercased
  listId: string;
  attachments: string; // filenames lowercased
  lastDate: number;
  unread: boolean;
  starred: boolean;
  important: boolean;
  snoozed: boolean;
  muted: boolean;
}

const DAY = 86_400_000;

function relTime(v: string): number {
  const m = v.match(/^(\d+)([dmy h])?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] ?? "d";
  const mult = unit === "h" ? DAY / 24 : unit === "m" ? 30 * DAY : unit === "y" ? 365 * DAY : DAY;
  return n * mult;
}

function absDate(v: string): number {
  const m = v.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (/^\d{9,}$/.test(v)) return Number(v) * 1000;
  return Date.parse(v) || 0;
}

const CATEGORY: Record<string, string> = {
  primary: "CATEGORY_PERSONAL",
  personal: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

export function evaluate(n: QNode, t: QueryTarget): boolean {
  switch (n.t) {
    case "and":
      return n.c.every((c) => evaluate(c, t));
    case "or":
      return n.c.some((c) => evaluate(c, t));
    case "not":
      return !evaluate(n.c, t);
    case "text":
      return !n.v || `${t.subject} ${t.from} ${t.to} ${t.body}`.includes(n.v);
    case "op": {
      const v = n.v;
      const hasLabel = (id: string) => t.labelIds.includes(id);
      switch (n.op) {
        case "from":
          return v === "me" ? t.labelIds.includes("SENT") : t.from.includes(v);
        case "to":
          return t.to.includes(v);
        case "cc":
        case "bcc":
          return (t.cc ?? t.to).includes(v);
        case "subject":
          return t.subject.includes(v);
        case "label": {
          const norm = v.replace(/-/g, " ");
          return t.labelNames.some((l) => l === v || l === norm || l.replace(/[/-]/g, " ") === norm) || hasLabel(v.toUpperCase());
        }
        case "in":
          if (v === "anywhere") return true;
          if (v === "inbox") return hasLabel("INBOX");
          if (v === "sent") return hasLabel("SENT");
          if (v === "drafts" || v === "draft") return hasLabel("DRAFT");
          if (v === "spam") return hasLabel("SPAM");
          if (v === "trash") return hasLabel("TRASH");
          if (v === "starred") return t.starred;
          if (v === "important") return t.important;
          return t.labelNames.includes(v);
        case "is":
          if (v === "unread") return t.unread;
          if (v === "read") return !t.unread;
          if (v === "starred") return t.starred;
          if (v === "important") return t.important;
          if (v === "snoozed") return t.snoozed;
          if (v === "muted") return t.muted;
          return false;
        case "has":
          if (v === "attachment" || v === "attachments") return t.attachments.length > 0;
          if (v === "userlabels") return t.labelIds.some((l) => /^Label_/.test(l));
          if (v === "nouserlabels") return !t.labelIds.some((l) => /^Label_/.test(l));
          return t.body.includes(v);
        case "filename":
          return t.attachments.includes(v);
        case "list":
          return t.listId.includes(v);
        case "category":
          return hasLabel(CATEGORY[v] ?? `CATEGORY_${v.toUpperCase()}`);
        case "newer_than":
          return t.lastDate >= Date.now() - relTime(v);
        case "older_than":
          return t.lastDate < Date.now() - relTime(v);
        case "after":
        case "newer":
          return t.lastDate >= absDate(v);
        case "before":
        case "older":
          return t.lastDate < absDate(v);
        default:
          // unknown operator: treat as text so we never silently drop everything
          return `${t.subject} ${t.body}`.includes(`${n.op}:${v}`);
      }
    }
  }
}

/** Positive free-text terms, used to pre-filter with FTS. */
export function positiveTerms(n: QNode): string[] {
  if (n.t === "text") return n.v ? [n.v] : [];
  if (n.t === "and") return n.c.flatMap(positiveTerms);
  return [];
}

/** FTS5 expression for a set of positive terms (prefix match on last word, phrases quoted). */
export function ftsExpression(terms: string[]): string {
  return terms
    .map((t) => t.replace(/["*^():]/g, " ").trim())
    .filter(Boolean)
    .map((t) => (t.includes(" ") ? `"${t}"` : `"${t}"*`))
    .join(" AND ");
}

export function isEmptyQuery(n: QNode): boolean {
  return n.t === "and" && n.c.length === 0;
}
