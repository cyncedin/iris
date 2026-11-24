// In-memory Gmail stand-in for demo mode and tests. Behaves like the Gmail API at the label level.
import { htmlToText, parseAddressList, textToHtml } from "../mime.ts";
import type { HistoryResult, MailProvider, ProviderDraft, ProviderThread } from "../provider.ts";
import type { Label, Message } from "../types.ts";
import { evaluate, parseQuery, type QueryTarget } from "../query.ts";
import { demoSeed } from "./seed.ts";

const SYSTEM_LABELS = ["INBOX", "SENT", "DRAFT", "STARRED", "IMPORTANT", "UNREAD", "SPAM", "TRASH", "CATEGORY_PERSONAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL"];

export class FakeProvider implements MailProvider {
  readonly kind = "fake" as const;
  readonly email: string;
  private messages = new Map<string, Message>();
  private labels = new Map<string, Label>();
  private drafts = new Map<string, string>(); // draftId -> messageId
  private historyId = 1000;
  private changes: { id: number; threadId: string; messageId: string; deleted?: boolean }[] = [];
  private seq = 1;
  readonly sent: { raw: string; threadId?: string }[] = [];

  constructor(email = "demo@iris.local", seed = true) {
    this.email = email;
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: "system" });
    if (seed) for (const m of demoSeed(email)) this.insert(m);
  }

  private nextId(): string {
    return (0x18f0000000000 + this.seq++ * 7919).toString(16);
  }

  private bump(threadId: string, messageId: string, deleted = false) {
    this.historyId++;
    this.changes.push({ id: this.historyId, threadId, messageId, deleted });
  }

  insert(m: Message): void {
    this.messages.set(m.id, m);
    for (const l of m.labelIds) if (!this.labels.has(l)) this.labels.set(l, { id: l, name: l, type: "user" });
    this.bump(m.threadId, m.id);
  }

  /** Simulate an incoming email (used by tests and `iris demo`). */
  deliver(partial: Partial<Message> & { from: Message["from"]; subject: string; bodyText: string; threadId?: string }): Message {
    const id = this.nextId();
    const m: Message = {
      id,
      threadId: partial.threadId ?? id,
      accountId: this.email,
      date: Date.now(),
      to: [{ name: "", email: this.email }],
      cc: [],
      bcc: [],
      replyTo: [],
      snippet: partial.bodyText.slice(0, 140),
      labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
      messageIdHeader: `<${id}@fake.iris>`,
      references: "",
      inReplyTo: "",
      listId: "",
      listUnsubscribe: "",
      listUnsubscribePost: "",
      bodyHtml: textToHtml(partial.bodyText),
      attachments: [],
      isDraft: false,
      isSent: false,
      ...partial,
    } as Message;
    this.insert(m);
    return m;
  }

  async profile() {
    return { email: this.email, historyId: String(this.historyId) };
  }

  async listLabels() {
    return [...this.labels.values()];
  }

  async createLabel(name: string) {
    const l: Label = { id: `Label_${this.seq++}`, name, type: "user" };
    this.labels.set(l.id, l);
    return l;
  }

  async deleteLabel(id: string) {
    this.labels.delete(id);
    for (const m of this.messages.values()) m.labelIds = m.labelIds.filter((l) => l !== id);
  }

  private threadMessages(threadId: string): Message[] {
    return [...this.messages.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.date - b.date);
  }

  async listThreadIds(opts: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string }) {
    const byThread = new Map<string, number>();
    for (const m of this.messages.values()) {
      if (opts.labelIds?.length && !opts.labelIds.every((l) => m.labelIds.includes(l))) continue;
      if (opts.q && !this.matchQ(m, opts.q)) continue;
      byThread.set(m.threadId, Math.max(byThread.get(m.threadId) ?? 0, m.date));
    }
    const ids = [...byThread.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const start = Number(opts.pageToken ?? 0);
    const max = opts.maxResults ?? 100;
    const page = ids.slice(start, start + max);
    return { ids: page, nextPageToken: start + max < ids.length ? String(start + max) : undefined };
  }

  /** Gmail-like search using the same evaluator as the local index (message granularity, like Gmail). */
  private matchQ(m: Message, q: string): boolean {
    const wantsHidden = /\bin:(spam|trash|anywhere)\b/.test(q);
    if (!wantsHidden && (m.labelIds.includes("SPAM") || m.labelIds.includes("TRASH"))) return false;
    const addr = (a: { name: string; email: string }[]) => a.map((x) => `${x.name} ${x.email}`).join(" ").toLowerCase();
    const files = m.attachments.map((a) => a.filename).join(" ").toLowerCase();
    const target: QueryTarget = {
      subject: m.subject.toLowerCase(),
      from: addr([m.from]),
      to: addr([...m.to, ...m.cc, ...m.bcc]),
      cc: addr(m.cc),
      body: `${m.subject} ${m.bodyText || htmlToText(m.bodyHtml)} ${addr([m.from, ...m.to, ...m.cc])} ${files}`.toLowerCase(),
      labelIds: m.labelIds,
      labelNames: m.labelIds.map((id) => (this.labels.get(id)?.name ?? id).toLowerCase()),
      listId: m.listId ? `${m.listId.toLowerCase()} @@any@@` : "",
      attachments: files,
      lastDate: m.date,
      unread: m.labelIds.includes("UNREAD"),
      starred: m.labelIds.includes("STARRED"),
      important: m.labelIds.includes("IMPORTANT"),
      snoozed: false,
      muted: false,
    };
    return evaluate(parseQuery(q.replace(/list:\*/g, "list:@@any@@")), target);
  }

  async getThread(id: string): Promise<ProviderThread | null> {
    const msgs = this.threadMessages(id);
    if (!msgs.length) return null;
    return { id, historyId: String(this.historyId), messages: msgs.map((m) => structuredClone(m)) };
  }

  async history(startHistoryId: string): Promise<HistoryResult | "expired"> {
    const start = Number(startHistoryId);
    if (start < 1000) return "expired";
    const relevant = this.changes.filter((c) => c.id > start);
    return {
      historyId: String(this.historyId),
      changedThreadIds: [...new Set(relevant.filter((c) => !c.deleted).map((c) => c.threadId))],
      deletedMessageIds: relevant.filter((c) => c.deleted).map((c) => c.messageId),
    };
  }

  private applyLabels(m: Message, add: string[], remove: string[]) {
    const set = new Set(m.labelIds);
    for (const l of add) set.add(l);
    for (const l of remove) set.delete(l);
    m.labelIds = [...set];
    this.bump(m.threadId, m.id);
  }

  async modifyThread(id: string, add: string[], remove: string[]) {
    for (const m of this.threadMessages(id)) this.applyLabels(m, add, remove);
  }

  async modifyMessages(ids: string[], add: string[], remove: string[]) {
    for (const id of ids) {
      const m = this.messages.get(id);
      if (m) this.applyLabels(m, add, remove);
    }
  }

  async trashThread(id: string) {
    await this.modifyThread(id, ["TRASH"], ["INBOX"]);
  }

  async untrashThread(id: string) {
    await this.modifyThread(id, [], ["TRASH"]);
  }

  private fromRaw(raw: Buffer, threadId: string | undefined, labels: string[]): Message {
    const text = raw.toString("utf8");
    const [head, ...rest] = text.split(/\r?\n\r?\n/);
    const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
    const hdr = (n: string) => unfolded.match(new RegExp(`^${n}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
    const htmlMatch = text.match(/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/i);
    const decodeQP = (s: string) =>
      s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const html = htmlMatch ? decodeQP(htmlMatch[1]) : textToHtml(rest.join("\n\n"));
    const subjectRaw = hdr("Subject");
    const subject = subjectRaw.replace(/=\?utf-8\?Q\?(.*?)\?=/gi, (_, s) => decodeQP(s.replace(/_/g, " ")));
    const id = this.nextId();
    const m: Message = {
      id,
      threadId: threadId ?? id,
      accountId: this.email,
      date: Date.now(),
      from: parseAddressList(hdr("From"))[0] ?? { name: "", email: this.email },
      to: parseAddressList(hdr("To")),
      cc: parseAddressList(hdr("Cc")),
      bcc: parseAddressList(hdr("Bcc")),
      replyTo: [],
      subject,
      snippet: htmlToText(html).slice(0, 140),
      labelIds: labels,
      messageIdHeader: hdr("Message-ID") || `<${id}@fake.iris>`,
      references: hdr("References"),
      inReplyTo: hdr("In-Reply-To"),
      listId: "",
      listUnsubscribe: "",
      listUnsubscribePost: "",
      bodyHtml: html,
      bodyText: htmlToText(html),
      attachments: [],
      isDraft: labels.includes("DRAFT"),
      isSent: labels.includes("SENT"),
    };
    return m;
  }

  async send(raw: Buffer, threadId?: string) {
    this.sent.push({ raw: raw.toString("utf8"), threadId });
    const m = this.fromRaw(raw, threadId, ["SENT"]);
    this.insert(m);
    return { id: m.id, threadId: m.threadId };
  }

  async createDraft(raw: Buffer, threadId?: string): Promise<ProviderDraft> {
    const m = this.fromRaw(raw, threadId, ["DRAFT"]);
    this.insert(m);
    const draftId = `r${this.seq++}`;
    this.drafts.set(draftId, m.id);
    return { draftId, messageId: m.id, threadId: m.threadId };
  }

  async updateDraft(draftId: string, raw: Buffer, threadId?: string): Promise<ProviderDraft> {
    const old = this.drafts.get(draftId);
    if (old) {
      const om = this.messages.get(old);
      this.messages.delete(old);
      if (om) this.bump(om.threadId, old, true);
    }
    const m = this.fromRaw(raw, threadId, ["DRAFT"]);
    this.insert(m);
    this.drafts.set(draftId, m.id);
    return { draftId, messageId: m.id, threadId: m.threadId };
  }

  async deleteDraft(draftId: string) {
    const mid = this.drafts.get(draftId);
    if (!mid) return;
    const m = this.messages.get(mid);
    this.messages.delete(mid);
    this.drafts.delete(draftId);
    if (m) this.bump(m.threadId, mid, true);
  }

  async sendDraft(draftId: string) {
    const mid = this.drafts.get(draftId);
    const m = mid ? this.messages.get(mid) : undefined;
    if (!m) throw new Error("draft not found");
    this.drafts.delete(draftId);
    m.labelIds = ["SENT"];
    m.isDraft = false;
    m.isSent = true;
    this.bump(m.threadId, m.id);
    return { id: m.id, threadId: m.threadId };
  }

  async listDrafts() {
    return [...this.drafts.entries()].map(([draftId, messageId]) => ({
      draftId,
      messageId,
      threadId: this.messages.get(messageId)?.threadId ?? "",
    }));
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const m = this.messages.get(messageId);
    const att = m?.attachments.find((a) => a.id === attachmentId);
    if (m?.ics && att && /calendar|ics/i.test(`${att.mimeType} ${att.filename}`)) return Buffer.from(m.ics);
    return Buffer.from(`fake attachment ${attachmentId}`);
  }

  async getRawMessage(messageId: string) {
    const m = this.messages.get(messageId);
    return Buffer.from(m ? `Subject: ${m.subject}\r\nFrom: ${m.from.email}\r\n\r\n${m.bodyText}` : "");
  }

  async createFilter() {
    /* no-op */
  }

  async sendAsSignature() {
    return { name: "Demo User", signature: "" };
  }
}
