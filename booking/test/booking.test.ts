// End-to-end tests of the booking flow, run with `npm test`.
// See harness.ts: real service code, in-memory database, fake Stripe/Resend/iCloud.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeDb, makeWorld, makeEnv, makeClient, accessToken, ACCESS_TEAM, ACCESS_AUD } from "./harness";
import { resetAccessCache } from "../src/admin";
import { buildIcs } from "../src/ics";
import type { Env } from "../src/env";

const realFetch = globalThis.fetch;
let db: ReturnType<typeof makeDb>["db"];
let world: ReturnType<typeof makeWorld>;
let env: Env;
let api: ReturnType<typeof makeClient>;

beforeEach(() => {
  const made = makeDb();
  db = made.db;
  world = makeWorld();
  globalThis.fetch = world.fakeFetch as typeof fetch;
  (globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } };
  env = makeEnv(made.d1);
  api = makeClient(env);
});
afterEach(() => { globalThis.fetch = realFetch; });

/* ── helpers ── */

const etDate = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const DAY = 86400000;
const intake = (over: Record<string, unknown> = {}) => ({
  name: "Jamie Rivera", email: "jamie@example.com", pronouns: "they/them",
  goal: "Callback prep", material: "Sides for a guest star", link: "https://example.com/sides.pdf", notes: "",
  policyAccepted: true, ...over,
});

async function openSlots(service = "coaching-60", daysAhead = 3) {
  const r = await api.call("GET", `/api/availability?service=${service}&from=${etDate(Date.now() + daysAhead * DAY)}&days=2`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.slots as string[];
}
function book(serviceId: string, start: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return api.call("POST", "/api/bookings", { body: { serviceId, start, timeZone: "America/Los_Angeles", intake: intake(over), ...extra } });
}
const row = (id: string) => db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as any;
const claims = (id: string) => (db.prepare("SELECT COUNT(*) n FROM slot_claims WHERE booking_id = ?").get(id) as any).n;
const sessionFor = (id: string) => world.state.stripeSessions.get(row(id).stripe_checkout_session_id)!;
const paid = (s: Record<string, any>) => ({ ...s, status: "complete", payment_status: "paid", payment_intent: `pi_${s.id}` });
const noEmDash = (s: string) => !s.includes("—");

/* ── Paid session: the happy path ── */

test("paid booking: hold, pay, confirm, calendar, emails", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.match(res.data.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);

  const b = row(res.data.bookingId);
  assert.equal(b.status, "held");
  assert.equal(claims(b.id), 5, "60 min + 15 min buffer = five 15-minute blocks");
  const s = sessionFor(b.id);
  assert.equal(s.amount_total, 13000, "price comes from the server");
  assert.equal(s._form.allow_promotion_codes, "true");
  const holdMs = Date.parse(b.hold_expires_at) - Date.now();
  assert.ok(holdMs > 30 * 60000 && holdMs <= 31 * 60000, "hold lasts just over 30 minutes");
  assert.equal(Number(s._form.expires_at) * 1000 > Date.now() + 30 * 60000, true, "Stripe checkout expires after at least 30 minutes");
  assert.ok(!(await openSlots()).includes(slot), "held time is no longer offered");

  const wh = await api.webhook("checkout.session.completed", paid(s));
  assert.equal(wh.status, 200);
  const done = row(b.id);
  assert.equal(done.status, "confirmed");
  assert.equal(done.hold_expires_at, null);
  assert.ok(done.calendar_event_url?.includes("/calendars/coaching/"), "written to the Coaching calendar");
  const eventIcs = world.state.calendarEvents.get(done.calendar_event_url)!.replace(/\r\n[ \t]/g, ""); // unfold wrapped lines
  assert.match(eventIcs, /SUMMARY:Coaching: Jamie Rivera \(1 hour\)/);
  assert.match(eventIcs, /Callback prep/, "intake answers are in Avery's event");

  assert.equal(world.state.emails.length, 2);
  const [client, admin] = world.state.emails;
  assert.deepEqual(client.to, ["jamie@example.com"]);
  assert.match(client.subject, /^You're booked: 1 hour session on /);
  assert.equal(client.attachments[0].filename, "session.ics");
  assert.deepEqual(admin.to, ["avery@averywhitted.com"]);
  assert.match(admin.subject, /^New booking: Jamie Rivera, 1 hour session/);
  for (const e of world.state.emails) assert.ok(noEmDash(e.html) && noEmDash(e.text) && noEmDash(e.subject), "no em dashes in emails");
  assert.ok(done.client_email_sent_at && done.admin_email_sent_at);

  const conf = await api.call("GET", `/api/confirmation?session_id=${s.id}`);
  assert.equal(conf.data.status, "confirmed");
  assert.equal(conf.data.firstName, "Jamie");
  assert.equal(conf.data.email, undefined, "confirmation page gets no email address");
});

test("client can't change the price", async () => {
  const [slot] = await openSlots("coaching-30");
  const res = await book("coaching-30", slot, {}, { priceCents: 1, amount: 1 });
  assert.equal(res.status, 201);
  assert.equal(sessionFor(res.data.bookingId).amount_total, 7500);
});

/* ── Stripe notifications ── */

test("webhook: forged signature is rejected", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  const wh = await api.webhook("checkout.session.completed", paid(sessionFor(res.data.bookingId)), { secret: "whsec_wrong" });
  assert.equal(wh.status, 400);
  assert.equal(row(res.data.bookingId).status, "held");
});

test("webhook: the same notice twice only confirms once", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  const s = paid(sessionFor(res.data.bookingId));
  await api.webhook("checkout.session.completed", s, { id: "evt_same" });
  const again = await api.webhook("checkout.session.completed", s, { id: "evt_same" });
  assert.equal(again.data.duplicate, true);
  const again2 = await api.webhook("checkout.session.completed", s, { id: "evt_other" });
  assert.equal(again2.status, 200);
  assert.equal(world.state.emails.length, 2, "still just one client + one admin email");
});

test("webhook: checkout expired releases the hold", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  const s = sessionFor(res.data.bookingId);
  await api.webhook("checkout.session.expired", { ...s, status: "expired" });
  const b = row(res.data.bookingId);
  assert.equal(b.status, "cancelled");
  assert.equal(b.cancel_reason, "hold_expired");
  assert.equal(claims(b.id), 0);
  assert.ok((await openSlots()).includes(slot), "time is offered again");
});

/* ── Double booking ── */

test("second person can't book an overlapping time", async () => {
  const slots = await openSlots();
  const first = await book("coaching-60", slots[0]);
  assert.equal(first.status, 201);
  const overlap = new Date(Date.parse(slots[0]) + 30 * 60000).toISOString().replace(/\.000Z$/, "Z");
  const second = await book("coaching-30", overlap, { email: "other@example.com" });
  assert.equal(second.status, 409);
});

test("database refuses overlapping claims even if two requests race past the check", async () => {
  const [slot] = await openSlots();
  const a = await book("coaching-60", slot);
  assert.equal(a.status, 201);
  // Simulate a second request that already passed the availability check.
  const { blocksFor } = await import("../src/availability");
  const insert = db.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?, ?)");
  assert.throws(() => insert.run(blocksFor(Date.parse(slot), 60)[0], a.data.bookingId), /UNIQUE constraint failed: slot_claims/);
});

/* ── Calendar ── */

test("busy iCloud events (timed, time-zoned, all-day) block; 'free' ones don't", async () => {
  const day = etDate(Date.now() + 3 * DAY).replace(/-/g, "");
  const next = etDate(Date.now() + 4 * DAY).replace(/-/g, "");
  world.state.busy = [
    { calendar: "Professional", ics: `BEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=America/New_York:${day}T100000\r\nDTEND;TZID=America/New_York:${day}T110000\r\nSUMMARY:Audition\r\nEND:VEVENT` },
    { calendar: "Personal", ics: `BEGIN:VEVENT\r\nUID:b\r\nDTSTART;TZID=America/New_York:${day}T150000\r\nDTEND;TZID=America/New_York:${day}T160000\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Marked free\r\nEND:VEVENT` },
    { calendar: "Personal", ics: `BEGIN:VEVENT\r\nUID:c\r\nDTSTART;VALUE=DATE:${next}\r\nDTEND;VALUE=DATE:${etDate(Date.now() + 5 * DAY).replace(/-/g, "")}\r\nSUMMARY:Away\r\nEND:VEVENT` },
  ];
  const r = await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.now() + 3 * DAY)}&days=2`);
  const et = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(Date.parse(iso));
  const times = r.data.slots.map(et);
  const d1 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(Date.now() + 3 * DAY);
  assert.ok(!times.includes(`${d1}, 9:00 AM`), "ends 10:00, no gap before 10:00 event");
  assert.ok(!times.includes(`${d1}, 10:30 AM`), "during the audition");
  assert.ok(times.includes(`${d1}, 11:30 AM`), "open after the 15 minute buffer");
  assert.ok(times.includes(`${d1}, 3:00 PM`), "event marked Free doesn't block");
  const d2 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(Date.now() + 4 * DAY);
  assert.ok(!times.some((t: string) => t.startsWith(`${d2},`)), "busy all-day event blocks the whole day");
});

test("availability fails politely if iCloud rejects the password", async () => {
  env.ICLOUD_APP_PASSWORD = "wrong";
  const r = await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.now() + 3 * DAY)}&days=1`);
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.data), /icloud|password|401/i, "no internal details leak");
});

/* ── Validation and limits ── */

test("form validation", async () => {
  const [slot] = await openSlots();
  assert.equal((await book("coaching-60", slot, { policyAccepted: false })).status, 400);
  assert.equal((await book("coaching-60", slot, { email: "not-an-email" })).status, 400);
  assert.equal((await book("coaching-60", slot, { link: "javascript:alert(1)" })).status, 400);
  assert.equal((await book("coaching-60", slot, { material: "" })).status, 400);
  assert.equal((await book("bundle-4", slot)).status, 400, "bundles can't be booked as a single slot");
  assert.equal((await book("coaching-60", "2020-01-01T15:00:00Z")).status, 409, "past times are refused");
  const odd = new Date(Date.parse(slot) + 7 * 60000).toISOString();
  assert.equal((await book("coaching-60", odd)).status, 409, "only offered start times are accepted");
  assert.equal(world.state.stripeSessions.size, 0);
});

test("one person can't hold more than two unpaid times", async () => {
  const slots = await openSlots("coaching-30");
  const spaced = slots.filter((_, i) => i % 3 === 0);
  assert.equal((await book("coaching-30", spaced[0])).status, 201);
  assert.equal((await book("coaching-30", spaced[1])).status, 201);
  const third = await book("coaching-30", spaced[2]);
  assert.equal(third.status, 429);
});

test("if Stripe is down, the hold is released and the client sees a friendly error", async () => {
  const [slot] = await openSlots();
  world.state.stripeFailNextCreate = true;
  const res = await book("coaching-60", slot);
  assert.equal(res.status, 502);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slot_claims").get() as any).n, 0);
  assert.ok((await openSlots()).includes(slot));
});

/* ── Free intro call ── */

test("intro call is confirmed immediately without payment; one per person", async () => {
  const [slot] = await openSlots("intro-15");
  const res = await book("intro-15", slot, { material: "" });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.match(res.data.confirmationUrl, /\/book\/confirmed\/\?booking=/);
  const b = row(res.data.bookingId);
  assert.equal(b.status, "confirmed");
  assert.equal(b.amount_cents, 0);
  assert.equal(world.state.stripeSessions.size, 0);
  assert.equal(world.state.emails.length, 2);
  assert.match(world.state.emails[0].subject, /Intro call/);
  assert.equal(claims(b.id), 2, "15 min + 15 min buffer");

  const slots = await openSlots("intro-15");
  const again = await book("intro-15", slots.at(-1)!, { material: "" });
  assert.equal(again.status, 409);
});

/* ── Holds that run out ── */

async function expireHold(id: string) {
  db.prepare("UPDATE bookings SET hold_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
  await api.cron();
}

test("cron releases an expired hold, expires the Stripe checkout, and sends one reminder", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  await expireHold(res.data.bookingId);
  const b = row(res.data.bookingId);
  assert.equal(b.status, "cancelled");
  assert.equal(b.cancel_reason, "hold_expired");
  assert.equal(sessionFor(b.id).status, "expired");
  assert.equal(claims(b.id), 0);
  assert.equal(world.state.emails.length, 1);
  assert.equal(world.state.emails[0].subject, "Your session isn't booked yet");
  assert.match(world.state.emails[0].html, /book\/\?service=coaching-60/);
  await api.cron();
  assert.equal(world.state.emails.length, 1, "reminder is only sent once");
});

test("no reminder when reminders are switched off, or when they booked again", async () => {
  env.REMINDERS_ENABLED = "0";
  const slots = await openSlots();
  const res = await book("coaching-60", slots[0]);
  await expireHold(res.data.bookingId);
  assert.equal(world.state.emails.length, 0);

  env.REMINDERS_ENABLED = "1";
  const res2 = await book("coaching-60", slots[0], { email: "sam@example.com" });
  const res3 = await book("coaching-60", slots.at(-1)!, { email: "sam@example.com" });
  assert.equal(res3.status, 201);
  await expireHold(res2.data.bookingId);
  const reminders = world.state.emails.filter((e) => e.subject === "Your session isn't booked yet" && e.to[0] === "sam@example.com");
  assert.equal(reminders.length, 0, "they already have a newer booking in progress");
});

test("paid at the last second: cron confirms instead of releasing", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  Object.assign(sessionFor(res.data.bookingId), paid(sessionFor(res.data.bookingId)));
  await expireHold(res.data.bookingId);
  assert.equal(row(res.data.bookingId).status, "confirmed");
  assert.equal(world.state.emails.filter((e) => /You're booked/.test(e.subject)).length, 1);
});

test("paid after the hold ran out, time still free: booking goes through", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  const s = sessionFor(res.data.bookingId);
  await api.webhook("checkout.session.expired", s);
  await api.webhook("checkout.session.completed", paid(s));
  const b = row(res.data.bookingId);
  assert.equal(b.status, "confirmed");
  assert.equal(claims(b.id), 5);
  assert.equal(world.state.refunds.length, 0);
});

test("paid after the hold ran out and someone else took it: automatic full refund", async () => {
  const [slot] = await openSlots();
  const late = await book("coaching-60", slot);
  const s = sessionFor(late.data.bookingId);
  await api.webhook("checkout.session.expired", s);
  const other = await book("coaching-60", slot, { email: "fast@example.com", name: "Fast Booker" });
  assert.equal(other.status, 201);

  await api.webhook("checkout.session.completed", paid(s));
  const b = row(late.data.bookingId);
  assert.equal(b.status, "cancelled");
  assert.equal(b.cancel_reason, "slot_taken_after_payment");
  assert.ok(b.refunded_at);
  assert.equal(world.state.refunds.length, 1);
  assert.equal(world.state.refunds[0].payment_intent, `pi_${s.id}`);
  const subjects = world.state.emails.map((e) => e.subject);
  assert.ok(subjects.includes("About your booking: you've been refunded"));
  assert.ok(subjects.some((x) => x.startsWith("Auto-refunded: Jamie Rivera")));
  const conf = await api.call("GET", `/api/confirmation?session_id=${s.id}`);
  assert.equal(conf.data.status, "refunded");
});

/* ── Retries ── */

test("failed confirmation email is retried by cron", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  world.state.resendFailNext = 1;
  await api.webhook("checkout.session.completed", paid(sessionFor(res.data.bookingId)));
  let b = row(res.data.bookingId);
  assert.equal(b.client_email_sent_at, null);
  assert.ok(b.admin_email_sent_at, "the admin email still went out");
  const log = db.prepare("SELECT kind, status FROM email_log WHERE booking_id = ?").all(b.id) as any[];
  assert.ok(log.some((l) => l.kind === "client_confirmation" && l.status === "failed"));

  db.prepare("UPDATE bookings SET confirmed_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 60000).toISOString(), b.id);
  await api.cron();
  b = row(b.id);
  assert.ok(b.client_email_sent_at, "retried and sent");
  assert.equal(world.state.emails.filter((e) => /You're booked/.test(e.subject)).length, 1);
});

/* ── Web security basics ── */

test("CORS: only averywhitted.com (and local previews) may call from a browser", async () => {
  const ok = await api.call("GET", "/api/services", { headers: { Origin: "https://averywhitted.com" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://averywhitted.com");
  const bad = await api.call("GET", "/api/services", { headers: { Origin: "https://evil.example" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("confirmation lookup ignores junk ids", async () => {
  assert.equal((await api.call("GET", "/api/confirmation?booking=../../etc")).status, 404);
  assert.equal((await api.call("GET", "/api/confirmation")).status, 404);
});

test("hidden line breaks in a name can't inject calendar fields", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot, { name: "Jamie\r\nATTENDEE:mailto:evil@example.com" });
  assert.equal(res.status, 201);
  await api.webhook("checkout.session.completed", paid(sessionFor(res.data.bookingId)));
  const ics = world.state.calendarEvents.get(row(res.data.bookingId).calendar_event_url)!;
  assert.doesNotMatch(ics, /\r\nATTENDEE/, "no injected line");
  assert.ok(!world.state.emails.some((e) => /[\r\n]/.test(e.subject)), "no line breaks in subjects");
});

test("only one reminder per person per week", async () => {
  const slots = await openSlots();
  const a = await book("coaching-60", slots[0]);
  await expireHold(a.data.bookingId);
  const b = await book("coaching-60", slots.at(-1)!);
  await expireHold(b.data.bookingId);
  assert.equal(world.state.emails.filter((e) => e.subject === "Your session isn't booked yet").length, 1);
});

test("Turnstile: bookings need a valid human-check token once it's switched on", async () => {
  env.TURNSTILE_SECRET_KEY = "turnstile-secret";
  const [slot] = await openSlots();
  assert.equal((await book("coaching-60", slot)).status, 403, "no token");
  assert.equal((await book("coaching-60", slot, {}, { turnstileToken: "forged" })).status, 403, "bad token");
  assert.equal(world.state.stripeSessions.size, 0, "nothing held or charged for failed checks");
  assert.equal((await book("coaching-60", slot, {}, { turnstileToken: "good-token" })).status, 201);
});

test("email wordmark image is served", async () => {
  const r = await api.call("GET", "/email/wordmark.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
});

/* ── Reschedule and cancel (manage link) ── */

async function confirmedBooking(service = "coaching-60", slotIndex = 0) {
  const slots = await openSlots(service);
  const res = await book(service, slots[slotIndex], service === "intro-15" ? { material: "" } : {});
  assert.equal(res.status, 201, JSON.stringify(res.data));
  if (service !== "intro-15") await api.webhook("checkout.session.completed", paid(sessionFor(res.data.bookingId)));
  const email = world.state.emails.find((e) => /You're booked/.test(e.subject))!;
  const m = email.text.match(/book\/manage\/\?b=([0-9a-f-]{36})&t=([\w-]{32})/);
  assert.ok(m, "confirmation email has a manage link");
  world.state.emails.length = 0;
  return { id: res.data.bookingId as string, b: m![1], t: m![2], slots };
}

test("manage link: shows the booking; a wrong or altered link shows nothing", async () => {
  const { b, t } = await confirmedBooking();
  const ok = await api.call("GET", `/api/manage?b=${b}&t=${t}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, "confirmed");
  assert.equal(ok.data.canChange, true);
  assert.equal(ok.data.firstName, "Jamie");
  assert.equal(ok.data.email, undefined);
  assert.equal((await api.call("GET", `/api/manage?b=${b}&t=${"x".repeat(32)}`)).status, 404);
  const other = "00000000-0000-4000-8000-000000000000";
  assert.equal((await api.call("GET", `/api/manage?b=${other}&t=${t}`)).status, 404, "a link can't be pointed at another booking");
});

test("cancel: frees the time, removes the calendar event, emails both with a refund prompt", async () => {
  const { id, b, t, slots } = await confirmedBooking();
  const eventUrl = row(id).calendar_event_url;
  assert.ok(world.state.calendarEvents.has(eventUrl));
  const r = await api.call("POST", "/api/manage/cancel", { body: { b, t } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = row(id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancel_reason, "client_cancelled");
  assert.equal(claims(id), 0);
  assert.ok(!world.state.calendarEvents.has(eventUrl), "removed from the Coaching calendar");
  assert.ok((await openSlots()).includes(slots[0]), "time is bookable again");

  const [client, admin] = world.state.emails;
  assert.match(client.subject, /^Cancelled: 1 hour session/);
  const ics = Buffer.from(client.attachments[0].content, "base64").toString();
  assert.match(ics, /METHOD:CANCEL/);
  assert.match(ics, /SEQUENCE:1/);
  assert.match(ics, new RegExp(`UID:${row(id).ics_uid}`));
  assert.match(admin.subject, /\(refund \$130\)$/);
  assert.match(admin.html, /dashboard\.stripe\.com\/test\/payments\/pi_/);
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: { b, t } })).status, 409, "can't cancel twice");
});

test("cancel and reschedule are refused inside 24 hours", async () => {
  const { id, b, t, slots } = await confirmedBooking();
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?")
    .run(new Date(Date.now() + 10 * 3600000).toISOString(), new Date(Date.now() + 11 * 3600000).toISOString(), id);
  const view = await api.call("GET", `/api/manage?b=${b}&t=${t}`);
  assert.equal(view.data.canChange, false);
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: { b, t } })).status, 403);
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots.at(-1) } })).status, 403);
  assert.equal(row(id).status, "confirmed");
});

test("reschedule: moves blocks, updates the same calendar event, emails an updated invite", async () => {
  const { id, b, t } = await confirmedBooking();
  const before = row(id);
  // Avery's own Coaching event for this booking shows up as busy in iCloud; it must not block the move.
  world.state.busy.push({ calendar: "Coaching", ics: `BEGIN:VEVENT\r\nUID:${before.ics_uid}\r\nDTSTART:${before.start_utc.replace(/[-:]/g, "")}\r\nDTEND:${before.end_utc.replace(/[-:]/g, "")}\r\nEND:VEVENT` });
  const nextDoor = new Date(Date.parse(before.start_utc) + 30 * 60000).toISOString().replace(/\.000Z$/, "Z");

  const avail = await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.parse(before.start_utc))}&days=1&b=${b}&t=${t}`);
  assert.ok(avail.data.slots.includes(nextDoor), "with the manage link, times next to the current one are offered");

  const r = await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: nextDoor } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = row(id);
  assert.equal(after.start_utc, nextDoor);
  assert.equal(after.previous_start_utc, before.start_utc);
  assert.equal(after.ics_sequence, 1);
  assert.equal(after.reschedule_count, 1);
  assert.equal(claims(id), 5);
  assert.equal(after.calendar_event_url, before.calendar_event_url, "same event, updated in place");
  const eventIcs = world.state.calendarEvents.get(after.calendar_event_url)!;
  assert.match(eventIcs, new RegExp(`DTSTART:${nextDoor.replace(/[-:]/g, "")}`));
  assert.match(eventIcs, /SEQUENCE:1/);

  const [client, admin] = world.state.emails;
  assert.match(client.subject, /^Rescheduled: 1 hour session now on /);
  const ics = Buffer.from(client.attachments[0].content, "base64").toString();
  assert.match(ics, /METHOD:REQUEST/);
  assert.match(ics, /SEQUENCE:1/);
  assert.match(client.text, /book\/manage\/\?b=/, "new manage link included");
  assert.match(admin.subject, /^Rescheduled: Jamie Rivera moved to /);
  for (const e of world.state.emails) assert.ok(noEmDash(e.html + e.text + e.subject));
});

test("reschedule: taken, invalid, same, or too-many moves are refused", async () => {
  const { b, t, slots } = await confirmedBooking("coaching-30");
  const other = await book("coaching-30", slots.at(-1)!, { email: "other@example.com" });
  assert.equal(other.status, 201);
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots.at(-1) } })).status, 409, "held by someone else");
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: "2020-01-01T15:00:00Z" } })).status, 409);
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots[0] } })).status, 400, "same time");
  for (const i of [4, 8, 12]) {
    assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots[i] } })).status, 200);
  }
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots[16] } })).status, 403, "fourth move needs an email");
});

test("free intro call can be cancelled, with no refund wording", async () => {
  const { b, t } = await confirmedBooking("intro-15");
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: { b, t } })).status, 200);
  const [client, admin] = world.state.emails;
  assert.doesNotMatch(client.html, /refund/i);
  assert.doesNotMatch(admin.subject, /refund/i);
});

test("every fixed email heading has a Horizon image, and it's served", async () => {
  const { HEADING_TITLES } = await import("../src/templates");
  const { HEADING_IMAGES } = await import("../src/email-headings");
  for (const t of HEADING_TITLES) {
    assert.ok(HEADING_IMAGES[t], `missing heading image for "${t}"`);
    const r = await api.call("GET", `/email/h/${HEADING_IMAGES[t].file}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
  }
  assert.equal((await api.call("GET", "/email/h/../../secrets")).status, 404);
});

/* ── Day-before reminders, retention, alerts ── */

test("session reminder: sent once when the session is within 24 hours; a reschedule re-arms it", async () => {
  const { id, b, t } = await confirmedBooking();
  const soon = Date.now() + 20 * 3600000;
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ?, confirmed_at = ? WHERE id = ?")
    .run(new Date(soon).toISOString(), new Date(soon + 3600000).toISOString(), new Date(Date.now() - 3 * 3600000).toISOString(), id);
  await api.cron();
  const reminders = () => world.state.emails.filter((e) => /^Reminder: your 1 hour session/.test(e.subject));
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0].subject, /(today|tomorrow) at /);
  assert.match(reminders()[0].html, /Join on Zoom|Zoom link/);
  await api.cron();
  assert.equal(reminders().length, 1, "only once");
  assert.ok(row(id).session_reminder_sent_at);
  // Move it (pretend it's far out again) and the reminder resets.
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?")
    .run(new Date(Date.now() + 5 * 86400000).toISOString(), new Date(Date.now() + 5 * 86400000 + 3600000).toISOString(), id);
  const slots = await openSlots("coaching-60", 6);
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots[0] } })).status, 200);
  assert.equal(row(id).session_reminder_sent_at, null);
});

test("no reminder for a session booked in the last two hours", async () => {
  const { id } = await confirmedBooking();
  const soon = Date.now() + 20 * 3600000;
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ?, confirmed_at = ? WHERE id = ?")
    .run(new Date(soon).toISOString(), new Date(soon + 3600000).toISOString(), new Date().toISOString(), id);
  await api.cron();
  assert.equal(world.state.emails.filter((e) => /^Reminder:/.test(e.subject)).length, 0);
});

test("retention: intake answers are removed two years after the session", async () => {
  const { id } = await confirmedBooking();
  const old = Date.now() - 800 * 86400000;
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(old).toISOString(), new Date(old + 3600000).toISOString(), id);
  const recent = await confirmedBooking("coaching-30", 3);
  await api.cron();
  assert.equal(row(id).intake_json, null);
  assert.ok(row(recent.id).intake_json, "recent answers are kept");
});

test("alerts: Avery hears about failures, at most once an hour", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot);
  world.state.resendFailNext = 99; // email is down
  await api.webhook("checkout.session.completed", paid(sessionFor(res.data.bookingId)));
  world.state.resendFailNext = 0;
  db.prepare("UPDATE bookings SET confirmed_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60000).toISOString(), res.data.bookingId);
  world.state.resendFailNext = 2; // the retries also fail
  await api.cron();
  const alerts = () => world.state.emails.filter((e) => /^Booking system: /.test(e.subject));
  assert.equal(alerts().length, 1);
  assert.deepEqual(alerts()[0].to, ["avery@averywhitted.com"]);
  assert.match(alerts()[0].text, /failed to send/);
  await api.cron();
  assert.equal(alerts().length, 1, "no repeat within the hour");
});

/* ── Bundles ── */

async function buyBundle(serviceId = "bundle-4", over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const r = await api.call("POST", "/api/packages", { body: { serviceId, timeZone: "America/Chicago", intake: intake({ material: "", ...over }), ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const pkg = () => db.prepare("SELECT * FROM packages WHERE id = ?").get(r.data.packageId) as any;
  const session = world.state.stripeSessions.get(pkg().stripe_checkout_session_id)!;
  return { id: r.data.packageId as string, pkg, session };
}
async function paidBundle(serviceId = "bundle-4") {
  const bought = await buyBundle(serviceId);
  await api.webhook("checkout.session.completed", paid(bought.session));
  const email = world.state.emails.find((e) => /sessions are ready to book/.test(e.subject))!;
  const m = email.text.match(/book\/package\/\?p=([0-9a-f-]{36})&t=([\w-]{32})/);
  assert.ok(m, "bundle email has a bundle-page link");
  world.state.emails.length = 0;
  return { ...bought, p: m![1], t: m![2] };
}
const ledger = (id: string) => (db.prepare("SELECT delta, reason FROM credit_ledger WHERE package_id = ? ORDER BY id").all(id) as any[]).map((l) => ({ ...l }));

test("bundle: buying creates a paid-up bundle with 4 credits and a 90-day use-by date", async () => {
  const { id, pkg, session } = await buyBundle();
  assert.equal(pkg().status, "pending");
  assert.equal(session.amount_total, 44000);
  assert.equal(session.metadata.package_id, id);
  await api.webhook("checkout.session.completed", paid(session));
  const p = pkg();
  assert.equal(p.status, "active");
  assert.equal(p.credits_total, 4);
  const days = (Date.parse(p.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 89.9 && days <= 90, "use by 90 days from purchase");
  assert.deepEqual(ledger(id), [{ delta: 4, reason: "purchased" }]);
  const subjects = world.state.emails.map((e) => e.subject);
  assert.ok(subjects.includes("Your 4 sessions are ready to book"));
  assert.ok(subjects.some((x) => /^Bundle purchased: Jamie Rivera, 4 session bundle \(\$440\)/.test(x)));
  const conf = await api.call("GET", `/api/confirmation?session_id=${session.id}`);
  assert.equal(conf.data.type, "package");
  assert.equal(conf.data.status, "confirmed");
  assert.match(conf.data.packageUrl, /\/book\/package\/\?p=/);
});

test("bundle page: shows credits; links can't be forged or swapped with booking links", async () => {
  const { p, t } = await paidBundle();
  const v = await api.call("GET", `/api/packages?p=${p}&t=${t}`);
  assert.equal(v.status, 200);
  assert.equal(v.data.remaining, 4);
  assert.equal(v.data.canBook, true);
  assert.equal((await api.call("GET", `/api/packages?p=${p}&t=${"z".repeat(32)}`)).status, 404);
  assert.equal((await api.call("GET", `/api/manage?b=${p}&t=${t}`)).status, 404, "a bundle link doesn't work as a booking link");
});

test("bundle: booking with a credit needs no payment and counts down", async () => {
  const { id, p, t } = await paidBundle();
  const [slot] = await openSlots("coaching-60");
  const before = world.state.stripeSessions.size;
  const r = await api.call("POST", "/api/packages/book", { body: { p, t, start: slot, focus: "Monologue for a callback" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(world.state.stripeSessions.size, before, "no checkout");
  const b = row(r.data.bookingId);
  assert.equal(b.status, "confirmed");
  assert.equal(b.package_id, id);
  assert.equal(b.amount_cents, 0);
  assert.match(b.intake_json, /Monologue for a callback/);
  assert.equal(claims(b.id), 5);
  assert.deepEqual(ledger(id).map((l) => l.delta), [4, -1]);
  const conf = world.state.emails.find((e) => /You're booked/.test(e.subject))!;
  assert.match(conf.html, /Bundle session \(3 of 4 left\)/);
  assert.ok(world.state.calendarEvents.has(b.calendar_event_url));
  assert.equal((await api.call("GET", `/api/packages?p=${p}&t=${t}`)).data.sessions.length, 1);
});

test("bundle: can't book more sessions than it has, even at the database level", async () => {
  const { id, p, t } = await paidBundle("bundle-2");
  const slots = await openSlots("coaching-60");
  assert.equal((await api.call("POST", "/api/packages/book", { body: { p, t, start: slots[0] } })).status, 201);
  assert.equal((await api.call("POST", "/api/packages/book", { body: { p, t, start: slots[6] } })).status, 201);
  assert.equal((await api.call("POST", "/api/packages/book", { body: { p, t, start: slots[12] } })).status, 409);
  assert.throws(() => db.prepare("UPDATE packages SET credits_used = credits_used + 1 WHERE id = ?").run(id), /CHECK constraint failed/);
});

test("bundle: cancelling 24+ hours ahead returns the session to the bundle", async () => {
  const { id, p, t } = await paidBundle();
  const [slot] = await openSlots("coaching-60");
  const r = await api.call("POST", "/api/packages/book", { body: { p, t, start: slot } });
  world.state.emails.length = 0;
  const m = r.data.manageUrl.match(/b=([^&]+)&t=([^&]+)/);
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: { b: m[1], t: m[2] } })).status, 200);
  assert.equal((db.prepare("SELECT credits_used FROM packages WHERE id = ?").get(id) as any).credits_used, 0);
  assert.deepEqual(ledger(id).map((l) => l.reason), ["purchased", "booked", "cancelled_in_time"]);
  const [client, admin] = world.state.emails;
  assert.match(client.html, /gone back into your bundle/);
  assert.doesNotMatch(client.html, /refund/i);
  assert.match(client.html, /book\/package\/\?p=/, "book-again link goes to the bundle page");
  assert.match(admin.html, /credit has gone back into their bundle/);
});

test("bundle: sessions must be before the use-by date; expired bundles can't book", async () => {
  const { id, p, t } = await paidBundle();
  const slots = await openSlots("coaching-60");
  db.prepare("UPDATE packages SET expires_at = ? WHERE id = ?").run(new Date(Date.parse(slots[0]) - 60000).toISOString(), id);
  assert.equal((await api.call("POST", "/api/packages/book", { body: { p, t, start: slots[0] } })).status, 409);
  db.prepare("UPDATE packages SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
  const v = await api.call("GET", `/api/packages?p=${p}&t=${t}`);
  assert.equal(v.data.status, "expired");
  assert.equal(v.data.canBook, false);
});

test("bundle: one 'sessions expiring' email a week before the use-by date", async () => {
  const { id } = await paidBundle();
  db.prepare("UPDATE packages SET expires_at = ? WHERE id = ?").run(new Date(Date.now() + 5 * 86400000).toISOString(), id);
  await api.cron();
  await api.cron();
  const notes = world.state.emails.filter((e) => /^You have 4 sessions left to use by /.test(e.subject));
  assert.equal(notes.length, 1);
});

test("bundle: an unpaid checkout that expires leaves nothing behind", async () => {
  const { pkg, session } = await buyBundle();
  await api.webhook("checkout.session.expired", { ...session, status: "expired" });
  assert.equal(pkg().status, "cancelled");
});

/* ── Promo codes ── */

test("promo link: a valid code is pre-applied and recorded; an unknown one falls back to the code box", async () => {
  world.state.promoCodes = { SPRING20: "promo_abc" };
  const slots = await openSlots("coaching-60");
  const good = await book("coaching-60", slots[0], {}, { promo: "SPRING20" });
  const s = sessionFor(good.data.bookingId);
  assert.equal(s._form.discounts["0"].promotion_code, "promo_abc");
  assert.equal(s._form.allow_promotion_codes, undefined);
  await api.webhook("checkout.session.completed", { ...paid(s), amount_total: 10400 });
  assert.equal(row(good.data.bookingId).promo_code, "SPRING20");
  assert.equal(row(good.data.bookingId).amount_cents, 10400);
  assert.match(world.state.emails.find((e) => /You're booked/.test(e.subject))!.html, /\$104 \(code SPRING20\)/);

  const unknown = await book("coaching-30", slots.at(-1)!, { email: "b@example.com" }, { promo: "NOPE" });
  assert.equal(sessionFor(unknown.data.bookingId)._form.allow_promotion_codes, "true");
});

test("promo link on a bundle; and a key without promo permission still books", async () => {
  world.state.promoCodes = { FOURPACK: "promo_4" };
  const { session } = await buyBundle("bundle-4", {}, { promo: "FOURPACK" });
  assert.equal(session._form.discounts["0"].promotion_code, "promo_4");
  world.state.promoLookupForbidden = true;
  const { session: s2 } = await buyBundle("bundle-2", { email: "c@example.com" }, { promo: "FOURPACK" });
  assert.equal(s2._form.allow_promotion_codes, "true", "falls back gracefully");
});

/* ── Admin ── */

function adminEnv() {
  env.ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
  env.ACCESS_AUD = ACCESS_AUD;
  resetAccessCache();
}
const asAdmin = (token = accessToken()) => ({ "Cf-Access-Jwt-Assertion": token, "X-Admin": "1" });

test("admin: switched off until Access is set up; refuses missing, forged, expired, wrong-app, and other people's passes", async () => {
  assert.equal((await api.call("GET", "/admin")).status, 403, "off by default");
  adminEnv();
  assert.equal((await api.call("GET", "/admin")).status, 403, "no pass");
  for (const bad of [
    accessToken({}, { forged: true }),
    accessToken({ exp: Math.floor(Date.now() / 1000) - 10 }),
    accessToken({ aud: ["some-other-app"] }),
    accessToken({ iss: "https://evil.cloudflareaccess.com" }),
    accessToken({ email: "someone@else.com" }),
    "not.a.token",
  ]) {
    assert.equal((await api.call("GET", "/admin", { headers: { "Cf-Access-Jwt-Assertion": bad } })).status, 403);
  }
  const ok = await api.call("GET", "/admin", { headers: { "Cf-Access-Jwt-Assertion": accessToken() } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(ok.data, /Booking admin/);
  assert.equal((await api.call("GET", "/admin/app.js", { headers: { "Cf-Access-Jwt-Assertion": accessToken() } })).headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("admin API: needs the admin header and a pass; overview lists bookings and bundles", async () => {
  adminEnv();
  await confirmedBooking();
  await paidBundle();
  assert.equal((await api.call("GET", "/api/admin/overview", { headers: { "Cf-Access-Jwt-Assertion": accessToken() } })).status, 403, "no X-Admin header");
  assert.equal((await api.call("GET", "/api/admin/overview", { headers: { "X-Admin": "1" } })).status, 403, "no pass");
  assert.equal((await api.call("GET", "/api/admin/overview", { headers: { ...asAdmin(), Origin: "https://evil.example" } })).status, 403, "cross-site");
  const r = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, "test");
  assert.equal(r.data.bookings.length, 1);
  assert.equal(r.data.bookings[0].name, "Jamie Rivera");
  assert.match(r.data.bookings[0].stripeUrl, /dashboard\.stripe\.com\/test\/payments\//);
  assert.equal(r.data.packages.length, 1);
  assert.equal(r.data.packages[0].remaining, 4);
});

test("admin: cancel a bundle session for a client (no 24h limit), optionally quietly, returning the credit", async () => {
  adminEnv();
  const { id: pkgId, p, t } = await paidBundle();
  const [slot] = await openSlots("coaching-60");
  const booked = await api.call("POST", "/api/packages/book", { body: { p, t, start: slot } });
  world.state.emails.length = 0;
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?")
    .run(new Date(Date.now() + 3 * 3600000).toISOString(), new Date(Date.now() + 4 * 3600000).toISOString(), booked.data.bookingId);
  const r = await api.call("POST", `/api/admin/bookings/${booked.data.bookingId}/cancel`, { headers: asAdmin(), body: { notifyClient: false, returnCredit: true, note: "I was sick" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(row(booked.data.bookingId).status, "cancelled");
  assert.equal(row(booked.data.bookingId).cancel_reason, "avery_cancelled");
  assert.equal((db.prepare("SELECT credits_used FROM packages WHERE id = ?").get(pkgId) as any).credits_used, 0);
  assert.equal(world.state.emails.length, 0, "client wasn't emailed");
  assert.ok(!world.state.calendarEvents.has(row(booked.data.bookingId).calendar_event_url));
});

test("admin: add/remove bundle sessions and extend the use-by date", async () => {
  adminEnv();
  const { id, pkg } = await paidBundle("bundle-2");
  assert.equal((await api.call("POST", `/api/admin/packages/${id}/credits`, { headers: asAdmin(), body: { delta: 1, note: "makeup" } })).status, 200);
  assert.equal(pkg().credits_total, 3);
  assert.equal((await api.call("POST", `/api/admin/packages/${id}/credits`, { headers: asAdmin(), body: { delta: -1 } })).status, 200);
  assert.equal((await api.call("POST", `/api/admin/packages/${id}/credits`, { headers: asAdmin(), body: { delta: 5 } })).status, 400);
  const before = Date.parse(pkg().expires_at);
  assert.equal((await api.call("POST", `/api/admin/packages/${id}/extend`, { headers: asAdmin(), body: { days: 14 } })).status, 200);
  assert.equal(Math.round((Date.parse(pkg().expires_at) - before) / 86400000), 14);
  assert.deepEqual(ledger(id).map((l) => l.reason), ["purchased", "avery_added", "avery_removed", "avery_extended"]);
  // Can't remove sessions that are already booked.
  const { id: id2, p, t } = await paidBundle("bundle-2");
  const slots = await openSlots("coaching-60");
  await api.call("POST", "/api/packages/book", { body: { p, t, start: slots[0] } });
  await api.call("POST", "/api/packages/book", { body: { p, t, start: slots[6] } });
  assert.equal((await api.call("POST", `/api/admin/packages/${id2}/credits`, { headers: asAdmin(), body: { delta: -1 } })).status, 409);
});

/* ── Editable settings ── */

async function saveSettings(patch: Record<string, unknown>) {
  const cur = (await api.call("GET", "/api/admin/settings", { headers: asAdmin() })).data.values;
  return api.call("POST", "/api/admin/settings", { headers: asAdmin(), body: { ...cur, ...patch } });
}

test("settings: saved hours, days, and notice change which times are offered", async () => {
  adminEnv();
  const got = await api.call("GET", "/api/admin/settings", { headers: asAdmin() });
  assert.equal(got.status, 200);
  assert.deepEqual([...got.data.calendars], ["Coaching", "Personal", "Professional"], "lists the real iCloud calendars");
  assert.equal(got.data.values.dayStartHour, 9);

  const day = Date.now() + 4 * DAY;
  const weekday = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(day) + "T12:00:00Z").getUTCDay();
  const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekday);
  const r = await saveSettings({ dayStartHour: 12, dayEndHour: 17, workDays: others, slotStepMinutes: 60 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.updatedBy, "avery@averywhitted.com");

  const slots = (await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.now() + 3 * DAY)}&days=3`)).data.slots as string[];
  const et = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(Date.parse(iso));
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => ["12:00 PM", "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM"].includes(et(s))), "noon to 5, hourly");
  assert.ok(!slots.some((s) => etDate(Date.parse(s)) === etDate(day)), "the day off offers nothing");
  const nineAm = new Date(Date.parse(slots[0]) - 3 * 3600000).toISOString().replace(/\.000Z$/, "Z"); // before the new noon opening
  const bad = (await api.call("POST", "/api/bookings", { body: { serviceId: "coaching-60", start: nineAm, timeZone: "America/New_York", intake: intake() } }));
  assert.equal(bad.status, 409, "the server applies the same rules");
});

test("settings: nonsense values and unknown calendars are refused; reset restores defaults", async () => {
  adminEnv();
  assert.equal((await saveSettings({ dayStartHour: 18, dayEndHour: 9 })).status, 400);
  assert.equal((await saveSettings({ workDays: [] })).status, 400);
  assert.equal((await saveSettings({ bufferMinutes: 7 })).status, 400);
  assert.equal((await saveSettings({ slotStepMinutes: 20 })).status, 400);
  const unknown = await saveSettings({ busyCalendars: ["Personal", "Gym"] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /Gym/);
  const ok = await saveSettings({ busyCalendars: ["Personal"], bookingCalendar: "Coaching", bufferMinutes: 30 });
  assert.deepEqual([...ok.data.values.busyCalendars].sort(), ["Coaching", "Personal"], "bookings calendar always blocks too");
  const reset = await api.call("POST", "/api/admin/settings/reset", { headers: asAdmin() });
  assert.equal(reset.data.values.bufferMinutes, 15);
  assert.equal(reset.data.updatedAt, null);
  assert.equal((await api.call("POST", "/api/admin/settings", { body: { bufferMinutes: 30 } })).status, 403, "admin only");
});

test("settings: a bigger buffer spaces out bookings", async () => {
  adminEnv();
  await saveSettings({ bufferMinutes: 60 });
  const slots = await openSlots("coaching-60");
  const first = await book("coaching-60", slots[0]);
  assert.equal(first.status, 201);
  assert.equal(claims(first.data.bookingId), 8, "60 min session + 60 min buffer = eight 15-minute blocks");
  const after = await openSlots("coaching-60");
  const gapOk = after.filter((s) => etDate(Date.parse(s)) === etDate(Date.parse(slots[0])))
    .every((s) => Math.abs(Date.parse(s) - Date.parse(slots[0])) >= 2 * 3600000);
  assert.ok(gapOk, "nothing within two hours of the start (1h session + 1h buffer either side)");
});

/* ── Calendar files ── */

test("calendar files are escaped and folded correctly", () => {
  const ics = buildIcs({
    uid: "x@averywhitted.com", sequence: 2, start: Date.UTC(2026, 9, 1, 15), end: Date.UTC(2026, 9, 1, 16),
    summary: "Coaching: Ana; Lee, Jr.", description: "Line one\nLine two " + "long ".repeat(40), method: "REQUEST",
  });
  assert.match(ics, /SUMMARY:Coaching: Ana\\; Lee\\, Jr\./);
  assert.match(ics, /SEQUENCE:2/);
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line}`);
});
