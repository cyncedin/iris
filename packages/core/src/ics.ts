// Minimal iCalendar (RFC 5545) reader for meeting invites: METHOD + the first VEVENT.
// Handles line folding, escaped text, UTC / TZID / floating / all-day dates and DURATION.

export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  organizer: { email: string; name: string };
  attendees: { email: string; name: string; partstat: string; optional: boolean }[];
  rrule?: string;
  /** set on a single changed instance of a series */
  recurrenceId?: number;
  /** X-GOOGLE-CONFERENCE / X-MICROSOFT-ONLINEMEETINGURL */
  conferenceUrl?: string;
  status: string;
  sequence: number;
}

export interface IcsCalendar {
  method: string;
  events: IcsEvent[];
}

/** iCalendar PARTSTAT → Google responseStatus */
export function partstatToResponse(p: string): "needsAction" | "declined" | "tentative" | "accepted" {
  const v = p.toUpperCase();
  if (v === "ACCEPTED") return "accepted";
  if (v === "DECLINED") return "declined";
  if (v === "TENTATIVE") return "tentative";
  return "needsAction";
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  // name;param=value;param="quoted:value":value
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let cur = "";
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ";" && !inQuote) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: parts[0].toUpperCase(), params, value };
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Offset (ms) of `tz` at the given instant: local wall clock minus UTC. Throws on unknown zones. */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in an IANA zone → epoch ms (falls back to the local zone for unknown TZIDs). */
export function zonedTimeToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const off = tzOffsetMs(guess, tz);
    let t = guess - off;
    const off2 = tzOffsetMs(t, tz);
    if (off2 !== off) t = guess - off2;
    return t;
  } catch {
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
}

function parseDate(p: Prop): { ms: number; allDay: boolean } | null {
  const v = p.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined || p.params.VALUE === "DATE") return { ms: new Date(y, mo - 1, d).getTime(), allDay: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  if (p.params.TZID) return { ms: zonedTimeToEpoch(y, mo, d, h, mi, s, p.params.TZID.replace(/^\//, "")), allDay: false };
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false }; // floating time
}

function parseDuration(v: string): number {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function person(p: Prop): { email: string; name: string } {
  return { email: p.value.replace(/^mailto:/i, "").trim().toLowerCase(), name: (p.params.CN ?? "").trim() };
}

export function parseIcs(text: string): IcsCalendar {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out: IcsCalendar = { method: "", events: [] };
  let cur: Partial<IcsEvent> & { _dur?: number; _startAllDay?: boolean } | null = null;
  let depth = 0; // nested components inside VEVENT (VALARM) are skipped
  for (const raw of lines) {
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === "BEGIN") {
      if (p.value.toUpperCase() === "VEVENT" && !cur) cur = { attendees: [], description: "", location: "", summary: "", status: "", sequence: 0 };
      else if (cur) depth++;
      continue;
    }
    if (p.name === "END") {
      if (cur && depth > 0) depth--;
      else if (cur && p.value.toUpperCase() === "VEVENT") {
        if (cur.start !== undefined) {
          const allDay = !!cur._startAllDay;
          let end = cur.end;
          if (end === undefined) end = cur.start + (cur._dur || (allDay ? 86_400_000 : 0));
          out.events.push({
            uid: cur.uid ?? "",
            summary: cur.summary ?? "",
            description: cur.description ?? "",
            location: cur.location ?? "",
            start: cur.start,
            end,
            allDay,
            organizer: cur.organizer ?? { email: "", name: "" },
            attendees: cur.attendees ?? [],
            rrule: cur.rrule,
            ...(cur.recurrenceId !== undefined ? { recurrenceId: cur.recurrenceId } : {}),
            ...(cur.conferenceUrl ? { conferenceUrl: cur.conferenceUrl } : {}),
            status: cur.status ?? "",
            sequence: cur.sequence ?? 0,
          });
        }
        cur = null;
      }
      continue;
    }
    if (!cur) {
      if (p.name === "METHOD") out.method = p.value.trim().toUpperCase();
      continue;
    }
    if (depth > 0) continue;
    switch (p.name) {
      case "UID":
        cur.uid = p.value.trim();
        break;
      case "SUMMARY":
        cur.summary = unescapeText(p.value);
        break;
      case "DESCRIPTION":
        cur.description = unescapeText(p.value);
        break;
      case "LOCATION":
        cur.location = unescapeText(p.value);
        break;
      case "STATUS":
        cur.status = p.value.trim().toUpperCase();
        break;
      case "SEQUENCE":
        cur.sequence = Number(p.value) || 0;
        break;
      case "RRULE":
        cur.rrule = p.value.trim();
        break;
      case "RECURRENCE-ID": {
        const d = parseDate(p);
        if (d) cur.recurrenceId = d.ms;
        break;
      }
      case "X-GOOGLE-CONFERENCE":
      case "X-MICROSOFT-ONLINEMEETINGURL":
      case "X-MICROSOFT-SKYPETEAMSMEETINGURL":
        if (/^https:\/\//i.test(p.value.trim())) cur.conferenceUrl ??= p.value.trim();
        break;
      case "DTSTART": {
        const d = parseDate(p);
        if (d) {
          cur.start = d.ms;
          cur._startAllDay = d.allDay;
        }
        break;
      }
      case "DTEND": {
        const d = parseDate(p);
        if (d) cur.end = d.ms;
        break;
      }
      case "DURATION":
        cur._dur = parseDuration(p.value);
        break;
      case "ORGANIZER":
        cur.organizer = person(p);
        break;
      case "ATTENDEE":
        cur.attendees!.push({ ...person(p), partstat: (p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase(), optional: (p.params.ROLE ?? "").toUpperCase() === "OPT-PARTICIPANT" });
        break;
    }
  }
  return out;
}
