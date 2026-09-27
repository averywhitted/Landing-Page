// Email templates. Plain HTML with inline styles (what email apps support),
// matching averywhitted.com: heavy uppercase heading, lime tag, white card,
// blue button. Copy rule: no em dashes.

import type { Email } from "./email";

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
function timeRange(b: BookingView, tz: string) {
  return `${clock(b.start, tz)} to ${clock(b.end, tz)} ${zoneName(b.start, tz)}`;
}

// ── Shared pieces ──

const FONT = "Helvetica,Arial,sans-serif";
const MONO = "Menlo,Consolas,'Courier New',monospace";

function layout(p: { preheader: string; tag: string; title: string; body: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.title)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(p.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding:0 4px 18px;font:900 24px/1 'Arial Black',${FONT};letter-spacing:0.5px;text-transform:uppercase;color:#0e1116;">Avery Whitted</td></tr>
  <tr><td style="background:#ffffff;border:1px solid #e1e3e8;border-radius:18px;padding:32px 30px;">
    <span style="display:inline-block;padding:5px 9px 4px;border-radius:4px;background:#e3f24d;color:#14161a;font:700 11px/1.2 ${FONT};letter-spacing:1.1px;text-transform:uppercase;">${esc(p.tag)}</span>
    <h1 style="margin:16px 0 18px;font:900 26px/1.05 'Arial Black',${FONT};text-transform:uppercase;color:#0e1116;">${esc(p.title)}</h1>
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

function details(rows: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border-radius:14px;background:#eceef2;">
${rows.map(([k, v], i) => `<tr><td style="padding:${i ? 6 : 16}px 16px ${i === rows.length - 1 ? 16 : 6}px;width:34%;vertical-align:top;font:700 11px/1.5 ${FONT};letter-spacing:1px;text-transform:uppercase;color:#6b727b;">${esc(k)}</td><td style="padding:${i ? 6 : 16}px 16px ${i === rows.length - 1 ? 16 : 6}px 0;vertical-align:top;font:14px/1.5 ${MONO};color:#0e1116;">${v}</td></tr>`).join("\n")}
</table>`;
}

const textRows = (rows: [string, string][]) => rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, "")}`).join("\n");

// ── Client: booking confirmed ──

export function clientConfirmation(b: BookingView, ics: string): Email {
  const tz = b.clientTimeZone;
  const zoom = b.zoomUrl
    ? `<a href="${esc(b.zoomUrl)}" style="color:#1f47f5;">Join on Zoom</a>`
    : "Avery will send your Zoom link before the session.";
  const rows: [string, string][] = [
    ["Session", esc(b.serviceName)],
    ["Date", esc(day(b.start, tz))],
    ["Time", esc(timeRange(b, tz))],
    ["Where", zoom],
  ];
  if (b.amountCents > 0) rows.push(["Paid", esc(money(b.amountCents))]);

  const intro = b.kind === "intro";
  const body = [
    para(`Hi ${esc(firstName(b.name))},`),
    para(intro
      ? "Thanks for booking an intro call. I'm looking forward to meeting you and hearing what you're working on."
      : "You're all set. I'm looking forward to working with you."),
    details(rows),
    b.zoomUrl ? button(b.zoomUrl, "Join on Zoom") : "",
    para("A calendar invite is attached, so you can add it to your calendar in one tap."),
    small("Need to reschedule or cancel? Just reply to this email at least 24 hours before your session."
      + (b.amountCents > 0 ? " Refunds for cancellations may take a few business days to appear." : "")),
    para("See you soon,<br>Avery"),
  ].join("\n");

  return {
    to: b.email,
    subject: `You're booked: ${b.serviceName} on ${shortDay(b.start, tz)}`,
    html: layout({ preheader: `${day(b.start, tz)}, ${timeRange(b, tz)}`, tag: intro ? "Intro call" : "Private coaching", title: "You're booked", body }),
    text: [
      `Hi ${firstName(b.name)},`, "",
      intro ? "Thanks for booking an intro call." : "You're all set.", "",
      textRows([["Session", b.serviceName], ["Date", day(b.start, tz)], ["Time", timeRange(b, tz)], ["Zoom", b.zoomUrl ?? "Avery will send your Zoom link before the session."],
        ...(b.amountCents > 0 ? [["Paid", money(b.amountCents)] as [string, string]] : [])]), "",
      "Need to reschedule or cancel? Reply to this email at least 24 hours before your session.", "",
      "See you soon,", "Avery",
    ].join("\n"),
    attachments: [{ filename: "session.ics", content: ics, contentType: "text/calendar; method=REQUEST; charset=UTF-8" }],
  };
}

// ── Avery: new booking notice ──

export function adminNotification(b: BookingView, opts: { zoomMissing: boolean; calendarFailed: boolean; notice?: string }): Email {
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
  const intake: [string, string | undefined][] = [
    [b.kind === "intro" ? "Wants to talk about" : "Main goal", b.goal],
    ["Material", b.material],
    ["Link", b.link],
    ["Anything else", b.notes],
  ];
  const warnings = [
    opts.notice ?? "",
    opts.zoomMissing ? "No Zoom meeting was created. Please send the client a link." : "",
    opts.calendarFailed ? "This booking couldn't be added to your Coaching calendar yet. It will retry automatically." : "",
  ].filter(Boolean);

  const body = [
    warnings.map((w) => `<p style="margin:0 0 14px;padding:12px 14px;border-radius:12px;background:#fff4e5;font:600 14px/1.5 ${FONT};color:#7a4b00;">${esc(w)}</p>`).join(""),
    details(rows),
    intake.filter(([, v]) => v && v.trim()).map(([k, v]) =>
      `<p style="margin:0 0 4px;font:700 11px/1.5 ${FONT};letter-spacing:1px;text-transform:uppercase;color:#6b727b;">${esc(k)}</p>
       <p style="margin:0 0 16px;font:14px/1.6 ${MONO};color:#0e1116;white-space:pre-wrap;">${k === "Link" ? `<a href="${esc(v!)}" style="color:#1f47f5;">${esc(v!)}</a>` : esc(v!)}</p>`).join("\n"),
  ].join("\n");

  return {
    to: "", // filled in with ADMIN_EMAIL by the caller
    subject: `New booking: ${b.name}, ${b.serviceName} on ${shortDay(b.start, tz)} at ${clock(b.start, tz)}`,
    html: layout({ preheader: `${b.name} booked ${b.serviceName}`, tag: "New booking", title: b.name, body }),
    text: [
      ...warnings, warnings.length ? "" : "",
      textRows([["Client", b.name], ["Email", b.email], ["Session", b.serviceName], ["When", `${day(b.start, tz)}, ${timeRange(b, tz)}`],
        ["Paid", b.amountCents > 0 ? money(b.amountCents) : "Free"], ["Zoom", b.zoomUrl ?? "Not created"]]), "",
      ...intake.filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}:\n${v}\n`),
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

// ── Client + Avery: paid after the hold expired and the time was taken ──

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
