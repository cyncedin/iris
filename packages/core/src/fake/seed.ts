// Deterministic demo mailbox (fictional people and companies).
import { textToHtml } from "../mime.ts";
import { demoInviteIcs } from "./calendar.ts";
import type { Message } from "../types.ts";

interface SeedMsg {
  from: [string, string];
  to?: [string, string][];
  cc?: [string, string][];
  ago: number; // minutes ago
  body: string;
  html?: string;
  sent?: boolean;
  unread?: boolean;
}

interface SeedThread {
  subject: string;
  labels: string[];
  msgs: SeedMsg[];
  list?: { id: string; unsub: string; post?: boolean };
  attachment?: { filename: string; mimeType: string; size: number };
  /** carries a text/calendar invite (the demo "Weekly sync" series) */
  invite?: boolean;
}

const H = 60;
const D = 24 * 60;

const THREADS: SeedThread[] = [
  {
    subject: "Investor intro: Lena Hoffmann (Northwind Ventures)",
    labels: ["INBOX", "IMPORTANT", "CATEGORY_PERSONAL"],
    msgs: [
      {
        from: ["Marcus Klein", "marcus@kleinadvisory.de"],
        cc: [["Lena Hoffmann", "lena@northwind.vc"]],
        ago: 35,
        unread: true,
        body: "Hi both,\n\nAs promised, connecting you two. Lena leads B2B software at Northwind and has been looking at workflow automation. Alex is building exactly that.\n\nI'll let you take it from here.\n\nBest,\nMarcus",
      },
    ],
  },
  {
    subject: "Re: Pilot timeline for the operations team",
    labels: ["INBOX", "IMPORTANT"],
    msgs: [
      { from: ["ME", "ME"], to: [["Anna Weber", "a.weber@acme.example"]], ago: 2 * D, sent: true, body: "Hi Anna,\n\nCould we start the pilot on November 18th? We'd need two hours with your team for onboarding.\n\nThanks!" },
      { from: ["Anna Weber", "a.weber@acme.example"], ago: 3 * H, unread: true, body: "Hello,\n\nNovember 18th works for us. Could you send over the data protection documentation beforehand? Our DPO needs to sign off by the 10th.\n\nAlso: will the tool run fully on-premise?\n\nKind regards,\nAnna Weber" },
    ],
  },
  {
    subject: "Your flight to Barcelona is confirmed",
    labels: ["INBOX", "CATEGORY_UPDATES"],
    msgs: [{ from: ["SkyEuro Airlines", "noreply@skyasia.example"], ago: 5 * H, body: "Booking reference: QX7P2L\n\nLIS → BCN, Thu 6 Nov, 10:40–14:05\nSeat 14A, 20kg baggage included.\n\nOnline check-in opens 48 hours before departure." }],
    attachment: { filename: "e-ticket-QX7P2L.pdf", mimeType: "application/pdf", size: 184_321 },
  },
  {
    subject: "The Batch: new reasoning models, robotics funding, and more",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    list: { id: "<thebatch.list.deeplearning.example>", unsub: "<https://news.example/unsub?u=123>, <mailto:unsub@news.example>", post: true },
    msgs: [{ from: ["The Batch", "thebatch@news.example"], ago: 7 * H, unread: true, body: "Dear friends,\n\nThis week: reasoning models get cheaper, a robotics startup raises $400M, and a deep dive into evaluation methods.\n\nRead online →" }],
  },
  {
    subject: "Meeting: Application review",
    labels: ["INBOX", "IMPORTANT"],
    msgs: [{ from: ["Sophie Brandt", "sophie.brandt@mentor.example"], ago: 9 * H, unread: true, body: "Hey Alex,\n\nHappy to review your grad school motivation letter. Does Saturday 10:00 CET work? I'll send a calendar invite.\n\nSophie" }],
  },
  {
    subject: "[GitHub] A new SSH key was added to your account",
    labels: ["INBOX", "CATEGORY_UPDATES"],
    msgs: [{ from: ["GitHub", "noreply@github.example"], ago: 11 * H, body: "Hey alexmorgan!\n\nA new public key was added to your account. If you did not add this key, remove it immediately." }],
  },
  {
    subject: "Re: Pricing for the workflow API",
    labels: ["INBOX", "IMPORTANT"],
    msgs: [
      { from: ["Jonas Richter", "jonas@medtech-partners.example"], ago: 3 * D, body: "Hi Alex,\n\nWhat would pricing look like for 50 seats?\n\nJonas" },
      { from: ["ME", "ME"], to: [["Jonas Richter", "jonas@medtech-partners.example"]], ago: 2 * D + 5 * H, sent: true, body: "Hi Jonas,\n\nWe're still finalizing pricing. Let me get back to you by Friday.\n\nBest, Alex" },
      { from: ["Jonas Richter", "jonas@medtech-partners.example"], ago: 20 * H, unread: true, body: "Friday works. In the meantime, can you share a short one-pager? Our board meets on Monday." },
    ],
  },
  {
    subject: "50% off all annual plans – this weekend only",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    list: { id: "<promo.fitapp.example>", unsub: "<https://fitapp.example/unsubscribe/abc>", post: true },
    msgs: [{ from: ["FitApp", "hello@fitapp.example"], ago: 1 * D, body: "Your goals, half the price. Upgrade now and get 50% off annual Premium." }],
  },
  {
    subject: "Invitation: Weekly sync @ Mon 20 Oct 2026 9:00 – 9:30 (CET)",
    labels: ["INBOX", "IMPORTANT"],
    msgs: [{ from: ["Thomas Becker", "thomas@becker.example"], ago: 1 * D + 2 * H, body: "You have been invited to the following event.\n\nWeekly sync\nMon 20 Oct 2026 9:00 – 9:30 (CET)\nGoogle Meet: meet.example/abc-defg-hij" }],
    attachment: { filename: "invite.ics", mimeType: "text/calendar", size: 2_210 },
    invite: true,
  },
  {
    subject: "Your receipt from Anthropic",
    labels: ["INBOX", "CATEGORY_UPDATES"],
    msgs: [{ from: ["Anthropic", "invoice@billing.example"], ago: 1 * D + 6 * H, body: "Receipt #2026-4411\n\nAPI usage – October\nAmount paid: $42.17\n\nThank you!" }],
    attachment: { filename: "receipt-2026-4411.pdf", mimeType: "application/pdf", size: 41_002 },
  },
  {
    subject: "Quick question about your eval setup",
    labels: ["INBOX"],
    msgs: [{ from: ["Priya Natarajan", "priya@healthai-research.example"], ago: 1 * D + 9 * H, body: "Hi,\n\nI read your post on X about LLM agents. Are you evaluating against a held-out set of real tasks, or synthetic ones? Would love to compare notes.\n\nPriya" }],
  },
  {
    subject: "Weekly digest: 12 new posts in r/MachineLearning",
    labels: ["INBOX", "CATEGORY_SOCIAL"],
    list: { id: "<digest.reddit.example>", unsub: "<https://reddit.example/unsub/xyz>" },
    msgs: [{ from: ["Reddit", "noreply@reddit.example"], ago: 2 * D, body: "Top posts this week: [D] Is RL fine-tuning overrated?, [R] Scaling laws for retrieval…" }],
  },
  {
    subject: "Re: Gym membership freeze",
    labels: ["INBOX"],
    msgs: [{ from: ["Harbor Strength Club", "front@harborstrength.example"], ago: 2 * D + 3 * H, body: "Hi Alex, your membership is frozen from Nov 5 until Dec 5. Safe travels!" }],
  },
  {
    subject: "Draft deck v3 – comments inside",
    labels: ["INBOX", "IMPORTANT"],
    msgs: [{ from: ["Jan Petersen", "jp@petersen.example"], ago: 2 * D + 8 * H, body: "Alex,\n\nLeft comments on slides 4, 7 and 12. The market slide needs a clearer TAM number. See attached.\n\nJP" }],
    attachment: { filename: "Northstar-Deck-v3-comments.pdf", mimeType: "application/pdf", size: 2_402_331 },
  },
  {
    subject: "Your Notion workspace weekly summary",
    labels: ["CATEGORY_UPDATES"],
    msgs: [{ from: ["Notion", "notify@notion.example"], ago: 4 * D, body: "3 pages edited, 12 tasks completed this week." }],
  },
  {
    subject: "Re: Apartment in Barcelona",
    labels: ["IMPORTANT"],
    msgs: [
      { from: ["ME", "ME"], to: [["Marta Vidal", "marta@bcnstay.example"]], ago: 6 * D, sent: true, body: "Hi Marta, is the studio near Gràcia still available from Dec 1?" },
      { from: ["Marta Vidal", "marta@bcnstay.example"], ago: 5 * D, body: "Yes! $450/month incl. utilities. I can hold it until Nov 15." },
    ],
  },
  {
    subject: "Security alert: new sign-in on Mac",
    labels: ["CATEGORY_UPDATES"],
    msgs: [{ from: ["Google", "no-reply@accounts.example"], ago: 7 * D, body: "A new sign-in to your account was detected on a Mac. If this was you, you don't need to do anything." }],
  },
];

export function demoSeed(email: string): Message[] {
  const now = Date.now();
  const out: Message[] = [];
  let n = 1;
  for (const t of THREADS) {
    const threadId = (0x18e0000000000 + n * 104729).toString(16);
    let prevMsgId = "";
    let refs = "";
    t.msgs.forEach((m, i) => {
      const id = i === 0 ? threadId : (0x18e0000000000 + n * 104729 + i).toString(16);
      const me = { name: "Alex Morgan", email };
      const from = m.from[1] === "ME" ? me : { name: m.from[0], email: m.from[1] };
      const labels = new Set<string>();
      if (m.sent) labels.add("SENT");
      else for (const l of t.labels) labels.add(l);
      if (m.unread) labels.add("UNREAD");
      if (t.labels.includes("INBOX") && i === t.msgs.length - 1) labels.add("INBOX");
      const midHeader = `<${id}.${n}@demo.iris>`;
      out.push({
        id,
        threadId,
        accountId: email,
        date: now - m.ago * 60_000,
        from,
        to: m.to ? m.to.map(([name, e]) => ({ name, email: e })) : [me],
        cc: (m.cc ?? []).map(([name, e]) => ({ name, email: e })),
        bcc: [],
        replyTo: [],
        subject: i === 0 ? t.subject : t.subject.startsWith("Re:") ? t.subject : `Re: ${t.subject}`,
        snippet: m.body.replace(/\s+/g, " ").slice(0, 140),
        labelIds: [...labels],
        messageIdHeader: midHeader,
        references: refs,
        inReplyTo: prevMsgId,
        listId: t.list?.id ?? "",
        listUnsubscribe: t.list?.unsub ?? "",
        listUnsubscribePost: t.list?.post ? "List-Unsubscribe=One-Click" : "",
        bodyHtml: m.html ?? textToHtml(m.body),
        bodyText: m.body,
        attachments:
          t.attachment && i === t.msgs.length - 1
            ? [{ id: `att-${id}`, filename: t.attachment.filename, mimeType: t.attachment.mimeType, size: t.attachment.size, inline: false }]
            : [],
        isDraft: false,
        isSent: !!m.sent,
        ...(t.invite && i === t.msgs.length - 1 ? { ics: demoInviteIcs(email, new Date(now)) } : {}),
      });
      refs = `${refs} ${midHeader}`.trim();
      prevMsgId = midHeader;
    });
    n++;
  }
  return out;
}
