// Email templates. Plain HTML with inline styles (what email apps support),
// matching averywhitted.com: Horizon wordmark and headings, lime tag, white
// card, blue button. Copy rule: no em dashes.

import type { Email } from "./email";
import { HEADING_IMAGES } from "./email-headings";

export type BookingView = {
  id: string;
  kind: "intro" | "single" | "bundle";
  serviceName: string;       // "1 hour session", "Intro call"
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
  <tr><td style="padding:0 4px 18px;"><img src="${ASSETS}/wordmark.png" width="321" height="22" alt="AVERY WHITTED" style="display:block;border:0;outline:none;width:321px;max-width:100%;height:auto;font:900 22px/1 'Arial Black',${FONT};color:#0e1116;"></td></tr>
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
const tagFor = (b: BookingView) => (b.kind === "intro" ? "Intro call" : "Private coaching");
const icsAttachment = (ics: string, method: "REQUEST" | "CANCEL") =>
  [{ filename: method === "CANCEL" ? "cancelled.ics" : "session.ics", content: ics, contentType: `text/calendar; method=${method}; charset=UTF-8` }];

function sessionRows(b: BookingView, tz: string, withPaid: boolean): [string, string][] {
  const rows: [string, string][] = [
    ["Session", esc(b.serviceName)],
    ["Date", esc(day(b.start, tz))],
    ["Time", esc(timeRange(b, tz))],
    ["Where", b.zoomUrl ? `<a href="${esc(b.zoomUrl)}" style="color:#1f47f5;">Join on Zoom</a>` : "Zoom (link to follow)"],
  ];
  if (withPaid && b.amountCents > 0) rows.push(["Paid", esc(money(b.amountCents))]);
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
      ? "Thanks for booking an intro call. I'm looking forward to meeting you and hearing what you're working on."
      : "You're all set. I'm looking forward to working with you."),
    details(sessionRows(b, tz, true)),
    b.zoomUrl ? button(b.zoomUrl, "Join on Zoom") : para("I'll send your Zoom link before the session."),
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
      intro ? "Thanks for booking an intro call." : "You're all set.", "",
      textRows([["Session", b.serviceName], ["Date", day(b.start, tz)], ["Time", timeRange(b, tz)], ["Zoom", b.zoomUrl ?? "Link to follow"],
        ...(b.amountCents > 0 ? [["Paid", money(b.amountCents)] as [string, string]] : [])]), "",
      `Need to reschedule or cancel? You can do it up to 24 hours before your session: ${manageUrl}`, "",
      "See you soon,", "Avery",
    ].join("\n"),
    attachments: icsAttachment(ics, "REQUEST"),
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
    b.zoomUrl ? button(b.zoomUrl, "Join on Zoom") : "",
    para("The attached invite updates the event already in your calendar."),
    manageBlock(manageUrl, false),
    para("See you then,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Rescheduled: ${b.serviceName} now on ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `New time: ${day(b.start, tz)}, ${timeRange(b, tz)}`, tag: tagFor(b), title: "Session rescheduled", body }),
    text: [`Hi ${firstName(b.name)},`, "", "Your session has been moved.", "",
      textRows([["Session", b.serviceName], ["New date", day(b.start, tz)], ["New time", timeRange(b, tz)], ["Was", was], ["Zoom", b.zoomUrl ?? "Link to follow"]]), "",
      `Reschedule or cancel: ${manageUrl}`, "", "See you then,", "Avery"].join("\n"),
    attachments: icsAttachment(ics, "REQUEST"),
  };
}

// ── Client: session cancelled ──

export function clientCancelled(b: BookingView, ics: string, bookUrl: string): Email {
  const tz = b.clientTimeZone;
  const when = `${day(b.start, tz)}, ${timeRange(b, tz)}`;
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(`Your ${esc(b.serviceName.toLowerCase())} on <strong>${esc(when)}</strong> has been cancelled.`),
    b.amountCents > 0 ? para(`You'll be refunded in full (${esc(money(b.amountCents))}). Refunds may take a few business days to appear.`) : "",
    para("The attached update removes it from your calendar. Whenever you're ready, you're welcome to book another time:"),
    button(bookUrl, "Book another time"),
    para("Take care,<br>Avery"),
  ].join("\n");
  return {
    to: b.email,
    subject: `Cancelled: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `Your session on ${when} is cancelled.`, tag: tagFor(b), title: "Session cancelled", body }),
    text: [`Hi ${firstName(b.name)},`, "", `Your ${b.serviceName.toLowerCase()} on ${when} has been cancelled.`,
      ...(b.amountCents > 0 ? ["", `You'll be refunded in full (${money(b.amountCents)}). Refunds may take a few business days to appear.`] : []),
      "", `Book another time: ${bookUrl}`, "", "Take care,", "Avery"].join("\n"),
    attachments: icsAttachment(ics, "CANCEL"),
  };
}

// ── Avery: new booking, rescheduled, cancelled, auto-refunded ──

function adminRows(b: BookingView): [string, string][] {
  const tz = AVERY_TZ;
  const rows: [string, string][] = [
    ["Client", esc(b.name) + (b.pronouns ? ` (${esc(b.pronouns)})` : "")],
    ["Email", `<a href="mailto:${esc(b.email)}" style="color:#1f47f5;">${esc(b.email)}</a>`],
    ["Session", esc(b.serviceName)],
    ["When", `${esc(day(b.start, tz))}<br>${esc(timeRange(b, tz))}`],
    ["Paid", b.amountCents > 0 ? esc(money(b.amountCents)) : "Free"],
    ["Zoom", b.zoomUrl ? `<a href="${esc(b.zoomUrl)}" style="color:#1f47f5;">${esc(b.zoomUrl)}</a>` : "Not created"],
  ];
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

export function adminCancelled(b: BookingView, stripePaymentUrl: string | null): Email {
  const tz = AVERY_TZ;
  const needsRefund = b.amountCents > 0;
  const body = [
    needsRefund ? warn(`Refund due: ${money(b.amountCents)}. They cancelled at least 24 hours ahead, so they were told they'll be refunded in full.`) : "",
    needsRefund && stripePaymentUrl ? button(stripePaymentUrl, `Refund ${money(b.amountCents)} in Stripe`) : "",
    details(adminRows(b)),
    small("The event has been removed from your Coaching calendar and the Zoom meeting deleted. The time is open for booking again."),
  ].join("\n");
  return {
    to: "",
    subject: `Cancelled: ${b.name}, ${b.serviceName} on ${shortDay(b.start, tz)}${needsRefund ? ` (refund ${money(b.amountCents)})` : ""}`,
    html: layout({ preheader: `${b.name} cancelled${needsRefund ? `: refund ${money(b.amountCents)}` : ""}`, tag: tagFor(b), title: "Booking cancelled", subtitle: b.name, body }),
    text: [
      needsRefund ? `Refund due: ${money(b.amountCents)}${stripePaymentUrl ? `\n${stripePaymentUrl}` : ""}\n` : "",
      textRows([["Client", b.name], ["Session", b.serviceName], ["Was", `${day(b.start, tz)}, ${timeRange(b, tz)}`]]),
    ].join("\n"),
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
];
