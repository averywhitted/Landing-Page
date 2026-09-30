// Renders every email (and its main variations) with sample details, as a
// gallery for reviewing copy and design.
//   npm run preview-emails   ->  booking/.email-previews/index.html (not committed)
// Then open http://localhost:8743/booking/.email-previews/ with the site running.

import { mkdirSync, writeFileSync } from "node:fs";
import * as T from "../src/templates";
import { buildIcs } from "../src/ics";

const H = 3600000;
const D = 24 * H;
const start = Date.UTC(2026, 9, 1, 15, 0);   // Thu Oct 1, 11:00am Eastern
const sample: T.BookingView = {
  id: "sample", kind: "single", serviceName: "1 hour session", durationMinutes: 60, start, end: start + H,
  clientTimeZone: "America/Los_Angeles", amountCents: 13000, name: "Jamie Rivera", email: "jamie@example.com", pronouns: "they/them",
  goal: "Callback on Friday for a guest star role. I want to make stronger choices in the second scene.",
  material: "Two scenes from the sides (attached in the link).", link: "https://example.com/sides.pdf",
  notes: "I tend to rush when I'm nervous.", zoomUrl: "https://us06web.zoom.us/j/81234567890?pwd=example",
};
const intro: T.BookingView = { ...sample, kind: "intro", serviceName: "Intro chat", durationMinutes: 15, end: start + 15 * 60000, amountCents: 0, material: "", link: "", goal: "Getting back into auditioning after a few years off." };
const booked: T.BookingView = { ...sample, amountCents: 0, dueCents: 9000, payBy: start - D, message: "Bring the Chekhov sides we talked about. We'll start with the second scene." };
const bundle: T.BundleView = {
  name: "Jamie Rivera", email: "jamie@example.com", pronouns: "they/them", credits: 4, remaining: 4, sessionLength: "1 hour",
  expiresAt: start + 60 * D, clientTimeZone: "America/Los_Angeles", amountCents: 44000, bundleName: "4 session bundle",
  goal: "Book more guest star roles this pilot season.",
};
const ics = buildIcs({ uid: "sample@averywhitted.com", sequence: 0, start, end: sample.end, summary: "Private coaching with Avery Whitted" });
const manage = "https://averywhitted.com/book/manage/?b=sample&t=sample";
const pay = `${manage}&pay=1`;
const book = "https://averywhitted.com/book/?service=coaching-60";
const bundlePage = "https://averywhitted.com/book/package/?p=sample&t=sample";
const stripe = "https://dashboard.stripe.com/payments/pi_sample";
const earlier = start - 2 * D;
const cancelView = { ...bundle, remaining: 2, used: 2, refundCents: 18000, cancelledSessions: [start + 7 * D], keptSessions: [] };
const skip = { name: "Jamie Rivera", email: "jamie@example.com", timeZone: "America/Los_Angeles", serviceName: "1 hour session", when: start, next: start + 7 * D, reason: "taken" as const, everyWeeks: 1, bookUrl: book, continues: true };
const series = { name: "Jamie Rivera", email: "jamie@example.com", everyWeeks: 1, bookUrl: book };

type Entry = { title: string; who: "Student" | "You"; when: string; email: { subject: string; html: string; text: string } };
const groups: [string, Entry[]][] = [
  ["Booking a session", [
    { who: "Student", title: "Booked and paid", when: "A student books and pays on the site.", email: T.clientConfirmation(sample, ics, manage) },
    { who: "Student", title: "Booked, Zoom link to follow", when: "Same, if the Zoom meeting couldn't be created yet.", email: T.clientConfirmation({ ...sample, zoomUrl: null }, ics, manage) },
    { who: "Student", title: "Intro chat booked", when: "A free intro chat is booked.", email: T.clientConfirmation(intro, ics, manage) },
    { who: "Student", title: "Booked, repeating every week", when: "A student books a session that repeats.", email: T.clientConfirmation({ ...sample, repeatEvery: 1 }, ics, manage) },
    { who: "Student", title: "Bundle session booked", when: "A session is booked from a bundle.", email: T.clientConfirmation({ ...sample, amountCents: 0, bundleNote: "Bundle session (3 sessions left)" }, ics, manage) },
    { who: "Student", title: "Finish your booking", when: "They started checkout but didn't pay (at most once a week).", email: T.checkoutReminder(sample, book) },
    { who: "Student", title: "Day-before reminder", when: "About 24 hours before a session.", email: T.sessionReminder(sample, start - 20 * H) },
    { who: "Student", title: "Day-before reminder, still unpaid", when: "Same, for a session they haven't paid for (no Zoom link yet).", email: T.sessionReminder({ ...booked }, start - 20 * H) },
    { who: "Student", title: "Paid after the time was taken", when: "They paid after their hold ran out and someone else booked the time.", email: T.slotTakenRefund(sample, book) },
  ]],
  ["Changes and cancellations", [
    { who: "Student", title: "Rescheduled", when: "A session is moved (by them or by you).", email: T.clientRescheduled(sample, earlier, ics, manage) },
    { who: "Student", title: "Cancelled, refunded", when: "They cancel a paid session 24+ hours ahead.", email: T.clientCancelled(sample, ics, "https://averywhitted.com/book/", "refunded") },
    { who: "Student", title: "Cancelled by you, refund or new time", when: "You cancel and don't refund straight away.", email: T.clientCancelled(sample, ics, "https://averywhitted.com/book/", "offer") },
    { who: "Student", title: "Cancelled, free session", when: "An intro chat or free session is cancelled.", email: T.clientCancelled(intro, ics, "https://averywhitted.com/book/", "none") },
    { who: "Student", title: "Bundle session cancelled, returned", when: "A bundle session is cancelled in time.", email: T.clientCancelled({ ...sample, bundleNote: "Bundle session" }, ics, bundlePage, "none", true) },
    { who: "Student", title: "Bundle session cancelled, not returned", when: "You cancel a bundle session without returning it.", email: T.clientCancelled({ ...sample, bundleNote: "Bundle session" }, ics, bundlePage, "none", false) },
  ]],
  ["Sessions you book, and payments", [
    { who: "Student", title: "Invite, payment due by a deadline", when: "You book a student, with a pay-by deadline.", email: T.adminInvite(booked, ics, manage, pay) },
    { who: "Student", title: "Invite, pay before the session", when: "You book a student, no deadline.", email: T.adminInvite({ ...booked, payBy: null, message: null }, ics, manage, pay) },
    { who: "Student", title: "Invite, free or bundle credit", when: "You book a free session or use their bundle.", email: T.adminInvite({ ...sample, amountCents: 0, dueCents: 0 }, ics, manage, null) },
    { who: "Student", title: "Invite, group session", when: "You book a group session.", email: T.adminInvite({ ...booked, group: true }, ics, manage, pay) },
    { who: "Student", title: "Payment reminder", when: "Automatic (once) or sent by you.", email: T.paymentReminder(booked, pay, manage) },
    { who: "Student", title: "Payment received", when: "They pay; includes the Zoom link.", email: T.paymentReceived({ ...sample, amountCents: 9000 }, manage, ics) },
    { who: "Student", title: "Released, not paid in time", when: "The pay-by deadline passes unpaid.", email: T.unpaidReleased({ ...booked }, ics) },
    { who: "Student", title: "Payment request", when: "You request payment for one of their sessions.", email: T.paymentRequest(sample, { amountCents: 4000, note: "For the extra half hour we went over on Thursday.", reminder: false }, `${manage}&payreq=sample`) },
    { who: "Student", title: "Payment request reminder", when: "You click Remind on an open request.", email: T.paymentRequest(sample, { amountCents: 4000, note: null, reminder: true }, `${manage}&payreq=sample`) },
    { who: "Student", title: "Payment request paid", when: "They pay a payment request.", email: T.requestPaid(sample, 4000, manage) },
    { who: "Student", title: "Paid after it was cancelled", when: "A payment arrives after the session was cancelled; refunded automatically.", email: T.paidAfterCancel({ ...sample, amountCents: 9000 }) },
  ]],
  ["Repeating sessions", [
    { who: "Student", title: "Next session booked, payment due", when: "The next session in a series is booked automatically.", email: T.adminInvite({ ...booked, message: null, repeatEvery: 1, repeatNext: true }, ics, manage, pay) },
    { who: "Student", title: "Session skipped", when: "The usual time isn't available that week.", email: T.seriesSkipped(skip) },
    { who: "Student", title: "Repeats stopped (they asked)", when: "They stop repeating.", email: T.seriesStopped({ ...series, by: "client" }) },
    { who: "Student", title: "Repeats stopped (by you)", when: "You stop repeating.", email: T.seriesStopped({ ...series, by: "admin" }) },
    { who: "Student", title: "Repeats stopped (unpaid)", when: "Two unpaid sessions in a row.", email: T.seriesStopped({ ...series, by: "unpaid" }) },
  ]],
  ["Bundles", [
    { who: "Student", title: "Bundle ready to book", when: "They buy a bundle.", email: T.bundlePurchased(bundle, bundlePage) },
    { who: "Student", title: "Finish buying your bundle", when: "They started buying a bundle but didn't pay.", email: T.bundleCheckoutReminder(bundle, book) },
    { who: "Student", title: "Sessions expiring", when: "A week before the use-by date, if sessions are left.", email: T.bundleExpiring({ ...bundle, remaining: 2 }, bundlePage) },
    { who: "Student", title: "Session added", when: "You add a session and choose to tell them.", email: T.bundleUpdated({ ...bundle, credits: 5, remaining: 5 }, "added", "A makeup for the session I had to move.", bundlePage) },
    { who: "Student", title: "Session removed", when: "You remove a session and choose to tell them.", email: T.bundleUpdated({ ...bundle, credits: 3, remaining: 3 }, "removed", "", bundlePage) },
    { who: "Student", title: "Use-by date extended", when: "You extend a bundle and choose to tell them.", email: T.bundleUpdated({ ...bundle, expiresAt: start + 74 * D }, "extended", "", bundlePage) },
    { who: "Student", title: "Bundle cancelled (by them)", when: "They cancel their bundle.", email: T.bundleCancelled(cancelView) },
    { who: "Student", title: "Bundle cancelled (by you)", when: "You cancel it for them.", email: T.bundleCancelled({ ...cancelView, byAvery: true, refundCents: 30000 }) },
  ]],
  ["Refunds", [
    { who: "Student", title: "Refund issued", when: "You refund all or part of something by hand.", email: T.refundIssued({ name: "Jamie Rivera", email: "jamie@example.com", what: "your 1 hour session on Thursday, October 1", amountCents: 5000, message: "Sorry about the audio trouble in our session." }) },
    { who: "Student", title: "Refund request declined", when: "You decline a refund request.", email: T.refundDeclined({ name: "Jamie Rivera", email: "jamie@example.com", what: "your 1 hour session on Thursday, October 1", message: "The session ran its full time, so I'm not able to refund it." }) },
  ]],
  ["To you: bookings", [
    { who: "You", title: "New booking", when: "A student books.", email: T.adminNotification(sample, { zoomMissing: false, calendarFailed: false }) },
    { who: "You", title: "New booking, with problems", when: "Zoom or the calendar didn't work.", email: T.adminNotification({ ...sample, zoomUrl: null }, { zoomMissing: true, calendarFailed: true }) },
    { who: "You", title: "Rescheduled", when: "A student moves a session.", email: T.adminRescheduled(sample, earlier, { calendarFailed: false }) },
    { who: "You", title: "Cancelled, refunded", when: "A student cancels in time.", email: T.adminCancelled(sample, stripe, { refund: "refunded", calendarRemoved: true, zoomRemoved: true }) },
    { who: "You", title: "Cancelled, refund pending", when: "Same, but Stripe hasn't accepted the refund yet.", email: T.adminCancelled(sample, stripe, { refund: "pending", calendarRemoved: true, zoomRemoved: true }) },
    { who: "You", title: "Cancelled, cleanup failed", when: "The calendar event or Zoom meeting couldn't be removed.", email: T.adminCancelled(intro, null, { refund: "none", calendarRemoved: false, zoomRemoved: false }) },
    { who: "You", title: "They chose a new time", when: "After you cancelled a paid session, they picked a new time (no charge).", email: T.adminNotification(sample, { zoomMissing: false, calendarFailed: false, title: "New booking", notice: "Jamie Rivera chose a new time instead of a refund for the session you cancelled. No new payment: it uses what they already paid." }) },
    { who: "You", title: "They chose a refund", when: "After you cancelled a paid session, they chose a full refund.", email: T.adminNotification(sample, { zoomMissing: false, calendarFailed: false, title: "Refund issued", notice: "Jamie Rivera chose a full refund for the session you cancelled. $130 was refunded automatically." }) },
    { who: "You", title: "Auto-refunded", when: "Someone paid after their time was taken.", email: T.adminNotification(sample, { zoomMissing: false, calendarFailed: false, title: "Auto-refunded", notice: "Not booked: this client paid after their hold ran out and someone else had taken the time. They were refunded in full automatically and asked to pick a new time. Nothing was added to your calendar." }) },
  ]],
  ["To you: payments, bundles, repeats", [
    { who: "You", title: "Payment received", when: "A student pays for a session you booked.", email: T.adminPaymentReceived({ ...sample, amountCents: 9000 }) },
    { who: "You", title: "Released, unpaid", when: "A pay-by deadline passes.", email: T.adminUnpaidReleased({ ...booked }, false) },
    { who: "You", title: "Released from a group, unpaid", when: "Same, for one student in a group.", email: T.adminUnpaidReleased({ ...booked, group: true }, true) },
    { who: "You", title: "Bundle bought", when: "A student buys a bundle.", email: T.adminBundlePurchased(bundle) },
    { who: "You", title: "Bundle cancelled", when: "A student cancels their bundle.", email: T.adminBundleCancelled(cancelView, stripe) },
    { who: "You", title: "Refund request", when: "A student asks for a refund.", email: T.adminRefundRequest({ name: "Jamie Rivera", email: "jamie@example.com", what: "1 hour session on Thursday, October 1", paidCents: 13000, leftCents: 13000, message: "Zoom kept dropping for me." }) },
    { who: "You", title: "Repeat skipped", when: "A repeating session's usual time wasn't free.", email: T.adminSeriesSkipped(skip) },
    { who: "You", title: "Repeat clash", when: "A repeating session clashes with your calendar or a day off; held until you decide.", email: T.adminSeriesClash({ name: "Jamie Rivera", serviceName: "1 hour session", when: start + 7 * D, clash: "calendar", wentAhead: false }) },
    { who: "You", title: "Repeat went ahead", when: "You didn't decide by 2 days before.", email: T.adminSeriesClash({ name: "Jamie Rivera", serviceName: "1 hour session", when: start + 7 * D, clash: "day_off", wentAhead: true }) },
    { who: "You", title: "Repeats stopped", when: "A student stopped, or two went unpaid.", email: T.adminSeriesStopped({ ...series, by: "unpaid" }) },
  ]],
  ["Check-in emails (sent from a student's profile)", (() => {
    const base = { name: "Jamie Rivera", email: "jamie@example.com", bookUrl: book, introUrl: `${book.split("?")[0]}?service=intro-15`, unsubscribeUrl: "https://averywhitted.com/book/unsubscribe/?c=sample&t=sample" };
    const credits = { n: 2, until: start + 30 * D, url: bundlePage, several: false };
    const make = (kind: T.NudgeKind, cr?: typeof credits) => T.studentNudge({ ...base, kind, credits: cr, ...T.nudgeDraft(kind, base.name, cr) });
    return [
      { who: "Student", title: "Gentle check-in", when: "You send it (or schedule it) to someone quiet for a while. You can edit it first.", email: make("checkin") },
      { who: "Student", title: "Something coming up?", when: "Same.", email: make("coming_up") },
      { who: "Student", title: "Free intro chat", when: "Same; suggested after 120+ days.", email: make("intro") },
      { who: "Student", title: "Unused credits", when: "Same; suggested when they have bundle sessions left.", email: make("credits", credits) },
      { who: "Student", title: "Unused credits (several bundles)", when: "Same, if they have more than one bundle.", email: make("credits", { ...credits, n: 3, several: true }) },
      { who: "Student", title: "Written by you", when: "You write your own from scratch.", email: T.studentNudge({ ...base, kind: "custom", subject: "Pilot season", body: "Hi Jamie,\n\nPilot season is close and I have a few evenings open. {button}\n\nBest,\nAvery" }) },
    ] as Entry[];
  })()],
  ["To you: system alerts", [
    { who: "You", title: "Something needs attention", when: "Failures that didn't fix themselves (at most hourly).", email: T.attentionAlert(["1 \"client confirmation\" email failed to send.", "Jamie Rivera's session on Thu, Oct 1, 11:00 AM isn't in your Coaching calendar.", { text: "The automatic refund of $130.00 to Jamie Rivera hasn't gone through. It will keep retrying; you can also refund it in Stripe.", fix: ["Resolve in Stripe", stripe] }]) },
    { who: "You", title: "Can't reach iCloud", when: "Your calendars have been unreachable for 15 minutes.", email: T.icloudStatus(false, "iCloud PROPFIND failed with status 401") },
    { who: "You", title: "iCloud password changed", when: "The password is changed (or reset) from Settings.", email: T.icloudPasswordChanged({ by: "avery@averywhitted.com", at: start, reverted: false }) },
    { who: "You", title: "iCloud working again", when: "After the alert above, once it's fixed.", email: T.icloudStatus(true, "") },
  ]],
];

const out = new URL("../.email-previews/", import.meta.url);
mkdirSync(out, { recursive: true });
const local = (html: string) => html
  .replace(/https:\/\/book\.averywhitted\.com\/email\/wordmark\.png(\?v=\d+)?/g, "/booking/assets/email-wordmark.png")
  .replace(/https:\/\/book\.averywhitted\.com\/email\/h\//g, "/booking/assets/headings/");

let n = 0;
const items = groups.map(([name, entries]) => ({
  name,
  entries: entries.map((e) => {
    n++;
    if (/—/.test(e.email.html + e.email.subject + e.email.text)) throw new Error(`#${n} ${e.title} contains an em dash`);
    const preheader = (e.email.html.match(/<span style="display:none[^>]*>([^<]*)<\/span>/)?.[1] ?? "")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return { n, title: e.title, who: e.who, when: e.when, subject: e.email.subject, preheader, html: local(e.email.html), text: e.email.text };
  }),
}));

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Booking emails</title>
<style>
  :root { --ink:#0e1116; --muted:#5b616b; --line:#e1e3e8; --a:#1f47f5; --lime:#e3f24d; --bg:#f6f7f9; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 -apple-system, system-ui, sans-serif; color:var(--ink); background:var(--bg); display:grid; grid-template-columns:300px 1fr; height:100vh; }
  nav { overflow:auto; border-right:1px solid var(--line); background:#fff; padding:16px 12px 40px; }
  nav h1 { font-size:15px; margin:0 6px 4px; }
  nav .count { margin:0 6px 12px; color:var(--muted); font-size:12px; }
  nav input { width:100%; padding:8px 10px; margin:0 0 10px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  nav h2 { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:16px 6px 6px; }
  nav button { display:grid; grid-template-columns:28px 1fr auto; gap:6px; align-items:baseline; width:100%; padding:7px 8px; border:0; border-radius:8px; background:none; font:inherit; text-align:left; cursor:pointer; color:var(--ink); }
  nav button:hover { background:#eef1fd; }
  nav button[aria-current="true"] { background:var(--a); color:#fff; }
  nav .num { font:600 11px ui-monospace, Menlo, monospace; opacity:.7; }
  nav .who { font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; padding:1px 5px; border-radius:4px; background:var(--bg); color:var(--muted); }
  nav button[aria-current="true"] .who { background:rgba(255,255,255,.2); color:#fff; }
  main { display:flex; flex-direction:column; min-width:0; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); background:#fff; }
  header .top { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; justify-content:space-between; }
  header h2 { margin:0; font-size:17px; }
  header h2 .num { color:var(--muted); font-weight:500; margin-right:6px; }
  .meta { display:grid; grid-template-columns:auto 1fr; gap:3px 12px; margin:10px 0 0; font-size:13px; }
  .meta dt { color:var(--muted); }
  .meta dd { margin:0; }
  .controls { display:flex; gap:6px; flex-wrap:wrap; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:2px; }
  .seg button, .nav-btn { border:0; background:none; padding:5px 12px; border-radius:999px; font:600 12px system-ui; cursor:pointer; color:var(--muted); }
  .seg button[aria-pressed="true"] { background:var(--ink); color:#fff; }
  .nav-btn { border:1px solid var(--line); color:var(--ink); }
  .stage { flex:1; overflow:auto; padding:24px; display:flex; justify-content:center; }
  iframe { border:1px solid var(--line); border-radius:12px; background:#fff; width:100%; max-width:760px; height:100%; min-height:600px; }
  iframe.phone { max-width:390px; }
  pre { margin:0; width:100%; max-width:760px; padding:20px; background:#fff; border:1px solid var(--line); border-radius:12px; white-space:pre-wrap; font:13px/1.55 ui-monospace, Menlo, monospace; }
  @media (max-width:800px) { body { grid-template-columns:1fr; height:auto; } nav { max-height:40vh; border-right:0; border-bottom:1px solid var(--line); } }
</style></head>
<body>
<nav aria-label="Emails">
  <h1>Booking emails</h1>
  <p class="count">${n} emails, with sample details. Use the number when you send notes (for example, "#12").</p>
  <input type="search" id="q" placeholder="Filter by title or subject" aria-label="Filter emails">
  <div id="list"></div>
</nav>
<main>
  <header>
    <div class="top">
      <h2 id="title"></h2>
      <div class="controls">
        <div class="seg" role="group" aria-label="Width"><button data-w="desktop" aria-pressed="true">Desktop</button><button data-w="phone" aria-pressed="false">Phone</button></div>
        <div class="seg" role="group" aria-label="Version"><button data-v="html" aria-pressed="true">Email</button><button data-v="text" aria-pressed="false">Plain text</button></div>
        <button class="nav-btn" id="prev" title="Previous (left arrow)">&larr;</button><button class="nav-btn" id="next" title="Next (right arrow)">&rarr;</button>
      </div>
    </div>
    <dl class="meta"><dt>To</dt><dd id="to"></dd><dt>Sent when</dt><dd id="when"></dd><dt>Subject</dt><dd id="subject"></dd><dt>Preview line</dt><dd id="pre"></dd></dl>
  </header>
  <div class="stage" id="stage"></div>
</main>
<script>
  const GROUPS = ${JSON.stringify(items).replace(/</g, "\\u003c")};
  const ALL = GROUPS.flatMap((g) => g.entries);
  let cur = Number(location.hash.slice(1)) || 1, width = "desktop", version = "html";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function list() {
    const q = document.getElementById("q").value.toLowerCase();
    document.getElementById("list").innerHTML = GROUPS.map((g) => {
      const es = g.entries.filter((e) => !q || (e.title + " " + e.subject).toLowerCase().includes(q));
      return es.length ? "<h2>" + esc(g.name) + "</h2>" + es.map((e) => '<button data-n="' + e.n + '" aria-current="' + (e.n === cur) + '"><span class="num">#' + e.n + '</span><span>' + esc(e.title) + '</span><span class="who">' + e.who + "</span></button>").join("") : "";
    }).join("");
  }
  function show() {
    const e = ALL.find((x) => x.n === cur) || ALL[0];
    cur = e.n;
    history.replaceState(null, "", "#" + cur);
    document.getElementById("title").innerHTML = '<span class="num">#' + e.n + "</span>" + esc(e.title);
    document.getElementById("to").textContent = e.who === "You" ? "You (avery@averywhitted.com)" : "The student";
    document.getElementById("when").textContent = e.when;
    document.getElementById("subject").textContent = e.subject;
    document.getElementById("pre").textContent = e.preheader;
    const stage = document.getElementById("stage");
    if (version === "text") { stage.innerHTML = "<pre>" + esc(e.text) + "</pre>"; }
    else { stage.innerHTML = ""; const f = document.createElement("iframe"); f.className = width; f.title = e.title; f.srcdoc = e.html; stage.appendChild(f); }
    list();
    document.querySelector('nav button[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.n) { cur = Number(b.dataset.n); show(); }
    else if (b.dataset.w) { width = b.dataset.w; document.querySelectorAll("[data-w]").forEach((x) => x.setAttribute("aria-pressed", x === b)); show(); }
    else if (b.dataset.v) { version = b.dataset.v; document.querySelectorAll("[data-v]").forEach((x) => x.setAttribute("aria-pressed", x === b)); show(); }
    else if (b.id === "prev") { cur = Math.max(1, cur - 1); show(); }
    else if (b.id === "next") { cur = Math.min(ALL.length, cur + 1); show(); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.target.matches("input")) return;
    if (ev.key === "ArrowLeft") { cur = Math.max(1, cur - 1); show(); }
    if (ev.key === "ArrowRight") { cur = Math.min(ALL.length, cur + 1); show(); }
  });
  document.getElementById("q").addEventListener("input", list);
  show();
</script>
</body></html>`;
writeFileSync(new URL("index.html", out), page);
console.log(`Wrote a gallery of ${n} emails: http://localhost:8743/booking/.email-previews/`);
