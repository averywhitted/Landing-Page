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
const intro: T.BookingView = { ...sample, kind: "intro", serviceName: "Intro chat", durationMinutes: 15, end: start + 15 * 60000, amountCents: 0, material: "", link: "", goal: "Getting back into auditioning after a few years off." };
const bundle: T.BundleView = {
  name: "Jamie Rivera", email: "jamie@example.com", pronouns: "they/them", credits: 4, remaining: 4, sessionLength: "1 hour",
  expiresAt: start + 60 * 86400000, clientTimeZone: "America/Los_Angeles", amountCents: 44000, bundleName: "4 session bundle",
  goal: "Book more guest star roles this pilot season.",
};
const ics = buildIcs({ uid: "sample@averywhitted.com", sequence: 0, start, end: sample.end, summary: "Private coaching with Avery Whitted" });

const out = new URL("../.email-previews/", import.meta.url);
mkdirSync(out, { recursive: true });
const manage = "https://averywhitted.com/book/manage/?b=sample&t=sample";
const book = "https://averywhitted.com/book/?service=coaching-60";
const earlier = start - 2 * 86400000;
const pages: [string, { subject: string; html: string }][] = [
  ["01-client-confirmation", T.clientConfirmation(sample, ics, manage)],
  ["02-client-confirmation-no-zoom", T.clientConfirmation({ ...sample, zoomUrl: null }, ics, manage)],
  ["03-intro-confirmation", T.clientConfirmation(intro, ics, manage)],
  ["04-client-rescheduled", T.clientRescheduled(sample, earlier, ics, manage)],
  ["05-client-cancelled", T.clientCancelled(sample, ics, "https://averywhitted.com/book/", "refunded")],
  ["06-checkout-reminder", T.checkoutReminder(sample, book)],
  ["07-slot-taken-refund", T.slotTakenRefund(sample, book)],
  ["08-admin-new-booking", T.adminNotification(sample, { zoomMissing: false, calendarFailed: false })],
  ["09-admin-new-booking-warnings", T.adminNotification({ ...sample, zoomUrl: null }, { zoomMissing: true, calendarFailed: true })],
  ["10-admin-rescheduled", T.adminRescheduled(sample, earlier, { calendarFailed: false })],
  ["11-admin-cancelled", T.adminCancelled(sample, "https://dashboard.stripe.com/test/payments/pi_sample", { refund: "refunded", calendarRemoved: true, zoomRemoved: true })],
  ["12-session-reminder", T.sessionReminder(sample, start - 20 * 3600000)],
  ["13-bundle-confirmed", T.bundlePurchased(bundle, "https://averywhitted.com/book/package/?p=sample&t=sample")],
  ["14-admin-bundle-purchased", T.adminBundlePurchased(bundle)],
  ["15-bundle-expiring", T.bundleExpiring({ ...bundle, remaining: 2 }, "https://averywhitted.com/book/package/?p=sample&t=sample")],
  ["16-bundle-session-confirmation", T.clientConfirmation({ ...sample, amountCents: 0, bundleNote: "Bundle session (3 of 4 left)" }, ics, manage)],
  ["17-admin-alert", T.attentionAlert(["1 \"client confirmation\" email failed to send.", "Jamie Rivera's session on Thu, Oct 1, 11:00 AM isn't in your Coaching calendar."])],
];
const index: string[] = [];
for (const [name, email] of pages) {
  // Point images at the local copies so previews work before a deploy.
  const local = email.html
    .replace(/https:\/\/book\.averywhitted\.com\/email\/wordmark\.png/g, "/booking/assets/email-wordmark.png")
    .replace(/https:\/\/book\.averywhitted\.com\/email\/h\//g, "/booking/assets/headings/");
  writeFileSync(new URL(`${name}.html`, out), local);
  index.push(`<li><a href="${name}.html">${name}</a>: <em>${email.subject.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</em></li>`);
  if (/—/.test(email.html + email.subject)) throw new Error(`${name} contains an em dash`);
}
writeFileSync(new URL("index.html", out), `<!doctype html><meta charset="utf-8"><title>Email previews</title><body style="font-family:system-ui;padding:24px"><h1>Booking emails</h1><ul>${index.join("")}</ul>`);
console.log(`Wrote ${pages.length} previews to booking/.email-previews/`);
