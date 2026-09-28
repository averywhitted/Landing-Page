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
};

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
const warn = (text: string) =>
  `<p style="margin:0 0 14px;padding:12px 14px;border-radius:12px;background:#fff4e5;font:600 14px/1.5 ${FONT};color:#7a4b00;">${esc(text)}</p>`;

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
    ["Date", esc(day(b.start, tz))],
    ["Time", esc(timeRange(b, tz))],
    ["Where", zoomFor(b) ? `<a href="${esc(zoomFor(b)!)}" style="color:#1f47f5;">Join on Zoom</a>` : `Zoom (${noZoomText(b).toLowerCase()})`],
  ];
  if (withPaid && b.bundleNote) rows.push(["Paid", esc(b.bundleNote)]);
  else if (withPaid && b.amountCents > 0) rows.push(["Paid", esc(money(b.amountCents) + (b.promoCode ? ` (code ${b.promoCode})` : ""))]);
  return rows;
}

function manageBlock(manageUrl: string, refundNote: boolean): string {
  return small(`Need to reschedule or cancel? You can do it yourself up to 24 hours before your session.${refundNote ? " Refunds for cancellations may take a few business days to appear." : ""}`)
    + ghostButton(manageUrl, "Reschedule or cancel");
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
    manageBlock(manageUrl, b.amountCents > 0),
    para("See you soon,<br>Avery"),
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
  ? `Please pay ${money(b.dueCents!)} by ${day(b.payBy, tz)} at ${clock(b.payBy, tz)} ${zoneName(b.payBy, tz)}. If it isn't paid by then, the session is released.`
  : `Please pay ${money(b.dueCents!)} before your session.`;

export function adminInvite(b: BookingView, ics: string, manageUrl: string, payUrl: string | null): Email {
  const tz = b.clientTimeZone;
  const due = (b.dueCents ?? 0) > 0 && payUrl;
  const rows = sessionRows(b, tz, true);
  if (due) rows.push(["Price", esc(money(b.dueCents!))]);
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(b.group ? "I've booked you into a group coaching session. Here are the details." : "I've booked a session for you. Here are the details."),
    b.message ? `<p style="margin:0 0 16px;padding:12px 14px;border-left:3px solid #1f47f5;font:15px/1.65 ${FONT};color:#2c3138;white-space:pre-wrap;">${esc(b.message)}</p>` : "",
    details(rows),
    due ? para(esc(dueLine(b, tz))) + button(payUrl!, `Pay ${money(b.dueCents!)}`) : "",
    zoomFor(b) ? zoomButton(zoomFor(b)!) : noZoomPara(b),
    para("A calendar invite is attached, so you can add it to your calendar in one tap."),
    b.group
      ? small("Can't make it? You can cancel your spot up to 24 hours before the session.") + ghostButton(manageUrl, "View or cancel")
      : manageBlock(manageUrl, false),
    para("See you soon,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `${due ? "Session booked, payment due" : "You're booked"}: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `${day(b.start, tz)}, ${timeRange(b, tz)}`, tag: b.group ? "Group coaching" : tagFor(b), title: "You're booked", body }),
    text: [
      `Hi ${firstName(b.name)},`, "",
      b.group ? "I've booked you into a group coaching session." : "I've booked a session for you.", "",
      ...(b.message ? [b.message, ""] : []),
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
    ghostButton(manageUrl, b.group ? "View or cancel" : "Reschedule or cancel"),
    para("See you soon,<br>Avery"),
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
    subject: `Paid: ${b.name}, ${money(b.amountCents)} for ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${b.name} paid ${money(b.amountCents)}`, tag: b.group ? "Group coaching" : tagFor(b), title: "Payment received", subtitle: b.name,
      body: details(adminRows(b)) }),
    text: textRows([["Client", b.name], ["Paid", money(b.amountCents)], ["When", `${day(b.start, tz)}, ${timeRange(b, tz)}`]]),
  };
}

export function paymentReminder(b: BookingView, payUrl: string): Email {
  const tz = b.clientTimeZone;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`A quick reminder that your ${esc(b.serviceName.toLowerCase())} on <strong>${esc(day(b.start, tz))}</strong> hasn't been paid yet.`),
    para(esc(dueLine(b, tz))),
    button(payUrl, `Pay ${money(b.dueCents!)}`),
    small("Already paid? Thank you, you can ignore this email. If anything's changed, just reply."),
    para("Thanks,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Payment due: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: dueLine(b, tz), tag: b.group ? "Group coaching" : tagFor(b), title: "Payment due", body }),
    text: [`Hi ${firstName(b.name)},`, "", `A quick reminder that your ${b.serviceName.toLowerCase()} on ${day(b.start, tz)} hasn't been paid yet.`, "",
      dueLine(b, tz), `Pay here: ${payUrl}`, "", "Thanks,", "Avery"].join("\n"),
  };
}

export function unpaidReleased(b: BookingView, ics: string): Email {
  const tz = b.clientTimeZone;
  const when = `${day(b.start, tz)}, ${timeRange(b, tz)}`;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`Your ${esc(b.serviceName.toLowerCase())} on <strong>${esc(when)}</strong> wasn't paid by the deadline, so it has been released.`),
    para("If you'd still like a session, just reply to this email and we'll find a time."),
    para("Take care,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Released: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `Your session on ${when} has been released.`, tag: b.group ? "Group coaching" : tagFor(b), title: "Session cancelled", body }),
    text: [`Hi ${firstName(b.name)},`, "", `Your ${b.serviceName.toLowerCase()} on ${when} wasn't paid by the deadline, so it has been released.`, "",
      "If you'd still like a session, just reply to this email and we'll find a time.", "", "Take care,", "Avery"].join("\n"),
    attachments: icsAttachment(ics, "CANCEL"),
  };
}

export function adminUnpaidReleased(b: BookingView, groupContinues: boolean): Email {
  const tz = AVERY_TZ;
  const note = b.group
    ? (groupContinues ? "They were removed from the group session, which goes ahead for everyone else." : "They were the last student, so the group session was cancelled and the time opened up.")
    : "The session was cancelled and the time opened up.";
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
      para("If you'd like to book a time, just reply to this email."),
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
    para(`Thanks for picking up a bundle. Your ${countWord(p.credits)} ${esc(p.sessionLength === "1 hour" ? "one-hour" : p.sessionLength)} sessions are ready to book whenever you are.`),
    details([
      ["Bundle", esc(p.bundleName)],
      ["Sessions", `${p.credits} &times; ${esc(p.sessionLength)} on Zoom`],
      ["Use by", esc(day(p.expiresAt, tz))],
      ["Paid", esc(money(p.amountCents))],
    ]),
    button(bundleUrl, "Book your first session"),
    para("This link is your bundle page: it shows how many sessions you have left and lets you book, reschedule, or cancel them. Keep this email handy."),
    small(`Sessions can be rescheduled or cancelled up to 24 hours before they start, and the session goes back into your bundle. Sessions cancelled later than that, or not used by ${esc(day(p.expiresAt, tz))}, can't be returned.`),
    para("Looking forward to it,<br>Avery"),
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
    small("If the timing isn't working out, just reply to this email and we'll figure something out."),
    para("Talk soon,<br>Avery"),
  ].join("\n");
  return {
    to: p.email,
    subject: `You have ${left} left to use by ${shortDay(p.expiresAt, tz)}`,
    html: layout({ preheader: `Use by ${day(p.expiresAt, tz)}`, tag: "Session bundle", title: "Sessions expiring", body }),
    text: [`Hi ${firstName(p.name)},`, "", `You have ${left} left in your bundle, to use by ${day(p.expiresAt, tz)}.`, "", `Book a session: ${bundleUrl}`, "", "Talk soon,", "Avery"].join("\n"),
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
    para("Thanks for working with me. You're always welcome back.<br>Avery"),
  ].join("\n");
  return {
    to: p.email,
    subject: `Your bundle is cancelled${p.refundCents > 0 ? `: ${money(p.refundCents)} refund on the way` : ""}`,
    html: layout({ preheader: p.refundCents > 0 ? `Refund of ${money(p.refundCents)} is processing.` : "Your bundle is cancelled.", tag: "Session bundle", title: "Bundle cancelled", body }),
    text: [`Hi ${firstName(p.name)},`, "", `Your ${p.bundleName} has been cancelled.`, "",
      textRows([["Sessions used", String(p.used)], ["Refund", p.refundCents > 0 ? money(p.refundCents) : "None"]]),
      ...(p.refundCents > 0 ? ["", `Your refund of ${money(p.refundCents)} is being processed and may take a few business days to appear.`] : []),
      "", "Avery"].join("\n"),
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
    manageBlock(manageUrl, false),
    para("See you then,<br>Avery"),
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
  if (refund === "offer") return "Since this cancellation came from my side, you can have a full refund or a new time at no charge, whichever you'd rather. Just reply to this email and let me know.";
  return "";
}

export function clientCancelled(b: BookingView, ics: string, bookUrl: string, refund: RefundState = "none", creditReturned = true): Email {
  const tz = b.clientTimeZone;
  const when = `${day(b.start, tz)}, ${timeRange(b, tz)}`;
  const money_ = b.bundleNote
    ? (creditReturned ? "The session has gone back into your bundle, so you can book another time whenever you like."
      : "This session wasn't returned to your bundle. If you have any questions, just reply to this email.")
    : refundLine(b, refund);
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`Your ${esc(b.serviceName.toLowerCase())} on <strong>${esc(when)}</strong> has been cancelled.`),
    money_ ? para(esc(money_)) : "",
    para("The attached update removes it from your calendar. Whenever you're ready, you're welcome to book another time:"),
    button(bookUrl, "Book another time"),
    para("Take care,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Cancelled: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `Your session on ${when} is cancelled.`, tag: tagFor(b), title: "Session cancelled", body }),
    text: [`Hi ${firstName(b.name)},`, "", `Your ${b.serviceName.toLowerCase()} on ${when} has been cancelled.`,
      ...(money_ ? ["", money_] : []),
      "", `Book another time: ${bookUrl}`, "", "Take care,", "Avery"].join("\n"),
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
  if (b.clientTimeZone !== tz) rows.push(["Their zone", esc(`${clock(b.start, b.clientTimeZone)} ${zoneName(b.start, b.clientTimeZone)}`)]);
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

export function adminNotification(b: BookingView, opts: { zoomMissing: boolean; calendarFailed: boolean; notice?: string; title?: string }): Email {
  const tz = AVERY_TZ;
  const warnings = [
    opts.notice ?? "",
    opts.zoomMissing ? "No Zoom meeting was created. Please send the client a link." : "",
    opts.calendarFailed ? "This booking couldn't be added to your Coaching calendar yet. It will retry automatically." : "",
  ].filter(Boolean);
  const body = [warnings.map(warn).join(""), details(adminRows(b)), intakeHtml(b)].join("\n");
  return {
    to: "", // filled in with ADMIN_EMAIL by the caller
    subject: `New booking: ${b.name}, ${b.serviceName} on ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${b.name} booked ${b.serviceName}`, tag: tagFor(b), title: opts.title ?? "New booking", subtitle: b.name, body }),
    text: [
      ...warnings, warnings.length ? "" : "",
      textRows([["Client", b.name], ["Email", b.email], ["Session", b.serviceName], ["When", `${day(b.start, tz)}, ${timeRange(b, tz)}`],
        ["Paid", b.amountCents > 0 ? money(b.amountCents) : "Free"], ["Zoom", b.zoomUrl ?? "Not created"]]), "",
    ].join("\n"),
  };
}

export function adminRescheduled(b: BookingView, previousStart: number, opts: { calendarFailed: boolean }): Email {
  const tz = AVERY_TZ;
  const was = `${day(previousStart, tz)}, ${clock(previousStart, tz)} ${zoneName(previousStart, tz)}`;
  const body = [
    opts.calendarFailed ? warn("Your Coaching calendar couldn't be updated yet. Please move the event by hand.") : "",
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
    : r.refund === "pending" ? `The automatic refund of ${amount} hasn't gone through yet. It keeps retrying, and you'll get an alert if it doesn't.`
    : r.refund === "offer" ? `Not refunded. They were offered a full refund or a new time, whichever they prefer.`
    : "";
  const tag = r.refund === "refunded" ? ` (refunded ${amount})` : r.refund === "pending" ? ` (refund pending ${amount})` : "";
  const leftovers = [
    r.calendarRemoved ? "" : "It couldn't be removed from your Coaching calendar yet. It keeps retrying; if you still see it, delete it by hand. It isn't happening.",
    r.zoomRemoved ? "" : "The Zoom meeting couldn't be deleted yet. It keeps retrying.",
  ].filter(Boolean);
  const body = [
    r.refund === "pending" || r.refund === "offer" ? warn(refundNote) : refundNote ? small(refundNote) : "",
    stripePaymentUrl && r.refund !== "none" ? button(stripePaymentUrl, r.refund === "refunded" ? "View payment in Stripe" : `Refund ${amount} in Stripe`) : "",
    ...leftovers.map(warn),
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
      ...leftovers.flatMap((l) => [l, ""]),
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

export function attentionAlert(problems: string[]): Email {
  const body = [
    para("The booking system ran into something it couldn't fix on its own:"),
    `<ul style="margin:0 0 18px;padding-left:20px;font:14px/1.6 ${FONT};color:#2c3138;">${problems.map((p) => `<li style="margin:0 0 6px;">${esc(p)}</li>`).join("")}</ul>`,
    small("Emails and calendar updates retry automatically every few minutes, so some of these may clear on their own. You'll get at most one of these alerts an hour."),
  ].join("\n");
  return {
    to: "",
    subject: `Booking system: ${problems.length} thing${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} attention`,
    html: layout({ preheader: problems[0] ?? "", tag: "Heads up", title: "Needs attention", body }),
    text: ["The booking system ran into something it couldn't fix on its own:", "", ...problems.map((p) => `- ${p}`)].join("\n"),
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
    html: layout({ preheader: `Finish booking your session for ${when}`, tag: "Almost there", title: "Finish your booking", body }),
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
    html: layout({ preheader: `Finish buying your ${p.bundleName}`, tag: "Almost there", title: "Finish your booking", body }),
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
];
