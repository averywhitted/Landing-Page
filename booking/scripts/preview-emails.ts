// Renders every email with sample details so they can be reviewed in a browser.
//   npm run preview-emails   ->  booking/.email-previews/*.html (not committed)

import { mkdirSync, writeFileSync } from "node:fs";
import * as T from "../src/templates";
import { buildIcs } from "../src/ics";

const start = Date.UTC(2026, 9, 1, 15, 0);   // Thu Oct 1, 11:00am Eastern
const sample: T.BookingView = {
  id: "sample",
  kind: "single",
  serviceName: "1 hour session",
  durationMinutes: 60,
  start,
  end: start + 60 * 60000,
  clientTimeZone: "America/Los_Angeles",
  amountCents: 13000,
  name: "Jamie Rivera",
  email: "jamie@example.com",
  pronouns: "they/them",
  goal: "Callback on Friday for a guest star role. I want to make stronger choices in the second scene.",
  material: "Two scenes from the sides (attached in the link).",
  link: "https://example.com/sides.pdf",
  notes: "I tend to rush when I'm nervous.",
  zoomUrl: "https://us06web.zoom.us/j/81234567890?pwd=example",
};
const intro: T.BookingView = { ...sample, kind: "intro", serviceName: "Intro call", durationMinutes: 15, end: start + 15 * 60000, amountCents: 0, material: "", link: "", goal: "Getting back into auditioning after a few years off." };
const ics = buildIcs({ uid: "sample@averywhitted.com", sequence: 0, start, end: sample.end, summary: "Private coaching with Avery Whitted" });

const out = new URL("../.email-previews/", import.meta.url);
mkdirSync(out, { recursive: true });
const pages: [string, { subject: string; html: string }][] = [
  ["1-client-confirmation", T.clientConfirmation(sample, ics)],
  ["2-client-confirmation-no-zoom", T.clientConfirmation({ ...sample, zoomUrl: null }, ics)],
  ["3-intro-confirmation", T.clientConfirmation(intro, ics)],
  ["4-admin-notification", T.adminNotification(sample, { zoomMissing: false, calendarFailed: false })],
  ["5-admin-notification-warnings", T.adminNotification({ ...sample, zoomUrl: null }, { zoomMissing: true, calendarFailed: true })],
  ["6-checkout-reminder", T.checkoutReminder(sample, "https://averywhitted.com/book/?service=coaching-60")],
  ["7-slot-taken-refund", T.slotTakenRefund(sample, "https://averywhitted.com/book/?service=coaching-60")],
];
const index: string[] = [];
for (const [name, email] of pages) {
  writeFileSync(new URL(`${name}.html`, out), email.html);
  index.push(`<li><a href="${name}.html">${name}</a>: <em>${email.subject.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</em></li>`);
  if (/—/.test(email.html + email.subject)) throw new Error(`${name} contains an em dash`);
}
writeFileSync(new URL("index.html", out), `<!doctype html><meta charset="utf-8"><title>Email previews</title><body style="font-family:system-ui;padding:24px"><h1>Booking emails</h1><ul>${index.join("")}</ul>`);
console.log(`Wrote ${pages.length} previews to booking/.email-previews/`);
