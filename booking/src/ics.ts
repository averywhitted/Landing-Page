// Builds calendar files (.ics). The same UID is used for the life of a
// booking and SEQUENCE goes up on each change, so calendars update the
// existing event instead of adding a copy.

import { iso } from "./time";

const stamp = (ms: number) => iso(ms).replace(/[-:]/g, "");

// iCalendar text escaping: backslash, semicolon, comma, and newlines.
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Parameter values (like a name in CN=) are quoted, so ":" ";" "," inside a
// name can't break the line. Quotes themselves aren't allowed, so they're dropped.
const param = (s: string) => `"${s.replace(/["\r\n]/g, "")}"`;

// Lines longer than 75 bytes are folded onto continuation lines.
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(current); current = ""; size = 0; }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildIcs(p: {
  uid: string;
  sequence: number;
  start: number;
  end: number;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  method?: "PUBLISH" | "REQUEST" | "CANCEL";
  organizer?: { name: string; email: string };
  attendee?: { name: string; email: string };
  cancelled?: boolean;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//averywhitted.com//Booking//EN",
    "CALSCALE:GREGORIAN",
    ...(p.method ? [`METHOD:${p.method}`] : []),
    "BEGIN:VEVENT",
    `UID:${p.uid}`,
    `SEQUENCE:${p.sequence}`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(p.start)}`,
    `DTEND:${stamp(p.end)}`,
    `SUMMARY:${text(p.summary)}`,
    ...(p.description ? [`DESCRIPTION:${text(p.description)}`] : []),
    ...(p.location ? [`LOCATION:${text(p.location)}`] : []),
    ...(p.url ? [`URL:${p.url}`] : []),
    ...(p.organizer ? [`ORGANIZER;CN=${param(p.organizer.name)}:mailto:${p.organizer.email}`] : []),
    ...(p.attendee ? [`ATTENDEE;CN=${param(p.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${p.attendee.email}`] : []),
    `STATUS:${p.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
