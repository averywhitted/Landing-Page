// End-to-end tests of the booking flow, run with `npm test`.
// See harness.ts: real service code, in-memory database, fake Stripe/Resend/iCloud.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeDb, makeWorld, makeEnv, makeClient } from "./harness";
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
