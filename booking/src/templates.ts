// Email templates. Plain HTML with inline styles (what email apps support),
// matching averywhitted.com: Horizon wordmark and headings, lime tag, white
// card, blue button. Copy rule: no em dashes.

import type { Email } from "./email";
import { HEADING_IMAGES } from "./email-headings";

export type BookingView = {
  id: string;
  kind: "intro" | "single" | "bundle";
  serviceName: string;       // "1 hour session", "Intro chat"
  durationMinutes: number;
  start: number;
  end: number;
  clientTimeZone: string;
  amountCents: number;
  name: string;
  email: string;
  pronouns?: string;
  goal?: string;
  material?: string;
  link?: string;
  notes?: string;
  zoomUrl?: string | null;
  bundleNote?: string;        // e.g. "Bundle session (2 of 4 left)" when booked with a credit
  promoCode?: string | null;  // promo code used at checkout, if any
  // Sessions Avery booked from the admin page:
  group?: boolean;            // part of a group session
  dueCents?: number;          // still to pay (0 when paid, free, or a bundle credit)
  payBy?: number | null;      // unpaid by then: released automatically
  message?: string | null;    // Avery's note in the invite
  repeatEvery?: number | null; // repeats every n weeks
  repeatNext?: boolean;       // booked automatically as the next in a series
};

const repeatWords = (n: number) => (n === 1 ? "every week" : `every ${n} weeks`);
const repeatTag = (n?: number | null) => (!n ? "" : n === 1 ? " (repeats weekly)" : ` (repeats every ${n} weeks)`);
// "This session repeats every week..." for sessions in a series.
function repeatPara(b: BookingView, manageUrl: string): string {
  if (!b.repeatEvery) return "";
  return small(`This session repeats ${repeatWords(b.repeatEvery)}. The next one is booked automatically after this one ends${(b.dueCents ?? 0) > 0 || b.repeatNext ? ", and you'll get an email with a link to pay" : ""}. You can <a href="${esc(manageUrl)}" style="color:#6b727b;">stop repeating</a> anytime.`);
}

const AVERY_TZ = "America/New_York";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";
const money = (c: number) => (c % 100 ? `$${(c / 100).toFixed(2)}` : `$${c / 100}`);

function day(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(ms);
}
function shortDay(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(ms);
}
function clock(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);
}
function zoneName(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? tz;
}
function range(start: number, end: number, tz: string) {
  return `${clock(start, tz)} to ${clock(end, tz)} ${zoneName(start, tz)}`;
}
const timeRange = (b: BookingView, tz: string) => range(b.start, b.end, tz);

// Students who still owe for a session Avery booked get the Zoom link once they've paid.
const zoomFor = (b: BookingView) => ((b.dueCents ?? 0) > 0 ? null : b.zoomUrl ?? null);
const noZoomText = (b: BookingView) => ((b.dueCents ?? 0) > 0 ? "Sent once you've paid" : "Link to follow");
const noZoomPara = (b: BookingView) => para((b.dueCents ?? 0) > 0
  ? "Your Zoom link will arrive as soon as you've paid."
  : "I'll send your Zoom link before the session.");

// ── Shared pieces ──

const FONT = "Helvetica,Arial,sans-serif";
// Horizon where the email app allows web fonts (Apple Mail, iOS); Arial Black elsewhere.
const DISPLAY = "'Horizon','Arial Black',Helvetica,Arial,sans-serif";
const ASSETS = "https://book.averywhitted.com/email";
const MONO = "Menlo,Consolas,'Courier New',monospace";

// Fixed headings are pre-drawn images in Horizon (see tools/render-headings.html),
// so they look right in every email app. Anything else falls back to text.
function heading(title: string): string {
  const img = HEADING_IMAGES[title];
  const textStyle = `font-family:${DISPLAY};font-weight:900;font-size:26px;line-height:1.05;text-transform:uppercase;color:#0e1116;`;
  if (!img) return `<h1 style="margin:16px 0 18px;${textStyle}">${esc(title)}</h1>`;
  return `<h1 style="margin:18px 0 18px;${textStyle}"><img src="${ASSETS}/h/${img.file}" width="${img.w}" height="${img.h}" alt="${esc(title.toUpperCase())}" style="display:block;border:0;outline:none;max-width:100%;height:auto;${textStyle}"></h1>`;
}

function layout(p: { preheader: string; tag: string; title: string; subtitle?: string; body: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${esc(p.title)}</title>
<style>@font-face{font-family:'Horizon';src:url('https://averywhitted.com/fonts/horizon.otf') format('opentype');font-weight:400 900;font-style:normal;}</style>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(p.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding:0 4px 18px;"><a href="https://averywhitted.com" style="text-decoration:none;"><img src="${ASSETS}/wordmark.png?v=2" width="322" height="37" alt="AVERY WHITTED &middot; Acting Workshops + Private Coaching" style="display:block;border:0;outline:none;width:322px;max-width:100%;height:auto;font:900 20px/1.2 'Arial Black',${FONT};color:#0e1116;"></a></td></tr>
  <tr><td style="background:#ffffff;border:1px solid #e1e3e8;border-radius:18px;padding:32px 30px;">
    <span style="display:inline-block;padding:5px 9px 4px;border-radius:4px;background:#e3f24d;color:#14161a;font:700 11px/1.2 ${FONT};letter-spacing:1.1px;text-transform:uppercase;">${esc(p.tag)}</span>
    ${heading(p.title)}
    ${p.subtitle ? `<p style="margin:-6px 0 18px;font:700 20px/1.3 ${FONT};color:#0e1116;">${esc(p.subtitle)}</p>` : ""}
    ${p.body}
  </td></tr>
  <tr><td style="padding:18px 4px 0;font:12px/1.6 ${FONT};color:#6b727b;">Avery Whitted &middot; Acting Workshops + Private Coaching &middot; <a href="https://averywhitted.com" style="color:#6b727b;">averywhitted.com</a></td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const para = (html: string) => `<p style="margin:0 0 16px;font:15px/1.65 ${FONT};color:#2c3138;">${html}</p>`;
const small = (html: string) => `<p style="margin:0 0 12px;font:13px/1.6 ${FONT};color:#6b727b;">${html}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:22px 0 22px;"><a href="${esc(href)}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#1f47f5;color:#ffffff;font:700 13px/1 ${FONT};letter-spacing:0.8px;text-transform:uppercase;text-decoration:none;">${esc(label)}</a></p>`;
// The Zoom button plus the address itself, for anyone who'd rather copy it.
const zoomButton = (url: string) => button(url, "Join on Zoom")
  + `<p style="margin:-12px 0 20px;font:12px/1.5 ${FONT};color:#6b727b;">Or paste this link: <a href="${esc(url)}" style="color:#6b727b;word-break:break-all;">${esc(url)}</a></p>`;
const ghostButton = (href: string, label: string) =>
  `<p style="margin:4px 0 20px;"><a href="${esc(href)}" style="display:inline-block;padding:12px 18px;border-radius:12px;border:1.5px solid #0e1116;color:#0e1116;font:700 12px/1 ${FONT};letter-spacing:0.8px;text-transform:uppercase;text-decoration:none;">${esc(label)}</a></p>`;
export type Fix = [label: string, url: string];
export const ADMIN_URL = "https://book.averywhitted.com/admin";
export const FIX_ADMIN: Fix = ["Resolve in Admin", `${ADMIN_URL}#attention`];
export const FIX_ZOOM: Fix = ["Resolve in Zoom", "https://zoom.us/meeting"];
export const FIX_CALENDAR: Fix = ["Resolve in iCloud Calendar", "https://www.icloud.com/calendar/"];
const warn = (text: string, fix?: Fix | null) =>
  `<p style="margin:0 0 14px;padding:12px 14px;border-radius:12px;background:#fff4e5;font:600 14px/1.5 ${FONT};color:#7a4b00;">${esc(text)}${fix
    ? `<br><a href="${esc(fix[1])}" style="display:inline-block;margin-top:6px;color:#7a4b00;font-weight:700;">${esc(fix[0])} &rarr;</a>` : ""}</p>`;
const fixText = (fix?: Fix | null) => (fix ? ` ${fix[0]}: ${fix[1]}` : "");

// A personal note from Avery, labelled so it stands apart from the standard text.
const noteBlock = (m?: string | null) => m
  ? `<p style="margin:0 0 4px;font:700 13px/1.5 ${FONT};color:#0e1116;">Note:</p><p style="margin:0 0 16px;padding:12px 14px;border-left:3px solid #1f47f5;font:15px/1.65 ${FONT};color:#2c3138;white-space:pre-wrap;">${esc(m)}</p>` : "";
// Anything that cancels or ends something.
const questionsLine = "If you have any questions, or think this was a mistake, please reply to this email.";

function details(rows: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-radius:14px;background:#eceef2;">
${rows.map(([k, v], i) => `<tr><td style="padding:${i ? 6 : 16}px 16px ${i === rows.length - 1 ? 16 : 6}px;width:34%;vertical-align:top;font:700 11px/1.5 ${FONT};letter-spacing:1px;text-transform:uppercase;color:#6b727b;">${esc(k)}</td><td style="padding:${i ? 6 : 16}px 16px ${i === rows.length - 1 ? 16 : 6}px 0;vertical-align:top;font:14px/1.5 ${MONO};color:#0e1116;">${v}</td></tr>`).join("\n")}
</table>`;
}

const textRows = (rows: [string, string][]) => rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, "")}`).join("\n");
const tagFor = (b: BookingView) => (b.kind === "intro" ? "Intro chat" : "Private coaching");
const icsAttachment = (ics: string, method: "REQUEST" | "CANCEL") =>
  [{ filename: method === "CANCEL" ? "cancelled.ics" : "session.ics", content: ics, contentType: `text/calendar; method=${method}; charset=UTF-8` }];

function sessionRows(b: BookingView, tz: string, withPaid: boolean): [string, string][] {
  const rows: [string, string][] = [
    ["Session", esc(b.serviceName)],
    ["Date", esc(day(b.start, tz) + repeatTag(b.repeatEvery))],
    ["Time", esc(timeRange(b, tz))],
    ["Where", zoomFor(b) ? `<a href="${esc(zoomFor(b)!)}" style="color:#1f47f5;">Join on Zoom</a>` : `Zoom (${noZoomText(b).toLowerCase()})`],
  ];
  if (withPaid && b.bundleNote) rows.push(["Paid", esc(b.bundleNote)]);
  else if (withPaid && b.amountCents > 0) rows.push(["Paid", esc(money(b.amountCents) + (b.promoCode ? ` (code ${b.promoCode})` : ""))]);
  return rows;
}

// Rescheduling and cancelling: a quiet line at the bottom, not a button, so
// it's there if they need it without suggesting they use it.
function manageLine(manageUrl: string, opts: { group?: boolean; refundNote?: boolean } = {}): string {
  const link = (label: string) => `<a href="${esc(manageUrl)}" style="color:#6b727b;">${label}</a>`;
  return `<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #eceef2;font:12px/1.6 ${FONT};color:#6b727b;">${opts.group
    ? `Can't make it? You can ${link("cancel your spot")} up to 24 hours before the session.`
    : `Need to change plans? You can ${link("reschedule or cancel")} up to 24 hours before your session.${opts.refundNote ? " Refunds for cancellations may take a few business days to appear." : ""}`}</p>`;
}

// ── Client: booking confirmed ──

export function clientConfirmation(b: BookingView, ics: string, manageUrl: string): Email {
  const tz = b.clientTimeZone;
  const intro = b.kind === "intro";
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(intro
      ? "Thanks for booking an intro chat. I'm looking forward to meeting you and hearing what you're working on."
      : "You're all set. I'm looking forward to working with you."),
    details(sessionRows(b, tz, true)),
    zoomFor(b) ? zoomButton(zoomFor(b)!) : noZoomPara(b),
    para("A calendar invite is attached, so you can add it to your calendar in one tap."),
    repeatPara(b, manageUrl),
    para("See you soon,<br>Avery"),
    manageLine(manageUrl, { refundNote: b.amountCents > 0 }),
  ].join("\n");

  return {
    to: b.email,
    subject: `You're booked: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `${day(b.start, tz)}, ${timeRange(b, tz)}`, tag: tagFor(b), title: "You're booked", body }),
    text: [
      `Hi ${firstName(b.name)},`, "",
      intro ? "Thanks for booking an intro chat." : "You're all set.", "",
      textRows([["Session", b.serviceName], ["Date", day(b.start, tz)], ["Time", timeRange(b, tz)], ["Zoom", b.zoomUrl ?? "Link to follow"],
        ...(b.amountCents > 0 ? [["Paid", money(b.amountCents)] as [string, string]] : [])]), "",
      `Need to reschedule or cancel? You can do it up to 24 hours before your session: ${manageUrl}`, "",
      "See you soon,", "Avery",
    ].join("\n"),
    attachments: icsAttachment(ics, "REQUEST"),
  };
}

// ── Sessions Avery booked for a student ──

const dueLine = (b: BookingView, tz: string) => b.payBy
  ? `Please pay ${money(b.dueCents!)} by ${day(b.payBy, tz)} at ${clock(b.payBy, tz)} ${zoneName(b.payBy, tz)}. Paying by then confirms your ${b.group ? "spot in the session" : "session"}; after that, ${b.group ? "your spot" : "the time"} will be opened up to other students.`
  : `Please pay ${money(b.dueCents!)} before your session.`;

export function adminInvite(b: BookingView, ics: string, manageUrl: string, payUrl: string | null): Email {
  const tz = b.clientTimeZone;
  const due = (b.dueCents ?? 0) > 0 && payUrl;
  const rows = sessionRows(b, tz, true);
  if (due) rows.push(["Price", esc(money(b.dueCents!))]);
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(b.repeatNext ? "Your next session is booked. Here are the details."
      : b.group ? "I've booked you into a group coaching session. Here are the details." : "I've booked a session for you. Here are the details."),
    noteBlock(b.message),
    details(rows),
    due ? para(esc(dueLine(b, tz))) + button(payUrl!, `Pay ${money(b.dueCents!)}`) : "",
    zoomFor(b) ? zoomButton(zoomFor(b)!) : noZoomPara(b),
    para("A calendar invite is attached, so you can add it to your calendar in one tap."),
    repeatPara(b, manageUrl),
    para("See you soon,<br>Avery"),
    manageLine(manageUrl, { group: b.group }),
  ].join("\n");
  return {
    to: b.email,
    subject: `${b.repeatNext ? (due ? "Next session booked, payment due" : "Next session booked") : due ? "Session booked, payment due" : "You're booked"}: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `${day(b.start, tz)}, ${timeRange(b, tz)}`, tag: b.group ? "Group coaching" : tagFor(b), title: "You're booked", body }),
    text: [
      `Hi ${firstName(b.name)},`, "",
      b.group ? "I've booked you into a group coaching session." : "I've booked a session for you.", "",
      ...(b.message ? ["Note:", b.message, ""] : []),
      textRows([["Session", b.serviceName], ["Date", day(b.start, tz)], ["Time", timeRange(b, tz)], ["Zoom", zoomFor(b) ?? noZoomText(b)]]), "",
      ...(due ? [dueLine(b, tz), `Pay here: ${payUrl}`, ""] : []),
      `${b.group ? "View or cancel your spot" : "Reschedule or cancel"} (up to 24 hours before): ${manageUrl}`, "",
      "See you soon,", "Avery",
    ].join("\n"),
    attachments: icsAttachment(ics, "REQUEST"),
  };
}

export function paymentReceived(b: BookingView, manageUrl: string, ics?: string): Email {
  const tz = b.clientTimeZone;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`Thanks, your payment of ${esc(money(b.amountCents))} went through. You're all set.${b.zoomUrl ? " Here's your Zoom link, and the attached invite updates your calendar with it." : ""}`),
    details(sessionRows(b, tz, true)),
    zoomFor(b) ? zoomButton(zoomFor(b)!) : "",
    para("See you soon,<br>Avery"),
    manageLine(manageUrl, { group: b.group, refundNote: true }),
  ].join("\n");
  return {
    to: b.email,
    subject: `Payment received: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `Paid ${money(b.amountCents)}`, tag: b.group ? "Group coaching" : tagFor(b), title: "Payment received", body }),
    text: [`Hi ${firstName(b.name)},`, "", `Thanks, your payment of ${money(b.amountCents)} went through. You're all set.`, "",
      textRows([["Session", b.serviceName], ["Date", day(b.start, tz)], ["Time", timeRange(b, tz)], ["Zoom", b.zoomUrl ?? "Link to follow"]]), "",
      `Manage your session: ${manageUrl}`, "", "See you soon,", "Avery"].join("\n"),
    ...(ics ? { attachments: icsAttachment(ics, "REQUEST") } : {}),
  };
}

export function adminPaymentReceived(b: BookingView): Email {
  const tz = AVERY_TZ;
  return {
    to: "",
    subject: `Payment received: ${b.name}, ${money(b.amountCents)} for ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${b.name} paid ${money(b.amountCents)}`, tag: b.group ? "Group coaching" : tagFor(b), title: "Payment received", subtitle: b.name,
      body: details(adminRows(b)) }),
    text: textRows([["Client", b.name], ["Paid", money(b.amountCents)], ["When", `${day(b.start, tz)}, ${timeRange(b, tz)}`]]),
  };
}

export function paymentReminder(b: BookingView, payUrl: string, manageUrl?: string): Email {
  const tz = b.clientTimeZone;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`A quick reminder that your ${esc(b.serviceName.toLowerCase())} on <strong>${esc(day(b.start, tz))}</strong> hasn't been paid yet.`),
    para(esc(dueLine(b, tz))),
    button(payUrl, `Pay ${money(b.dueCents!)}`),
    small(`Already paid? Thank you, you can ignore this email.${manageUrl ? ` Can't make it anymore? You can <a href="${esc(manageUrl)}" style="color:#6b727b;">${b.group ? "cancel your spot" : "cancel the session"}</a>.` : " If anything's changed, please reply to this email."}`),
    para("Thanks,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Payment due: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: dueLine(b, tz), tag: b.group ? "Group coaching" : tagFor(b), title: "Payment due", body }),
    text: [`Hi ${firstName(b.name)},`, "", `A quick reminder that your ${b.serviceName.toLowerCase()} on ${day(b.start, tz)} hasn't been paid yet.`, "",
      dueLine(b, tz), `Pay here: ${payUrl}`, "", ...(manageUrl ? [`Can't make it anymore? ${manageUrl}`, ""] : []), "Thanks,", "Avery"].join("\n"),
  };
}

export function unpaidReleased(b: BookingView, ics: string): Email {
  const tz = b.clientTimeZone;
  const when = `${day(b.start, tz)}, ${timeRange(b, tz)}`;
  const line = b.group
    ? `Payment for your spot in the group session on <strong>${esc(when)}</strong> didn't come through by the deadline, so your spot has been opened up to other students.`
    : `Payment for your ${esc(b.serviceName.toLowerCase())} on <strong>${esc(when)}</strong> didn't come through by the deadline, so the booking has been cancelled and the time opened up to other students.`;
  const plain = line.replace(/<[^>]+>/g, "");
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(line),
    para("If you'd still like a session, please reply to this email and we'll find a time."),
    small(questionsLine),
    para("Take care,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Cancelled: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: plain, tag: b.group ? "Group coaching" : tagFor(b), title: "Session cancelled", body }),
    text: [`Hi ${firstName(b.name)},`, "", plain, "",
      "If you'd still like a session, please reply to this email and we'll find a time.", "", questionsLine, "", "Take care,", "Avery"].join("\n"),
    attachments: icsAttachment(ics, "CANCEL"),
  };
}

export function adminUnpaidReleased(b: BookingView, groupContinues: boolean): Email {
  const tz = AVERY_TZ;
  const note = b.group
    ? (groupContinues ? "They were removed from the group session, which will go ahead for everyone else." : "They were the last student, so the group session was cancelled and the time was opened up.")
    : "The session was cancelled and the time was opened up.";
  return {
    to: "",
    subject: `Released (unpaid): ${b.name}, ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${b.name} didn't pay by the deadline`, tag: b.group ? "Group coaching" : tagFor(b), title: "Booking cancelled", subtitle: b.name,
      body: warn(`Not paid by the deadline. ${note} They were emailed.`) + details(adminRows(b, { zoom: false })) }),
    text: [`Not paid by the deadline. ${note} They were emailed.`, "", textRows([["Client", b.name], ["Was", `${day(b.start, tz)}, ${timeRange(b, tz)}`]])].join("\n"),
  };
}

// Paid through an old link after the session had been cancelled: refunded.
export function paidAfterCancel(b: BookingView): Email {
  const tz = b.clientTimeZone;
  return {
    to: b.email,
    subject: "About your payment: you've been refunded",
    html: layout({ preheader: "Your payment has been refunded.", tag: b.group ? "Group coaching" : tagFor(b), title: "Auto-refunded", body: [
      para(`Hi ${esc(firstName(b.name))},`),
      para(`Your payment of ${esc(money(b.amountCents))} came through after your session on ${esc(day(b.start, tz))} had already been cancelled, so it has been refunded in full. Refunds may take a few business days to appear.`),
      para("If you'd like to book a time, please reply to this email."),
      small(questionsLine),
      para("Take care,<br>Avery"),
    ].join("\n") }),
    text: [`Hi ${firstName(b.name)},`, "", `Your payment of ${money(b.amountCents)} came through after your session on ${day(b.start, tz)} had already been cancelled, so it has been refunded in full.`, "", "Take care,", "Avery"].join("\n"),
  };
}

// ── Bundles ──

export type BundleView = {
  name: string;
  email: string;
  pronouns?: string;
  credits: number;            // total sessions in the bundle
  remaining: number;
  sessionLength: string;      // "1 hour"
  expiresAt: number;
  clientTimeZone: string;
  amountCents: number;
  bundleName: string;         // "4 session bundle"
  goal?: string;
};

const countWord = (n: number) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);

export function bundlePurchased(p: BundleView, bundleUrl: string): Email {
  const tz = p.clientTimeZone;
  const body = [
    para(`Hi ${esc(firstName(p.name))},`),
    para(`Your ${countWord(p.credits)} ${esc(p.sessionLength === "1 hour" ? "one-hour" : p.sessionLength)} sessions are ready to book whenever you are.`),
    details([
      ["Bundle", esc(p.bundleName)],
      ["Sessions", `${p.credits} &times; ${esc(p.sessionLength)} on Zoom`],
      ["Use by", esc(day(p.expiresAt, tz))],
      ["Paid", esc(money(p.amountCents))],
    ]),
    button(bundleUrl, "Book your first session"),
    para("This is the link to your bundle page. It shows how many sessions you have left and lets you book, reschedule, or cancel them. Be sure to hang on to this email."),
    para("Looking forward to it,<br>Avery"),
    small(`Sessions can be rescheduled or cancelled up to 24 hours before they start, and the session goes back into your bundle. Sessions cancelled later than that, or not used by ${esc(day(p.expiresAt, tz))}, can't be returned.`),
  ].join("\n");
  return {
    to: p.email,
    subject: `Your ${p.credits} sessions are ready to book`,
    html: layout({ preheader: `Book your first session. Use by ${day(p.expiresAt, tz)}.`, tag: "Session bundle", title: "Bundle confirmed", body }),
    text: [`Hi ${firstName(p.name)},`, "", `Your ${countWord(p.credits)} ${p.sessionLength === "1 hour" ? "one-hour" : p.sessionLength} sessions are ready to book.`, "",
      textRows([["Bundle", p.bundleName], ["Use by", day(p.expiresAt, tz)], ["Paid", money(p.amountCents)]]), "",
      `Book your sessions: ${bundleUrl}`, "", "Looking forward to it,", "Avery"].join("\n"),
  };
}

export function adminBundlePurchased(p: BundleView): Email {
  const body = [
    details([
      ["Client", esc(p.name) + (p.pronouns ? ` (${esc(p.pronouns)})` : "")],
      ["Email", `<a href="mailto:${esc(p.email)}" style="color:#1f47f5;">${esc(p.email)}</a>`],
      ["Bundle", esc(p.bundleName)],
      ["Paid", esc(money(p.amountCents))],
      ["Use by", esc(day(p.expiresAt, AVERY_TZ))],
    ]),
    p.goal ? `<p style="margin:0 0 4px;font:700 11px/1.5 ${FONT};letter-spacing:1px;text-transform:uppercase;color:#6b727b;">Main goal</p><p style="margin:0 0 16px;font:14px/1.6 ${MONO};color:#0e1116;white-space:pre-wrap;">${esc(p.goal)}</p>` : "",
    small("You'll get a separate email each time they book a session from the bundle."),
  ].join("\n");
  return {
    to: "",
    subject: `Bundle purchased: ${p.name}, ${p.bundleName} (${money(p.amountCents)})`,
    html: layout({ preheader: `${p.name} bought ${p.bundleName}`, tag: "Session bundle", title: "Bundle purchased", subtitle: p.name, body }),
    text: textRows([["Client", p.name], ["Email", p.email], ["Bundle", p.bundleName], ["Paid", money(p.amountCents)], ["Use by", day(p.expiresAt, AVERY_TZ)]]),
  };
}

export function bundleExpiring(p: BundleView, bundleUrl: string): Email {
  const tz = p.clientTimeZone;
  const left = `${p.remaining} session${p.remaining === 1 ? "" : "s"}`;
  const body = [
    para(`Hi ${esc(firstName(p.name))},`),
    para(`A quick heads-up: you still have <strong>${esc(left)}</strong> left in your bundle, and they need to be used by <strong>${esc(day(p.expiresAt, tz))}</strong>.`),
    button(bundleUrl, "Book a session"),
    small("If the timing isn't working out, please reply to this email and we'll figure something out."),
    para("Talk soon,<br>Avery"),
  ].join("\n");
  return {
    to: p.email,
    subject: `You have ${left} left to use by ${shortDay(p.expiresAt, tz)}`,
    html: layout({ preheader: `Use by ${day(p.expiresAt, tz)}`, tag: "Session bundle", title: "Sessions expiring", body }),
    text: [`Hi ${firstName(p.name)},`, "", `You have ${left} left in your bundle, to use by ${day(p.expiresAt, tz)}.`, "", `Book a session: ${bundleUrl}`, "", "Talk soon,", "Avery"].join("\n"),
  };
}

// Avery added or removed a session, or extended the use-by date.
export function bundleUpdated(p: BundleView, change: "added" | "removed" | "extended", message: string, bundleUrl: string): Email {
  const tz = p.clientTimeZone;
  const what = change === "added" ? "I've added a session to your bundle."
    : change === "removed" ? "I've removed a session from your bundle."
    : `I've extended your bundle. You now have until ${day(p.expiresAt, tz)} to use it.`;
  const body = [
    para(`Hi ${esc(firstName(p.name))},`),
    para(esc(what)),
    noteBlock(message),
    details([["Bundle", esc(p.bundleName)], ["Sessions left", String(p.remaining)], ["Use by", esc(day(p.expiresAt, tz))]]),
    button(bundleUrl, "Go to your bundle"),
    para("Thanks,<br>Avery"),
  ].join("\n");
  return {
    to: p.email,
    subject: change === "extended" ? "Your bundle has been extended" : `Your bundle: ${change === "added" ? "a session added" : "a session removed"}`,
    html: layout({ preheader: what, tag: "Session bundle", title: "Bundle updated", body }),
    text: [`Hi ${firstName(p.name)},`, "", what, ...(message ? ["", "Note:", message] : []), "",
      textRows([["Bundle", p.bundleName], ["Sessions left", String(p.remaining)], ["Use by", day(p.expiresAt, tz)]]), "",
      `Your bundle: ${bundleUrl}`, "", "Thanks,", "Avery"].join("\n"),
  };
}

// ── Repeating sessions ──

type SeriesNote = { name: string; email: string; everyWeeks: number; bookUrl: string };
type SkipNote = SeriesNote & { timeZone: string; serviceName: string; when: number; next: number; reason: "day_off" | "taken"; continues: boolean };

export function seriesSkipped(p: SkipNote): Email {
  const tz = p.timeZone;
  const whenText = `${day(p.when, tz)} at ${clock(p.when, tz)} ${zoneName(p.when, tz)}`;
  const line = `Your usual ${p.serviceName.toLowerCase()} on ${whenText} isn't available, so it wasn't booked this time.`;
  const after = p.continues ? `Your repeating sessions carry on as normal after that (next: ${day(p.next, tz)}).` : "";
  return {
    to: p.email,
    subject: `No session on ${shortDay(p.when, tz)}: that time isn't available`,
    html: layout({ preheader: line, tag: "Private coaching", title: "Session skipped", body: [
      para(`Hi ${esc(firstName(p.name))},`), para(esc(line)), after ? para(esc(after)) : "",
      para("If you'd like a different time that week, you can book one here:"), button(p.bookUrl, "Pick another time"),
      para("Thanks,<br>Avery"),
    ].join("\n") }),
    text: [`Hi ${firstName(p.name)},`, "", line, ...(after ? ["", after] : []), "", `Pick another time: ${p.bookUrl}`, "", "Avery"].join("\n"),
  };
}

// A repeating session that clashes with Avery's calendar or a day off: held
// until she keeps or moves it (or sent anyway 2 days before).
export function adminSeriesClash(p: { name: string; serviceName: string; when: number; clash: "calendar" | "day_off"; wentAhead: boolean }): Email {
  const tz = AVERY_TZ;
  const at = `${day(p.when, tz)} at ${clock(p.when, tz)}`;
  const why = p.clash === "day_off" ? "falls on one of your days off" : "clashes with something on your calendar";
  const line = p.wentAhead
    ? `${p.name}'s repeating session on ${at} ${why}. You hadn't kept or moved it, so 2 days before, it went ahead at the usual time and ${p.name} has been sent the invite.`
    : `${p.name}'s next repeating session on ${at} ${why}. It's booked and the time is held, but ${p.name} hasn't been told yet. Keep it or move it to another time, and they'll get the invite then.`;
  return {
    to: "",
    subject: p.wentAhead ? `Repeat went ahead: ${p.name}, ${shortDay(p.when, tz)} at ${clock(p.when, tz)}` : `Repeat clash: ${p.name}, ${shortDay(p.when, tz)} at ${clock(p.when, tz)}`,
    html: layout({ preheader: line, tag: "Repeating session", title: "Needs attention", subtitle: p.name, body: [
      warn(line, FIX_ADMIN),
      button(FIX_ADMIN[1], p.wentAhead ? "Open Admin" : "Keep or move it"),
      p.wentAhead ? "" : small("If you haven't decided 2 days before the session, it goes ahead at the usual time and they're sent the invite."),
    ].join("\n") }),
    text: [line, "", `Keep or move it: ${FIX_ADMIN[1]}`].join("\n"),
  };
}

export function adminSeriesSkipped(p: SkipNote): Email {
  const tz = AVERY_TZ;
  const why = "another session has been booked at that time";
  return {
    to: "",
    subject: `Repeat skipped: ${p.name}, ${shortDay(p.when, tz)} at ${clock(p.when, tz)}`,
    html: layout({ preheader: `${p.name}'s repeating session was skipped`, tag: "Private coaching", title: "Session skipped", subtitle: p.name,
      body: para(esc(`${p.name}'s repeating session on ${day(p.when, tz)} at ${clock(p.when, tz)} wasn't booked because ${why}. They've been emailed a link to pick another time.${p.continues ? " The series carries on after that." : ""}`)) }),
    text: `${p.name}'s repeating session on ${day(p.when, tz)} at ${clock(p.when, tz)} wasn't booked because ${why}.`,
  };
}

export function seriesStopped(p: SeriesNote & { by: "client" | "admin" | "unpaid" }): Email {
  const each = p.everyWeeks === 1 ? "each week" : `every ${p.everyWeeks} weeks`;
  const line = p.by === "unpaid"
    ? `Your recurring sessions have been stopped, because payment for the last two didn't come through before their deadlines. Your sessions will no longer repeat ${each}.`
    : p.by === "client" ? `This is to confirm that you have cancelled your recurring sessions. Your sessions will no longer repeat ${each}.`
    : `This is to confirm that I have cancelled your recurring sessions. Your sessions will no longer repeat ${each}.`;
  return {
    to: p.email,
    subject: "Your sessions won't repeat anymore",
    html: layout({ preheader: line, tag: "Private coaching", title: "Repeats stopped", body: [
      para(`Hi ${esc(firstName(p.name))},`), para(esc(line)), para("Any session already booked is still on. You're always welcome to book again:"),
      button(p.bookUrl, "Book a session"), small(questionsLine), para("Thanks,<br>Avery"),
    ].join("\n") }),
    text: [`Hi ${firstName(p.name)},`, "", line, "", "Any session already booked is still on.", `Book again: ${p.bookUrl}`, "", questionsLine, "", "Avery"].join("\n"),
  };
}

export function adminSeriesStopped(p: SeriesNote & { by: "client" | "admin" | "unpaid" }): Email {
  const why = p.by === "unpaid" ? "the last two sessions weren't paid for by their deadlines" : "they stopped it";
  return {
    to: "",
    subject: `Repeats stopped: ${p.name}`,
    html: layout({ preheader: `${p.name}'s sessions have stopped repeating`, tag: "Private coaching", title: "Repeats stopped", subtitle: p.name,
      body: para(esc(`${p.name}'s sessions (${repeatWords(p.everyWeeks)}) have stopped repeating because ${why}. Sessions already booked are still on.`)) }),
    text: `${p.name}'s sessions have stopped repeating because ${why}.`,
  };
}

// ── iCloud can't be reached (or is back) ──

export function icloudStatus(ok: boolean, error: string): Email {
  const body = ok
    ? [para("Your booking page can read your iCloud calendars again. Clients can book as normal.")].join("\n")
    : [
      warn("Your booking page can't read your iCloud calendars, so clients can't see open times or book right now."),
      para("The most common cause is the app-specific password being revoked, which can happen when your Apple ID password changes or you sign out of devices. To fix it, make a new app-specific password at account.apple.com and send it to the booking service."),
      button("https://account.apple.com/account/manage", "Make a new password"),
      small(`What iCloud said: ${esc(error)}`),
      small("You'll get one more email when it's working again."),
    ].join("\n");
  return {
    to: "",
    subject: ok ? "Booking system: iCloud is working again" : "Booking system: can't reach your iCloud calendar",
    html: layout({ preheader: ok ? "iCloud is working again." : "Clients can't book until this is fixed.", tag: ok ? "Booking system" : "Error", title: ok ? "Issue resolved" : "Needs attention", body }),
    text: ok ? "Your booking page can read your iCloud calendars again."
      : `Your booking page can't read your iCloud calendars, so clients can't book right now.\n\nMost likely the app-specific password was revoked. Make a new one at account.apple.com.\n\niCloud said: ${error}`,
  };
}

// ── Refunds Avery gives by hand, and refund requests ──

type RefundNote = { name: string; email: string; what: string; message?: string };

export function refundIssued(p: RefundNote & { amountCents: number }): Email {
  const line = `I've refunded ${money(p.amountCents)} for ${p.what}. Refunds may take a few business days to appear.`;
  return {
    to: p.email,
    subject: `Refund: ${money(p.amountCents)}`,
    html: layout({ preheader: line, tag: "Refund", title: "Refund issued", body: [
      para(`Hi ${esc(firstName(p.name))},`), para(esc(line)), noteBlock(p.message), para("Take care,<br>Avery"),
    ].join("\n") }),
    text: [`Hi ${firstName(p.name)},`, "", line, ...(p.message ? ["", "Note:", p.message] : []), "", "Take care,", "Avery"].join("\n"),
  };
}

export function refundDeclined(p: RefundNote): Email {
  const line = `Thanks for reaching out about ${p.what}. I'm unfortunately not able to offer a refund for it.`;
  return {
    to: p.email,
    subject: "About your refund request",
    html: layout({ preheader: "About your refund request", tag: "Refund", title: "About your request", body: [
      para(`Hi ${esc(firstName(p.name))},`), para(esc(line)), noteBlock(p.message),
      small("If you have any questions, please reply to this email."), para("Take care,<br>Avery"),
    ].join("\n") }),
    text: [`Hi ${firstName(p.name)},`, "", line, ...(p.message ? ["", "Note:", p.message] : []), "", "If you have any questions, please reply to this email.", "", "Avery"].join("\n"),
  };
}

export function adminRefundRequest(p: { name: string; email: string; what: string; paidCents: number; leftCents: number; message: string }): Email {
  return {
    to: "",
    subject: `Refund request: ${p.name}, ${p.what}`,
    html: layout({ preheader: `${p.name} asked for a refund`, tag: "Refund", title: "Refund request", subtitle: p.name, body: [
      details([
        ["Client", esc(p.name)], ["Email", `<a href="mailto:${esc(p.email)}" style="color:#1f47f5;">${esc(p.email)}</a>`],
        ["For", esc(p.what)], ["Paid", esc(money(p.paidCents))], ...(p.leftCents !== p.paidCents ? [["Not yet refunded", esc(money(p.leftCents))] as [string, string]] : []),
      ]),
      p.message ? noteBlock(p.message) : small("They didn't add a message."),
      button("https://book.averywhitted.com/admin#attention", "Review in admin"),
      small("You can refund any amount, or decline with a note. Either way they're emailed."),
    ].join("\n") }),
    text: [`${p.name} (${p.email}) asked for a refund for ${p.what}. Paid ${money(p.paidCents)}.`, "", p.message || "(no message)", "",
      "Review: https://book.averywhitted.com/admin#attention"].join("\n"),
  };
}

export type BundleCancelView = BundleView & {
  byAvery?: boolean;          // cancelled from the admin page (at the client's request)
  used: number;               // sessions that happened or were too close to cancel
  refundCents: number;
  cancelledSessions: number[];  // start times of sessions cancelled with the bundle
  keptSessions: number[];       // sessions within 24 hours that still go ahead
};

export function bundleCancelled(p: BundleCancelView): Email {
  const tz = p.clientTimeZone;
  const when = (ms: number) => `${shortDay(ms, tz)}, ${clock(ms, tz)} ${zoneName(ms, tz)}`;
  const body = [
    para(`Hi ${esc(firstName(p.name))},`),
    para(`Your ${esc(p.bundleName)} has been cancelled.`),
    details([
      ["Sessions used", String(p.used)],
      ["Refund", p.refundCents > 0 ? esc(money(p.refundCents)) : p.byAvery ? "None" : "None (all sessions were used)"],
      ...(p.cancelledSessions.length ? [["Cancelled", p.cancelledSessions.map((ms) => esc(when(ms))).join("<br>")] as [string, string]] : []),
      ...(p.keptSessions.length ? [["Still on", p.keptSessions.map((ms) => esc(when(ms))).join("<br>")] as [string, string]] : []),
    ]),
    p.refundCents > 0 ? para(`Your refund of ${esc(money(p.refundCents))} is being processed and may take a few business days to appear.`) : "",
    p.keptSessions.length && !p.byAvery ? small("Sessions less than 24 hours away can't be cancelled online, so they're still on. Reply to this email if you can't make it.") : "",
    p.cancelledSessions.length ? small("Calendar invites for the cancelled sessions will be removed.") : "",
    small(questionsLine),
    para("Thanks for working with me. You're always welcome back.<br>Avery"),
  ].join("\n");
  return {
    to: p.email,
    subject: `Your bundle is cancelled${p.refundCents > 0 ? `: ${money(p.refundCents)} refund on the way` : ""}`,
    html: layout({ preheader: p.refundCents > 0 ? `Refund of ${money(p.refundCents)} is processing.` : "Your bundle is cancelled.", tag: "Session bundle", title: "Bundle cancelled", body }),
    text: [`Hi ${firstName(p.name)},`, "", `Your ${p.bundleName} has been cancelled.`, "",
      textRows([["Sessions used", String(p.used)], ["Refund", p.refundCents > 0 ? money(p.refundCents) : "None"]]),
      ...(p.refundCents > 0 ? ["", `Your refund of ${money(p.refundCents)} is being processed and may take a few business days to appear.`] : []),
      "", questionsLine, "", "Avery"].join("\n"),
  };
}

export function adminBundleCancelled(p: BundleCancelView, stripePaymentUrl: string | null): Email {
  const tz = AVERY_TZ;
  const when = (ms: number) => `${shortDay(ms, tz)}, ${clock(ms, tz)}`;
  const body = [
    p.refundCents > 0 ? warn(`Refund due: ${money(p.refundCents)}. They've been told it's processing.`) : "",
    p.refundCents > 0 && stripePaymentUrl ? button(stripePaymentUrl, `Refund ${money(p.refundCents)} in Stripe`) : "",
    details([
      ["Client", esc(p.name)],
      ["Email", `<a href="mailto:${esc(p.email)}" style="color:#1f47f5;">${esc(p.email)}</a>`],
      ["Bundle", `${esc(p.bundleName)} (${esc(money(p.amountCents))})`],
      ["Used", `${p.used} of ${p.credits}`],
      ["Refund", p.refundCents > 0 ? esc(money(p.refundCents)) : "None"],
      ...(p.cancelledSessions.length ? [["Cancelled", p.cancelledSessions.map((ms) => esc(when(ms))).join("<br>")] as [string, string]] : []),
      ...(p.keptSessions.length ? [["Still on", p.keptSessions.map((ms) => esc(when(ms))).join("<br>")] as [string, string]] : []),
    ]),
    small("Cancelled sessions have been removed from your Coaching calendar and Zoom. The refund is what they paid minus the sessions used, each charged at the full single-session price."),
  ].join("\n");
  return {
    to: "",
    subject: `Bundle cancelled: ${p.name}${p.refundCents > 0 ? ` (refund ${money(p.refundCents)})` : ""}`,
    html: layout({ preheader: `${p.name} cancelled their bundle`, tag: "Session bundle", title: "Bundle cancelled", subtitle: p.name, body }),
    text: textRows([["Client", p.name], ["Bundle", p.bundleName], ["Used", `${p.used} of ${p.credits}`], ["Refund due", money(p.refundCents)], ...(stripePaymentUrl ? [["Stripe", stripePaymentUrl] as [string, string]] : [])]),
  };
}

// ── Client: session moved ──

export function clientRescheduled(b: BookingView, previousStart: number, ics: string, manageUrl: string): Email {
  const tz = b.clientTimeZone;
  const was = `${day(previousStart, tz)}, ${clock(previousStart, tz)} ${zoneName(previousStart, tz)}`;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para("Your session has been moved. Here are the new details:"),
    details([...sessionRows(b, tz, false), ["Was", `<span style="color:#6b727b;text-decoration:line-through;">${esc(was)}</span>`]]),
    zoomFor(b) ? zoomButton(zoomFor(b)!) : "",
    para("The attached invite updates the event already in your calendar."),
    para("See you then,<br>Avery"),
    manageLine(manageUrl, { group: b.group }),
  ].join("\n");
  return {
    to: b.email,
    subject: `Rescheduled: ${b.serviceName} now on ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `New time: ${day(b.start, tz)}, ${timeRange(b, tz)}`, tag: tagFor(b), title: "Session rescheduled", body }),
    text: [`Hi ${firstName(b.name)},`, "", "Your session has been moved.", "",
      textRows([["Session", b.serviceName], ["New date", day(b.start, tz)], ["New time", timeRange(b, tz)], ["Was", was], ["Zoom", zoomFor(b) ?? noZoomText(b)]]), "",
      `Reschedule or cancel: ${manageUrl}`, "", "See you then,", "Avery"].join("\n"),
    attachments: icsAttachment(ics, "REQUEST"),
  };
}

// ── Client: session cancelled ──

// What happened to the money when a session was cancelled:
//   refunded / pending  refund sent (or being sent) automatically
//   offer               Avery cancelled and didn't refund yet: client chooses refund or new time
//   none                free session or bundle session
export type RefundState = "refunded" | "pending" | "offer" | "none";

function refundLine(b: BookingView, refund: RefundState): string {
  if (refund === "refunded" || refund === "pending") return `Your full refund of ${money(b.amountCents)} is on its way. Refunds may take a few business days to appear.`;
  if (refund === "offer") return "Since this cancellation came from my side, you can either have a full refund or schedule a new time at no charge, whichever you prefer. Please reply to this email and let me know.";
  return "";
}

export function clientCancelled(b: BookingView, ics: string, bookUrl: string, refund: RefundState = "none", creditReturned = true): Email {
  const tz = b.clientTimeZone;
  const when = `${day(b.start, tz)}, ${timeRange(b, tz)}`;
  const money_ = b.bundleNote
    ? (creditReturned ? "The session has gone back into your bundle, so you can book another time whenever you like."
      : "Because this session was cancelled less than 24 hours before your scheduled time, per our policy, the session was not returned to your bundle.")
    : refundLine(b, refund);
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`Your ${esc(b.serviceName.toLowerCase())} on <strong>${esc(when)}</strong> has been cancelled.`),
    money_ ? para(esc(money_)) : "",
    para("The attached update removes it from your calendar. Whenever you're ready, you're welcome to book another time:"),
    button(bookUrl, "Book another time"),
    small(questionsLine),
    para("Take care,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Cancelled: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `Your session on ${when} is cancelled.`, tag: tagFor(b), title: "Session cancelled", body }),
    text: [`Hi ${firstName(b.name)},`, "", `Your ${b.serviceName.toLowerCase()} on ${when} has been cancelled.`,
      ...(money_ ? ["", money_] : []),
      "", `Book another time: ${bookUrl}`, "", questionsLine, "", "Take care,", "Avery"].join("\n"),
    attachments: icsAttachment(ics, "CANCEL"),
  };
}

// ── Avery: new booking, rescheduled, cancelled, auto-refunded ──

function adminRows(b: BookingView, opts: { zoom?: boolean } = {}): [string, string][] {
  const tz = AVERY_TZ;
  const rows: [string, string][] = [
    ["Client", esc(b.name) + (b.pronouns ? ` (${esc(b.pronouns)})` : "")],
    ["Email", `<a href="mailto:${esc(b.email)}" style="color:#1f47f5;">${esc(b.email)}</a>`],
    ["Session", esc(b.serviceName)],
    ["When", `${esc(day(b.start, tz))}<br>${esc(timeRange(b, tz))}`],
    ["Paid", b.bundleNote ? esc(b.bundleNote) : b.amountCents > 0 ? esc(money(b.amountCents) + (b.promoCode ? ` (code ${b.promoCode})` : ""))
      : (b.dueCents ?? 0) > 0 ? esc(`Not yet (${money(b.dueCents!)} due)`) : "Free"],
  ];
  if (opts.zoom !== false) rows.push(["Zoom", b.zoomUrl ? `<a href="${esc(b.zoomUrl)}" style="color:#1f47f5;">${esc(b.zoomUrl)}</a>` : "Not created"]);
  if (b.clientTimeZone !== tz) rows.push(["Their time", esc(`${clock(b.start, b.clientTimeZone)} ${zoneName(b.start, b.clientTimeZone)}`)]);
  return rows;
}

function intakeHtml(b: BookingView): string {
  const intake: [string, string | undefined][] = [
    [b.kind === "intro" ? "Wants to talk about" : "Main goal", b.goal],
    ["Material", b.material],
    ["Link", b.link],
    ["Anything else", b.notes],
  ];
  return intake.filter(([, v]) => v && v.trim()).map(([k, v]) =>
    `<p style="margin:0 0 4px;font:700 11px/1.5 ${FONT};letter-spacing:1px;text-transform:uppercase;color:#6b727b;">${esc(k)}</p>
     <p style="margin:0 0 16px;font:14px/1.6 ${MONO};color:#0e1116;white-space:pre-wrap;">${k === "Link" ? `<a href="${esc(v!)}" style="color:#1f47f5;">${esc(v!)}</a>` : esc(v!)}</p>`).join("\n");
}

export function adminNotification(b: BookingView, opts: { zoomMissing: boolean; calendarFailed: boolean; notice?: string; noticeFix?: Fix | null; title?: string }): Email {
  const tz = AVERY_TZ;
  const warnings = ([
    [opts.notice ?? "", opts.noticeFix ?? null],
    [opts.zoomMissing ? "No Zoom meeting was created. Please make one and send the client the link." : "", FIX_ZOOM],
    [opts.calendarFailed ? "This booking couldn't be added to your Coaching calendar yet. It will keep retrying automatically." : "", FIX_ADMIN],
  ] as [string, Fix | null][]).filter(([t]) => t);
  const body = [warnings.map(([t, f]) => warn(t, f)).join(""), details(adminRows(b)), intakeHtml(b)].join("\n");
  return {
    to: "", // filled in with ADMIN_EMAIL by the caller
    subject: `New booking: ${b.name}, ${b.serviceName} on ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${b.name} booked ${b.serviceName}`, tag: tagFor(b), title: opts.title ?? "New booking", subtitle: b.name, body }),
    text: [
      ...warnings.map(([t, f]) => t + fixText(f)), warnings.length ? "" : "",
      textRows([["Client", b.name], ["Email", b.email], ["Session", b.serviceName], ["When", `${day(b.start, tz)}, ${timeRange(b, tz)}`],
        ["Paid", b.amountCents > 0 ? money(b.amountCents) : "Free"], ["Zoom", b.zoomUrl ?? "Not created"]]), "",
    ].join("\n"),
  };
}

export function adminRescheduled(b: BookingView, previousStart: number, opts: { calendarFailed: boolean }): Email {
  const tz = AVERY_TZ;
  const was = `${day(previousStart, tz)}, ${clock(previousStart, tz)} ${zoneName(previousStart, tz)}`;
  const body = [
    opts.calendarFailed ? warn("Your Coaching calendar couldn't be updated yet. Please move the event by hand.", FIX_CALENDAR) : "",
    details([...adminRows(b), ["Was", `<span style="color:#6b727b;text-decoration:line-through;">${esc(was)}</span>`]]),
    small("Your Coaching calendar event and the Zoom meeting have been moved to the new time."),
  ].join("\n");
  return {
    to: "",
    subject: `Rescheduled: ${b.name} moved to ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${b.name} moved their session`, tag: tagFor(b), title: "Booking rescheduled", subtitle: b.name, body }),
    text: [textRows([["Client", b.name], ["New time", `${day(b.start, tz)}, ${timeRange(b, tz)}`], ["Was", was]])].join("\n"),
  };
}

export function adminCancelled(b: BookingView, stripePaymentUrl: string | null,
  r: { refund: RefundState; calendarRemoved: boolean; zoomRemoved: boolean } = { refund: "none", calendarRemoved: true, zoomRemoved: true }): Email {
  const tz = AVERY_TZ;
  const amount = money(b.amountCents);
  const refundNote = r.refund === "refunded" ? `Refunded ${amount} automatically. They cancelled at least 24 hours ahead.`
    : r.refund === "pending" ? `The automatic refund of ${amount} hasn't gone through yet. It will keep retrying, and you'll get an alert if it still doesn't go through.`
    : r.refund === "offer" ? `Not refunded. They were offered a full refund or a new time, whichever they prefer.`
    : "";
  const tag = r.refund === "refunded" ? ` (refunded ${amount})` : r.refund === "pending" ? ` (refund pending ${amount})` : "";
  const leftovers: [string, Fix][] = [
    ...(r.calendarRemoved ? [] : [["It couldn't be removed from your Coaching calendar yet. It will keep retrying; if you still see it, delete it by hand.", FIX_CALENDAR] as [string, Fix]]),
    ...(r.zoomRemoved ? [] : [["The Zoom meeting couldn't be deleted yet. It will keep retrying; you can also delete it in Zoom.", FIX_ZOOM] as [string, Fix]]),
  ];
  const body = [
    r.refund === "pending" || r.refund === "offer" ? warn(refundNote) : refundNote ? small(refundNote) : "",
    stripePaymentUrl && r.refund !== "none" ? button(stripePaymentUrl, r.refund === "refunded" ? "View payment in Stripe" : `Refund ${amount} in Stripe`) : "",
    ...leftovers.map(([t, f]) => warn(t, f)),
    details(adminRows(b, { zoom: false })),
    b.bundleNote ? small("It was a bundle session, so the credit has gone back into their bundle.") : "",
    leftovers.length ? "" : small("The event has been removed from your Coaching calendar and the Zoom meeting deleted. The time is open for booking again."),
  ].join("\n");
  return {
    to: "",
    subject: `Cancelled: ${b.name}, ${b.serviceName} on ${shortDay(b.start, tz)}${tag}`,
    html: layout({ preheader: `${b.name} cancelled${tag}`, tag: tagFor(b), title: "Booking cancelled", subtitle: b.name, body }),
    text: [
      ...(refundNote ? [refundNote, ...(stripePaymentUrl ? [stripePaymentUrl] : []), ""] : []),
      ...leftovers.flatMap(([t, f]) => [t + fixText(f), ""]),
      textRows([["Client", b.name], ["Session", b.serviceName], ["Was", `${day(b.start, tz)}, ${timeRange(b, tz)}`]]),
    ].join("\n"),
  };
}

// ── Client: the day before their session ──

function relativeDay(ms: number, tz: string, now: number): string {
  const key = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  if (key(ms) === key(now)) return "today";
  if (key(ms) === key(now + 86400000)) return "tomorrow";
  return `on ${day(ms, tz)}`;
}

export function sessionReminder(b: BookingView, now: number): Email {
  const tz = b.clientTimeZone;
  const when = relativeDay(b.start, tz, now);
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`Just a reminder that your ${esc(b.serviceName.toLowerCase())} is ${esc(when)} at <strong>${esc(clock(b.start, tz))} ${esc(zoneName(b.start, tz))}</strong>.`),
    details(sessionRows(b, tz, false)),
    zoomFor(b) ? zoomButton(zoomFor(b)!) : noZoomPara(b),
    b.kind === "intro"
      ? para("Come as you are. It's a relaxed chat to get to know each other and what you're working on.")
      : para("To make the most of our time, have your material open and ready, and find a quiet spot with a good connection."),
    small("Can't make it? It's now less than 24 hours before your session, so please reply to this email and I'll help."),
    para("See you soon,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Reminder: your ${b.serviceName.toLowerCase()} ${when} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${day(b.start, tz)}, ${timeRange(b, tz)}${zoomFor(b) ? ". Zoom link inside." : ""}`, tag: tagFor(b), title: "See you soon", body }),
    text: [`Hi ${firstName(b.name)},`, "", `Just a reminder that your ${b.serviceName.toLowerCase()} is ${when} at ${clock(b.start, tz)} ${zoneName(b.start, tz)}.`, "",
      textRows([["Date", day(b.start, tz)], ["Time", timeRange(b, tz)], ["Zoom", zoomFor(b) ?? noZoomText(b)]]), "",
      "Can't make it? Please reply to this email.", "", "See you soon,", "Avery"].join("\n"),
  };
}

// ── Avery: something needs attention ──

export type Problem = string | { text: string; fix?: Fix | null };
export function attentionAlert(problemsIn: Problem[]): Email {
  const problems = problemsIn.map((p) => (typeof p === "string" ? { text: p, fix: FIX_ADMIN } : { text: p.text, fix: p.fix ?? FIX_ADMIN }));
  const body = [
    para("The booking system ran into something it couldn't fix on its own:"),
    `<ul style="margin:0 0 18px;padding-left:20px;font:14px/1.6 ${FONT};color:#2c3138;">${problems.map((p) => `<li style="margin:0 0 10px;">${esc(p.text)}<br><a href="${esc(p.fix[1])}" style="color:#1f47f5;font-weight:700;">${esc(p.fix[0])} &rarr;</a></li>`).join("")}</ul>`,
    button(FIX_ADMIN[1], "Open Admin"),
    small("Emails and calendar updates retry automatically every few minutes, so some of these may clear on their own. You'll get at most one of these alerts an hour."),
  ].join("\n");
  return {
    to: "",
    subject: `Booking system: ${problems.length} thing${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} attention`,
    html: layout({ preheader: problems[0]?.text ?? "", tag: "Error", title: "Needs attention", body }),
    text: ["The booking system ran into something it couldn't fix on its own:", "", ...problems.map((p) => `- ${p.text}${fixText(p.fix)}`)].join("\n"),
  };
}

// ── Client: checkout wasn't finished ──

export function checkoutReminder(b: BookingView, bookUrl: string): Email {
  const tz = b.clientTimeZone;
  const when = `${day(b.start, tz)} at ${clock(b.start, tz)} ${zoneName(b.start, tz)}`;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`It looks like you started booking a ${esc(b.serviceName.toLowerCase())} for <strong>${esc(when)}</strong>, but checkout wasn't finished, so that time hasn't been reserved.`),
    para("If you'd still like to work together, you can pick up where you left off:"),
    button(bookUrl, "Finish booking"),
    small("If that time is no longer open, you'll be able to choose another. If you meant to stop, no worries, you can ignore this email."),
    para("Hope to see you soon,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: "Your session isn't booked yet",
    html: layout({ preheader: `Finish booking your session for ${when}`, tag: tagFor(b), title: "Finish your booking", body }),
    text: [`Hi ${firstName(b.name)},`, "", `It looks like you started booking a ${b.serviceName.toLowerCase()} for ${when}, but checkout wasn't finished, so that time hasn't been reserved.`, "",
      `Finish booking: ${bookUrl}`, "", "Hope to see you soon,", "Avery"].join("\n"),
  };
}

// ── Client: bundle checkout wasn't finished ──

export function bundleCheckoutReminder(p: BundleView, bookUrl: string): Email {
  const body = [
    para(`Hi ${esc(firstName(p.name))},`),
    para(`It looks like you started buying a ${esc(p.bundleName)}, but checkout wasn't finished, so nothing was charged.`),
    para("If you'd still like it, you can pick up where you left off:"),
    button(bookUrl, "Finish your purchase"),
    small("If you meant to stop, no worries, you can ignore this email."),
    para("Hope to see you soon,<br>Avery"),
  ].join("\n");
  return {
    to: p.email,
    subject: "Your bundle isn't finished yet",
    html: layout({ preheader: `Finish buying your ${p.bundleName}`, tag: "Private coaching", title: "Finish your booking", body }),
    text: [`Hi ${firstName(p.name)},`, "", `It looks like you started buying a ${p.bundleName}, but checkout wasn't finished.`, "", `Finish your purchase: ${bookUrl}`, "", "Avery"].join("\n"),
  };
}

// ── Client: paid after the hold expired and the time was taken ──

export function slotTakenRefund(b: BookingView, bookUrl: string): Email {
  const tz = b.clientTimeZone;
  const when = `${day(b.start, tz)} at ${clock(b.start, tz)} ${zoneName(b.start, tz)}`;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`I'm sorry: your payment went through after the time you picked (<strong>${esc(when)}</strong>) had already been booked by someone else. You've been refunded in full (${esc(money(b.amountCents))}). Refunds may take a few business days to appear.`),
    para("I'd still love to work with you. Please pick another time:"),
    button(bookUrl, "Choose a new time"),
    small(questionsLine),
    para("Sorry for the mix-up,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: "About your booking: you've been refunded",
    html: layout({ preheader: "That time was taken, so you've been refunded in full.", tag: "Refunded", title: "That time was taken", body }),
    text: [`Hi ${firstName(b.name)},`, "", `Your payment went through after ${when} had already been booked. You've been refunded in full (${money(b.amountCents)}).`, "",
      `Choose a new time: ${bookUrl}`, "", "Sorry for the mix-up,", "Avery"].join("\n"),
  };
}

// Every fixed heading used above (drawn as images by tools/render-headings.html).
export const HEADING_TITLES = [
  "You're booked", "Session rescheduled", "Session cancelled", "Finish your booking", "That time was taken",
  "New booking", "Booking rescheduled", "Booking cancelled", "Auto-refunded",
  "See you soon", "Needs attention",
  "Bundle confirmed", "Bundle purchased", "Sessions expiring", "Bundle cancelled",
  "Payment due", "Payment received", "Bundle updated", "Refund issued",
  "About your request", "Refund request", "Session skipped", "Repeats stopped", "Issue resolved",
];
