// One-off test: does an emailed calendar invite show up in Apple Calendar
// with Accept and Decline?
// Sends ONE email from info@averywhitted.com to your Apple ID address with a
// 30-minute test event three days from now at 11:00am Eastern.
// Reads the Resend key from Keychain. Changes nothing in your calendar;
// the event is only added if you accept it.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const TO = "averywhitted@me.com";
const FROM = "Avery Whitted Coaching <info@averywhitted.com>";

const key = execFileSync(
  "security",
  ["find-generic-password", "-s", "resend-booking-key", "-w"],
  { encoding: "utf8" },
).trim();

// Three days from now, 11:00 to 11:30 Eastern. Built in UTC so no time zone
// block is needed in the invite. (Eastern is UTC-4 until early November.)
const day = new Date(Date.now() + 3 * 86400000);
const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 15, 0));
const end = new Date(start.getTime() + 30 * 60000);
const ics = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const invite = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//averywhitted.com//Booking//EN",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  `UID:${randomUUID()}@averywhitted.com`,
  "SEQUENCE:0",
  `DTSTAMP:${ics(new Date())}`,
  `DTSTART:${ics(start)}`,
  `DTEND:${ics(end)}`,
  "SUMMARY:TEST: Booking system invite",
  "DESCRIPTION:This is a test invite from the new booking system. Safe to accept or decline.",
  "ORGANIZER;CN=Avery Whitted Coaching:mailto:info@averywhitted.com",
  `ATTENDEE;CN=Avery Whitted;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${TO}`,
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const when = start.toLocaleString("en-US", {
  timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
});

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    from: FROM,
    to: [TO],
    subject: `TEST invite: ${when}`,
    text: `This is a test invite from the new booking system for ${when} Eastern (30 minutes). Safe to accept or decline.`,
    attachments: [{
      filename: "invite.ics",
      content: Buffer.from(invite).toString("base64"),
      content_type: "text/calendar; method=REQUEST; charset=UTF-8",
    }],
  }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log(`Resend refused the email (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`Sent. Test invite for ${when} Eastern is on its way to ${TO}.`);
