// Gmail API payload parsing + outgoing MIME building.
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Address, AttachmentMeta, DraftInput, Message } from "./types.ts";

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
  sizeEstimate?: number;
}

// ---------- addresses ----------

/** Parse an RFC 5322 address list ("A <a@x>, \"B, C\" <b@x>, c@x"). Tolerant. */
export function parseAddressList(input: string | undefined | null): Address[] {
  if (!input) return [];
  const out: Address[] = [];
  let cur = "";
  let inQuote = false;
  let depth = 0;
  for (const ch of input) {
    if (ch === '"' ) inQuote = !inQuote;
    else if (!inQuote && ch === "<") depth++;
    else if (!inQuote && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !inQuote && depth === 0) {
      pushAddr(cur, out);
      cur = "";
    } else cur += ch;
  }
  pushAddr(cur, out);
  return out;
}

function pushAddr(raw: string, out: Address[]): void {
  const s = raw.trim();
  if (!s) return;
  const m = s.match(/^(.*?)<\s*([^>]+?)\s*>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    out.push({ name, email: m[2].trim().toLowerCase() });
  } else if (s.includes("@")) {
    const email = s.replace(/^mailto:/i, "").replace(/[<>"]/g, "").trim().toLowerCase();
    out.push({ name: "", email });
  }
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const needsQuote = /[",;:<>@()[\]\\]/.test(a.name);
  return `${needsQuote ? `"${a.name.replace(/"/g, '\\"')}"` : a.name} <${a.email}>`;
}

export function toAddresses(v: string | Address[] | undefined): Address[] {
  if (!v) return [];
  return Array.isArray(v) ? v : parseAddressList(v);
}

export function displayName(a: Address | null | undefined): string {
  if (!a) return "";
  if (a.name) return a.name;
  return a.email.split("@")[0];
}

// ---------- decoding ----------

export function b64urlDecode(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

function charsetOf(part: GmailPart): string {
  const ct = header(part.headers, "Content-Type");
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return (m?.[1] || "utf-8").toLowerCase();
}

function decodeText(part: GmailPart): string {
  if (!part.body?.data) return "";
  const buf = b64urlDecode(part.body.data);
  try {
    return new TextDecoder(charsetOf(part), { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

interface Collected {
  html: string[];
  text: string[];
  attachments: AttachmentMeta[];
  /** decoded text/calendar parts (meeting invites) */
  calendar: string[];
}

function isCalendarPart(mime: string, filename: string | undefined): boolean {
  return mime === "text/calendar" || mime === "application/ics" || /\.ics$/i.test(filename ?? "");
}

function walk(part: GmailPart, acc: Collected): void {
  const mime = (part.mimeType || "").toLowerCase();
  const disposition = header(part.headers, "Content-Disposition").toLowerCase();
  const contentId = header(part.headers, "Content-ID").replace(/[<>]/g, "");
  const isAttachment = !!part.filename || disposition.startsWith("attachment");
  if (part.parts && part.parts.length) {
    if (mime === "multipart/alternative") {
      // prefer the richest alternative, but still collect nested attachments
      const html = part.parts.find((p) => containsMime(p, "text/html"));
      const chosen = html ?? part.parts[part.parts.length - 1];
      for (const p of part.parts) {
        if (p === chosen) walk(p, acc);
        else if (mimeOf(p) === "text/plain" && !html) walk(p, acc);
        else if (mimeOf(p) === "text/plain") acc.text.push(decodeText(p));
        else collectAttachmentsOnly(p, acc);
      }
      return;
    }
    for (const p of part.parts) walk(p, acc);
    return;
  }
  if (isCalendarPart(mime, part.filename) && part.body?.data) acc.calendar.push(decodeText(part));
  if (!isAttachment && mime === "text/calendar") {
    // invite part inside multipart/alternative: keep it out of the body; large ones are fetched later by attachment id
    if (!part.body?.data && part.body?.attachmentId)
      acc.attachments.push({ id: part.body.attachmentId, filename: "invite.ics", mimeType: mime, size: part.body.size ?? 0, inline: true });
    return;
  }
  if (isAttachment && (part.body?.attachmentId || part.body?.data)) {
    acc.attachments.push({
      id: part.body?.attachmentId || `inline-data:${part.partId ?? ""}`,
      filename: part.filename || "attachment",
      mimeType: mime || "application/octet-stream",
      size: part.body?.size ?? 0,
      inline: disposition.startsWith("inline") || (!!contentId && mime.startsWith("image/")),
      contentId: contentId || undefined,
    });
    return;
  }
  if (mime === "text/html") acc.html.push(decodeText(part));
  else if (mime === "text/plain" || !mime) acc.text.push(decodeText(part));
  else if (contentId && part.body?.attachmentId) {
    acc.attachments.push({
      id: part.body.attachmentId,
      filename: part.filename || contentId,
      mimeType: mime,
      size: part.body.size ?? 0,
      inline: true,
      contentId,
    });
  }
}

function mimeOf(p: GmailPart): string {
  return (p.mimeType || "").toLowerCase();
}

function containsMime(p: GmailPart, mime: string): boolean {
  if (mimeOf(p) === mime) return true;
  return !!p.parts?.some((c) => containsMime(c, mime));
}

function collectAttachmentsOnly(p: GmailPart, acc: Collected): void {
  const tmp: Collected = { html: [], text: [], attachments: [], calendar: [] };
  walk(p, tmp);
  acc.attachments.push(...tmp.attachments);
  acc.calendar.push(...tmp.calendar);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  const linked = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<div style="white-space:pre-wrap">${linked}</div>`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
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

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function parseGmailMessage(raw: GmailMessage, accountId: string, format: "full" | "metadata" = "full"): Message {
  const payload = raw.payload ?? {};
  const h = payload.headers;
  const acc: Collected = { html: [], text: [], attachments: [], calendar: [] };
  walk(payload, acc);
  const bodyText = acc.text.join("\n").trim();
  const bodyHtml = acc.html.length ? acc.html.join("\n") : bodyText ? textToHtml(bodyText) : "";
  const labelIds = raw.labelIds ?? [];
  const fromList = parseAddressList(header(h, "From"));
  const dateHeader = Date.parse(header(h, "Date"));
  return {
    id: raw.id,
    threadId: raw.threadId,
    accountId,
    date: raw.internalDate ? Number(raw.internalDate) : Number.isFinite(dateHeader) ? dateHeader : Date.now(),
    from: fromList[0] ?? { name: "", email: "" },
    to: parseAddressList(header(h, "To")),
    cc: parseAddressList(header(h, "Cc")),
    bcc: parseAddressList(header(h, "Bcc")),
    replyTo: parseAddressList(header(h, "Reply-To")),
    subject: header(h, "Subject"),
    snippet: decodeEntities(raw.snippet ?? ""),
    labelIds,
    messageIdHeader: header(h, "Message-ID") || header(h, "Message-Id"),
    references: header(h, "References"),
    inReplyTo: header(h, "In-Reply-To"),
    listId: header(h, "List-Id"),
    listUnsubscribe: header(h, "List-Unsubscribe"),
    listUnsubscribePost: header(h, "List-Unsubscribe-Post"),
    bodyHtml,
    bodyText: bodyText || htmlToText(bodyHtml),
    attachments: acc.attachments,
    isDraft: labelIds.includes("DRAFT"),
    isSent: labelIds.includes("SENT"),
    bodyLoaded: format === "full",
    attachmentHint: format === "metadata" && /^multipart\/(mixed|related)/i.test(header(h, "Content-Type") || payload.mimeType || ""),
    ...(acc.calendar.length ? { ics: acc.calendar.find((c) => /BEGIN:VEVENT/i.test(c)) ?? acc.calendar[0] } : {}),
  };
}

// ---------- outgoing ----------

export interface ReplyContext {
  messageIdHeader: string;
  references: string;
}

export async function buildMime(
  draft: DraftInput,
  from: Address,
  reply?: ReplyContext | null,
): Promise<Buffer> {
  const html = draft.html ?? (draft.text ? textToHtml(draft.text) : "");
  const text = draft.text ?? htmlToText(html);
  const headers: Record<string, string> = {};
  if (reply?.messageIdHeader) {
    headers["In-Reply-To"] = reply.messageIdHeader;
    headers["References"] = [reply.references, reply.messageIdHeader].filter(Boolean).join(" ").trim();
  }
  const composer = new MailComposer({
    from: formatAddress(from),
    to: toAddresses(draft.to).map(formatAddress).join(", ") || undefined,
    cc: toAddresses(draft.cc).map(formatAddress).join(", ") || undefined,
    bcc: toAddresses(draft.bcc).map(formatAddress).join(", ") || undefined,
    subject: draft.subject,
    text,
    html,
    headers,
    attachments: (draft.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: Buffer.from(a.contentBase64, "base64"),
    })),
  });
  const node = composer.compile();
  // Gmail reads recipients from the headers, so Bcc must stay in the raw message (Gmail strips it on delivery).
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  return await new Promise<Buffer>((resolve, reject) => {
    node.build((err: Error | null, msg: Buffer) => (err ? reject(err) : resolve(msg)));
  });
}

export function replySubject(subject: string, kind: "reply" | "forward"): string {
  const s = subject.trim();
  if (kind === "reply") return /^re:/i.test(s) ? s : `Re: ${s}`;
  return /^(fwd?|wg):/i.test(s) ? s : `Fwd: ${s}`;
}

const ATTACHMENT_HINTS = [
  /see (?:the )?(?:attached|attachments?|included)/i,
  /(?:is|are) attached/i,
  /attached,? (?:\w+ ){0,4}(?:is|are|find)/i,
  /\battached (?:file|document|pdf|image|deck|slides)/i,
  /\b(?:im anhang|anbei|angehängt|siehe anhang)\b/i,
];

/** Forgotten attachment check (English and German). */
export function mentionsAttachment(text: string): boolean {
  const own = text.split(/\n(?:On .+wrote:|Am .+schrieb.+:|>)/)[0];
  return ATTACHMENT_HINTS.some((r) => r.test(own));
}
