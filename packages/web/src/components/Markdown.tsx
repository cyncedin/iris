// A small, safe markdown renderer for research reports (model output = untrusted text).
// Builds React elements only: no innerHTML anywhere, so every character of the source is escaped by React.
// Supports headings, paragraphs, bullet + numbered lists (nested by indent), blockquotes, rules, fenced code,
// simple pipe tables, and inline **bold**, *italic*, `code`, [links](https://…) and bare URLs.
// Links: http(s) and mailto only, opened in a new tab with rel="noopener noreferrer"; anything else renders as text.
import type { ReactNode } from "react";

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "list"; list: List }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "code"; text: string }
  | { t: "table"; head: string[]; rows: string[][] };

interface Item {
  text: string;
  children: List[];
}
interface List {
  ordered: boolean;
  start: number;
  indent: number;
  items: Item[];
}

const LIST_RE = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (s: string) => s.replace(/\t/g, "    ").length;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let stack: List[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", text: para.join(" ") });
    para = [];
  };
  const endList = () => {
    stack = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      // a blank line inside a list keeps it open only if the next line continues it
      if (stack.length && !LIST_RE.test(lines[i + 1] ?? "") && !/^\s{2,}\S/.test(lines[i + 1] ?? "")) endList();
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      endList();
      const body: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = line.match(HEADING_RE);
    if (h) {
      flushPara();
      endList();
      blocks.push({ t: "h", level: h[1].length, text: h[2] });
      continue;
    }
    if (HR_RE.test(line) && !para.length) {
      endList();
      blocks.push({ t: "hr" });
      continue;
    }
    const li = line.match(LIST_RE);
    if (li) {
      flushPara();
      const indent = indentOf(li[1]);
      const ordered = !!li[3];
      const item: Item = { text: li[4], children: [] };
      while (stack.length && stack[stack.length - 1].indent > indent + 1) stack.pop();
      const top = stack[stack.length - 1];
      if (!top || (stack.length === 1 && indent <= top.indent + 1 && top.ordered !== ordered)) {
        const list: List = { ordered, start: ordered ? Number(li[3]) : 1, indent, items: [item] };
        stack = [list];
        blocks.push({ t: "list", list });
      } else if (indent >= top.indent + 2 && top.items.length) {
        const list: List = { ordered, start: ordered ? Number(li[3]) : 1, indent, items: [item] };
        top.items[top.items.length - 1].children.push(list);
        stack.push(list);
      } else top.items.push(item);
      continue;
    }
    if (stack.length && /^\s{2,}\S/.test(line)) {
      // continuation of the last list item
      const top = stack[stack.length - 1];
      const last = top.items[top.items.length - 1];
      last.text += " " + line.trim();
      continue;
    }
    endList();
    if (/^\s*>/.test(line)) {
      flushPara();
      const body = [line.replace(/^\s*>\s?/, "")];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", text: body.join(" ") });
      continue;
    }
    if (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      flushPara();
      const head = cells(line);
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

/** http(s) and mailto only; returns null for javascript:, data:, relative paths … */
export function safeUrl(raw: string): string | null {
  const url = raw.trim().replace(/^<|>$/g, "");
  if (/^mailto:[^\s]+$/i.test(url)) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

// one alternation, earliest match wins: code | [text](url) | **bold** | __bold__ | *italic* | _italic_ | bare URL
const INLINE_RE =
  /`([^`\n]+)`|\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)([^*\n]+?)\*|(?<![\p{L}\p{N}_])_(?!\s)([^_\n]+?)_(?![\p{L}\p{N}_])|(https?:\/\/[^\s<>"]+[^\s<>"'.,;:!?)\]])/gu;

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="md-link" href={href} target="_blank" rel="noopener noreferrer" title={href}>
      {children}
    </a>
  );
}

export function renderInline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE_RE.source, "gu"); // fresh lastIndex per call, so recursion is safe
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    const [, code, linkText, linkUrl, b1, b2, i1, i2, bare] = m;
    if (code !== undefined) out.push(<code key={k}>{code}</code>);
    else if (linkText !== undefined) {
      const href = safeUrl(linkUrl ?? "");
      const inner = renderInline(linkText, k);
      out.push(href ? <Link key={k} href={href}>{inner}</Link> : <span key={k}>{inner}</span>);
    } else if (b1 !== undefined || b2 !== undefined) out.push(<strong key={k}>{renderInline(b1 ?? b2!, k)}</strong>);
    else if (i1 !== undefined || i2 !== undefined) out.push(<em key={k}>{renderInline(i1 ?? i2!, k)}</em>);
    else if (bare !== undefined) {
      const href = safeUrl(bare);
      out.push(href ? <Link key={k} href={href}>{shortUrl(bare)}</Link> : bare);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function shortUrl(url: string): string {
  const s = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}

function ListView({ list, k }: { list: List; k: string }) {
  const items = list.items.map((it, i) => (
    <li key={i}>
      {renderInline(it.text, `${k}.${i}`)}
      {it.children.map((c, j) => (
        <ListView key={j} list={c} k={`${k}.${i}.${j}`} />
      ))}
    </li>
  ));
  return list.ordered ? <ol start={list.start !== 1 ? list.start : undefined}>{items}</ol> : <ul>{items}</ul>;
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={`md ${className}`}>
      {blocks.map((b, i) => {
        const k = String(i);
        switch (b.t) {
          case "h": {
            const inner = renderInline(b.text, k);
            return b.level <= 2 ? <h3 key={k}>{inner}</h3> : b.level === 3 ? <h4 key={k}>{inner}</h4> : <h5 key={k}>{inner}</h5>;
          }
          case "p":
            return <p key={k}>{renderInline(b.text, k)}</p>;
          case "list":
            return <ListView key={k} list={b.list} k={k} />;
          case "quote":
            return <blockquote key={k}>{renderInline(b.text, k)}</blockquote>;
          case "hr":
            return <hr key={k} />;
          case "code":
            return <pre key={k}>{b.text}</pre>;
          case "table":
            return (
              <div key={k} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>{renderInline(c, `${k}.h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, j) => (
                          <td key={j}>{renderInline(c, `${k}.${ri}.${j}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
