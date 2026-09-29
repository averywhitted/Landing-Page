// End-to-end tests of the booking flow, run with `npm test`.
// See harness.ts: real service code, in-memory database, fake Stripe/Resend/iCloud.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeDb, makeWorld, makeEnv, makeClient, accessToken, ACCESS_TEAM, ACCESS_AUD } from "./harness";
import { resetAccessCache } from "../src/admin";
import { forgetCalendars } from "../src/icloud";
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
  forgetCalendars();
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

test("one connection can't hold more than two unpaid times (even with different emails)", async () => {
  const slots = await openSlots("coaching-30");
  const spaced = slots.filter((_, i) => i % 3 === 0);
  assert.equal((await book("coaching-30", spaced[0], { email: "one@example.com" })).status, 201);
  assert.equal((await book("coaching-30", spaced[1], { email: "two@example.com" })).status, 201);
  const third = await book("coaching-30", spaced[2], { email: "three@example.com" });
  assert.equal(third.status, 429);
});

test("an abandoned hold is let go at once: back from Stripe, Start over, or booking again", async () => {
  const [slot] = await openSlots();
  const first = await book("coaching-60", slot);
  assert.equal(first.status, 201);
  const cancelUrl = sessionFor(first.data.bookingId)._form.cancel_url as string;
  assert.match(cancelUrl, new RegExp(`checkout=cancelled&hold=${first.data.bookingId}`), "the way back says which hold to let go");
  assert.ok(!(await openSlots()).includes(slot), "held while they pay");

  // Back from Stripe: the page lets it go, and the time is theirs to pick again.
  const rel = await api.call("POST", "/api/bookings/release", { body: { id: first.data.bookingId } });
  assert.equal(rel.data.result, "released");
  assert.equal(row(first.data.bookingId).status, "cancelled");
  assert.equal(sessionFor(first.data.bookingId).status, "expired", "Stripe's page is closed, so it can't be paid after");
  assert.ok((await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.now() + 3 * DAY)}&days=2&fresh=1`)).data.slots.includes(slot));
  assert.equal((await api.call("POST", "/api/bookings/release", { body: { id: "not-an-id" } })).status, 400);

  // Booking again (same person, same connection) lets the earlier hold go first,
  // so trying a few times never hits the two-holds limit.
  for (let i = 0; i < 3; i++) assert.equal((await book("coaching-60", slot)).status, 201, `attempt ${i + 1}`);
  const held = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'held'").get() as any;
  assert.equal(held.n, 1, "only the latest hold remains");

  // Paid at that very moment: confirmed, not released.
  const last = (db.prepare("SELECT id FROM bookings WHERE status = 'held'").get() as any).id;
  world.state.stripeSessions.set(row(last).stripe_checkout_session_id, paid(sessionFor(last)));
  const late = await api.call("POST", "/api/bookings/release", { body: { id: last } });
  assert.equal(late.data.result, "confirmed");
  assert.equal(row(last).status, "confirmed");
});

test("if Stripe is down, the hold is released and the client sees a friendly error", async () => {
  const [slot] = await openSlots();
  world.state.stripeFailNextCreate = true;
  const res = await book("coaching-60", slot);
  assert.equal(res.status, 502);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slot_claims").get() as any).n, 0);
  assert.ok((await openSlots()).includes(slot));
});

/* ── Free intro chat ── */

test("intro chat is confirmed immediately without payment; one per person", async () => {
  const [slot] = await openSlots("intro-15");
  const res = await book("intro-15", slot, { material: "" });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.match(res.data.confirmationUrl, /\/book\/confirmed\/\?booking=/);
  const b = row(res.data.bookingId);
  assert.equal(b.status, "confirmed");
  assert.equal(b.amount_cents, 0);
  assert.equal(world.state.stripeSessions.size, 0);
  assert.equal(world.state.emails.length, 2);
  assert.match(world.state.emails[0].subject, /Intro chat/);
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
  assert.equal((await book("coaching-60", slot, {}, { turnstileToken: "elsewhere-token" })).status, 403, "a pass from another site");
  assert.equal((await book("coaching-60", slot, {}, { turnstileToken: "lan-token" })).status, 403, "home-network pages don't count on the live site");
  assert.equal((await book("coaching-60", slot, {}, { turnstileToken: "good-token" })).status, 201);
});

test("home-network test pages: allowed only while testing", async () => {
  const origin = "http://192.168.1.155:8743";
  const allowed = async () => (await api.call("GET", "/api/services", { headers: { Origin: origin } })).headers.get("Access-Control-Allow-Origin");
  assert.equal(await allowed(), null, "live site: no");
  const live = env.SITE_URL;
  env.SITE_URL = origin;
  try {
    assert.equal(await allowed(), origin, "test mode: yes");
    env.TURNSTILE_SECRET_KEY = "turnstile-secret";
    const [slot] = await openSlots();
    assert.equal((await book("coaching-60", slot, {}, { turnstileToken: "lan-token" })).status, 201);
  } finally {
    env.SITE_URL = live;
  }
  assert.equal((await api.call("GET", "/api/services", { headers: { Origin: "https://averywhitted.com" } })).headers.get("Access-Control-Allow-Origin"), "https://averywhitted.com");
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

test("cancel: frees the time, removes the calendar event, refunds in full automatically, emails both", async () => {
  const { id, b, t, slots } = await confirmedBooking();
  const eventUrl = row(id).calendar_event_url;
  const pi = row(id).stripe_payment_intent_id;
  assert.ok(world.state.calendarEvents.has(eventUrl));
  const r = await api.call("POST", "/api/manage/cancel", { body: { b, t } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = row(id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancel_reason, "client_cancelled");
  assert.equal(claims(id), 0);
  assert.ok(!world.state.calendarEvents.has(eventUrl), "removed from the Coaching calendar");
  assert.equal(after.calendar_event_url, null, "recorded as removed");
  assert.ok((await openSlots()).includes(slots[0]), "time is bookable again");

  assert.equal(world.state.refunds.length, 1, "refunded exactly once");
  assert.equal(world.state.refunds[0].payment_intent, pi, "the payment for this booking");
  assert.ok(after.refunded_at);

  const [client, admin] = world.state.emails;
  assert.match(client.subject, /^Cancelled: 1 hour session/);
  assert.match(client.text, /full refund of \$130 is on its way/);
  const ics = Buffer.from(client.attachments[0].content, "base64").toString();
  assert.match(ics, /METHOD:CANCEL/);
  assert.match(ics, /SEQUENCE:1/);
  assert.match(ics, new RegExp(`UID:${row(id).ics_uid}`));
  assert.match(admin.subject, /\(refunded \$130\)$/);
  assert.match(admin.text, /Refunded \$130 automatically/);
  assert.match(admin.html, /dashboard\.stripe\.com\/test\/payments\/pi_/);
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: { b, t } })).status, 409, "can't cancel twice");
  await api.cron();
  assert.equal(world.state.refunds.length, 1, "never refunded a second time");
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

test("free intro chat can be cancelled, with no refund wording", async () => {
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
  assert.match(conf.html, /Bundle session \(3 sessions left\)/);
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

/* ── Bundle: links back, use-by on reschedule, cancelling the whole bundle ── */

async function bundleSession(p: string, t: string, slot: string) {
  const r = await api.call("POST", "/api/packages/book", { body: { p, t, start: slot } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const m = r.data.manageUrl.match(/b=([^&]+)&t=([^&]+)/);
  return { id: r.data.bookingId as string, b: m[1] as string, t: m[2] as string };
}

test("bundle sessions link back to the bundle; regular bookings don't", async () => {
  const { p, t } = await paidBundle();
  const [slot] = await openSlots("coaching-60");
  const s = await bundleSession(p, t, slot);
  const v = await api.call("GET", `/api/manage?b=${s.b}&t=${s.t}`);
  assert.match(v.data.bundleUrl, new RegExp(`/book/package/\\?p=${p}&t=${t}`));
  assert.ok(v.data.bundleExpiresAt);
  world.state.emails.length = 0;
  const plain = await confirmedBooking("coaching-30", 6);
  assert.equal((await api.call("GET", `/api/manage?b=${plain.b}&t=${plain.t}`)).data.bundleUrl, null);
});

test("a bundle session can't be rescheduled past the bundle's use-by date", async () => {
  const { id, p, t } = await paidBundle();
  const slots = await openSlots("coaching-60");
  const s = await bundleSession(p, t, slots[0]);
  db.prepare("UPDATE packages SET expires_at = ? WHERE id = ?").run(new Date(Date.parse(slots.at(-1)!) - 60000).toISOString(), id);
  const r = await api.call("POST", "/api/manage/reschedule", { body: { b: s.b, t: s.t, start: slots.at(-1) } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /use-by/);
});

test("cancel a whole bundle: used sessions charged at full price, the rest refunded; close sessions kept; emails both", async () => {
  const { id, p, t, pkg } = await paidBundle(); // 4 sessions for $440; one session alone is $130
  const slots = await openSlots("coaching-60");
  const done = await bundleSession(p, t, slots[0]);
  const soon = await bundleSession(p, t, slots[6]);
  const later = await bundleSession(p, t, slots[12]);
  const now = Date.now();
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(now - 3 * DAY).toISOString(), new Date(now - 3 * DAY + 3600000).toISOString(), done.id);
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(now + 5 * 3600000).toISOString(), new Date(now + 6 * 3600000).toISOString(), soon.id);
  world.state.emails.length = 0;

  const quote = (await api.call("GET", `/api/packages?p=${p}&t=${t}`)).data.cancelQuote;
  assert.equal(quote.used, 2, "the past session and the one within 24 hours");
  assert.equal(quote.refundCents, 18000, "$440 paid minus 2 used x $130");
  assert.equal(quote.cancelSessions.length, 1);

  const r = await api.call("POST", "/api/packages/cancel", { body: { p, t } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(pkg().status, "cancelled");
  assert.equal(pkg().refund_due_cents, 18000);
  assert.equal(row(later.id).status, "cancelled");
  assert.equal(row(later.id).cancel_reason, "bundle_cancelled");
  assert.equal(claims(later.id), 0);
  assert.ok(!world.state.calendarEvents.has(row(later.id).calendar_event_url), "removed from the Coaching calendar");
  assert.equal(row(soon.id).status, "confirmed", "within 24 hours: still on");
  const client = world.state.emails.find((e) => /^Your bundle is cancelled/.test(e.subject))!;
  assert.match(client.subject, /\$180 refund on the way/);
  assert.match(client.html, /being processed/);
  const admin = world.state.emails.find((e) => /^Bundle cancelled: Jamie Rivera \(refund \$180\)/.test(e.subject))!;
  assert.match(admin.html, /Refunded \$180 automatically/);
  const pi = pkg().stripe_payment_intent_id;
  assert.equal(refundsFor(pi), 1, "refunded automatically");
  assert.equal(Number(world.state.refunds.find((x) => x.payment_intent === pi)!.amount), 18000);
  assert.ok(pkg().refunded_at);
  assert.equal((await api.call("POST", "/api/packages/cancel", { body: { p, t } })).status, 409, "only once");
  const v = await api.call("GET", `/api/packages?p=${p}&t=${t}`);
  assert.equal(v.data.status, "cancelled");
  assert.equal(v.data.refundDueCents, 18000);
});

test("cancel bundle: free sessions Avery added aren't refunded; expired bundles can't be cancelled; refunds get marked", async () => {
  adminEnv();
  const a = await paidBundle("bundle-2"); // $230, nothing used yet
  await api.call("POST", `/api/admin/packages/${a.id}/credits`, { headers: asAdmin(), body: { delta: 1, note: "makeup" } });
  const q = (await api.call("GET", `/api/packages?p=${a.p}&t=${a.t}`)).data.cancelQuote;
  assert.equal(q.refundCents, 23000, "the two paid sessions, not the free one");
  await api.call("POST", "/api/packages/cancel", { body: { p: a.p, t: a.t } });
  await api.webhook("charge.refunded", { payment_intent: a.pkg().stripe_payment_intent_id, amount_refunded: 23000, refunded: true });
  assert.ok(a.pkg().refunded_at);
  const overview = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  const listed = overview.data.packages.find((x: any) => x.id === a.id);
  assert.equal(listed.cancelled, true);
  assert.equal(listed.refunded, true);

  const b = await paidBundle("bundle-3");
  db.prepare("UPDATE packages SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), b.id);
  assert.equal((await api.call("POST", "/api/packages/cancel", { body: { p: b.p, t: b.t } })).status, 409);
});

test("cancel bundle: a refund Stripe refuses is retried, then flagged; never sent twice", async () => {
  adminEnv();
  const a = await paidBundle("bundle-2");
  const pi = a.pkg().stripe_payment_intent_id;
  world.state.refundFailNext = 1;
  world.state.emails.length = 0;
  await api.call("POST", "/api/packages/cancel", { body: { p: a.p, t: a.t } });
  assert.equal(refundsFor(pi), 0);
  assert.equal(a.pkg().refund_attempts, 1);
  assert.match(world.state.emails.find((e) => /^Bundle cancelled:/.test(e.subject))!.html, /gone through yet/);
  db.prepare("UPDATE packages SET cancelled_at = ? WHERE id = ?").run(new Date(Date.now() - 10 * 60000).toISOString(), a.id);
  await api.cron();
  assert.equal(refundsFor(pi), 1, "retried");
  assert.ok(a.pkg().refunded_at);
  await api.cron();
  assert.equal(refundsFor(pi), 1, "only once");

  // Still failing after an hour of tries: Avery is alerted.
  const b = await paidBundle("bundle-3");
  await api.call("POST", "/api/packages/cancel", { body: { p: b.p, t: b.t } }); // refunds fine
  db.prepare("UPDATE packages SET refunded_at = NULL, refund_attempts = 12, cancelled_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), b.id);
  db.prepare("DELETE FROM alerts_sent").run();
  world.state.emails.length = 0;
  await api.cron();
  assert.ok(world.state.emails.some((e) => /need/.test(e.subject) && /automatic bundle refund/.test(e.text)));
});

test("cancel bundle: the refund never goes below zero", async () => {
  const { p, t } = await paidBundle("bundle-2"); // $230; two sessions alone would be $260
  const slots = await openSlots("coaching-60");
  const a = await bundleSession(p, t, slots[0]);
  const b = await bundleSession(p, t, slots[6]);
  const now = Date.now();
  for (const [bk, hoursAgo] of [[a, 72], [b, 48]] as const) {
    db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(now - hoursAgo * 3600000).toISOString(), new Date(now - hoursAgo * 3600000 + 3600000).toISOString(), bk.id);
  }
  const q = (await api.call("GET", `/api/packages?p=${p}&t=${t}`)).data.cancelQuote;
  assert.equal(q.used, 2);
  assert.equal(q.refundCents, 0);
});

/* ── Edge cases ── */

test("a 100%-off promo code still confirms the booking (Stripe says 'no payment required')", async () => {
  const [slot] = await openSlots("coaching-60");
  const res = await book("coaching-60", slot);
  const s = sessionFor(res.data.bookingId);
  assert.equal(s._form.payment_method_types["0"], "card", "cards only (includes Apple Pay and Google Pay)");
  await api.webhook("checkout.session.completed", { ...s, status: "complete", payment_status: "no_payment_required", amount_total: 0, payment_intent: null });
  assert.equal(row(res.data.bookingId).status, "confirmed");
  assert.equal(row(res.data.bookingId).amount_cents, 0);
});

test("abandoned bundle checkout: one reminder, not if they bought one since", async () => {
  const first = await buyBundle("bundle-4");
  await api.webhook("checkout.session.expired", { ...first.session, status: "expired" });
  await api.cron();
  await api.cron();
  const reminders = () => world.state.emails.filter((e) => e.subject === "Your bundle isn't finished yet");
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0].html, /book\/\?service=bundle-4/);

  const again = await buyBundle("bundle-2", { email: "kim@example.com" });
  await api.webhook("checkout.session.expired", { ...again.session, status: "expired" });
  await buyBundle("bundle-3", { email: "kim@example.com" }); // they came back and started another
  await api.cron();
  assert.equal(reminders().filter((e) => e.to[0] === "kim@example.com").length, 0);
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

/* ── Refund safety: nobody can be refunded and keep the session ── */

const refundsFor = (pi: string) => world.state.refunds.filter((r) => r.payment_intent === pi).length;

test("refund safety: two cancellations at the same moment make one cancellation and one refund", async () => {
  const { id, b, t } = await confirmedBooking();
  const pi = row(id).stripe_payment_intent_id;
  const results = await Promise.all([1, 2, 3].map(() => api.call("POST", "/api/manage/cancel", { body: { b, t } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(refundsFor(pi), 1);
  assert.equal(world.state.emails.filter((e) => /^Cancelled:/.test(e.subject) && e.to[0] === "jamie@example.com").length, 1, "one client email");
});

test("refund safety: a cancellation racing a reschedule never puts the session back", async () => {
  const { id, b, t, slots } = await confirmedBooking();
  const [cancel, move] = await Promise.all([
    api.call("POST", "/api/manage/cancel", { body: { b, t } }),
    api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots.at(-1) } }),
  ]);
  assert.equal(cancel.status, 200);
  assert.equal(move.status, 409, JSON.stringify(move.data));
  const after = row(id);
  assert.equal(after.status, "cancelled");
  assert.equal(claims(id), 0, "holds no time");
  assert.equal(world.state.calendarEvents.size, 0, "nothing left on the Coaching calendar");
  assert.equal(refundsFor(after.stripe_payment_intent_id), 1);
  assert.ok(!world.state.emails.some((e) => /^Rescheduled/.test(e.subject)), "no 'rescheduled' emails");
});

test("refund safety: the database refuses to reactivate a refunded booking or give it time", async () => {
  const { id, b, t, slots } = await confirmedBooking();
  const s = world.state.stripeSessions.get(row(id).stripe_checkout_session_id)!;
  await api.call("POST", "/api/manage/cancel", { body: { b, t } });
  assert.ok(row(id).refunded_at);
  assert.throws(() => db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(id), /refunded booking cannot be active/);
  assert.throws(() => db.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES ('2030-01-01T15:00:00Z', ?)").run(id), /only active bookings/);
  // A repeat "payment completed" notice from Stripe changes nothing.
  assert.equal((await api.webhook("checkout.session.completed", paid(s), { id: "evt_late_repeat" })).status, 200);
  assert.equal(row(id).status, "cancelled");
  // Nor can it be moved or cancelled again.
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { b, t, start: slots.at(-1) } })).status, 409);
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: { b, t } })).status, 409);
  const view = await api.call("GET", `/api/manage?b=${b}&t=${t}`);
  assert.equal(view.data.status, "cancelled");
  assert.equal(view.data.zoomUrl, null, "no Zoom link shown");
  assert.equal(refundsFor(row(id).stripe_payment_intent_id), 1);
});

test("refund safety: if Stripe refuses the refund, it retries, Avery is alerted, and the session stays cancelled", async () => {
  const { id, b, t } = await confirmedBooking();
  world.state.refundFailNext = 2; // the first try and the first retry fail
  await api.call("POST", "/api/manage/cancel", { body: { b, t } });
  let after = row(id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.refunded_at, null);
  assert.ok(after.refund_requested_at);
  const admin = world.state.emails.find((e) => /^Cancelled: Jamie Rivera/.test(e.subject))!;
  assert.match(admin.subject, /\(refund pending \$130\)$/);
  // 15 minutes on and the retry fails too: Avery hears about it.
  db.prepare("UPDATE bookings SET refund_requested_at = ?, updated_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60000).toISOString(), new Date(Date.now() - 20 * 60000).toISOString(), id);
  await api.cron();
  const alert = world.state.emails.find((e) => /^Booking system: /.test(e.subject));
  assert.ok(alert, "alert sent");
  assert.match(alert!.text, /automatic refund of \$130\.00 to Jamie Rivera hasn't gone through/);
  await api.cron();
  after = row(id);
  assert.ok(after.refunded_at, "went through on a later try");
  assert.equal(refundsFor(after.stripe_payment_intent_id), 1);
  assert.equal(after.status, "cancelled");
});

test("refund safety: if the calendar event can't be removed, Avery is told and cron keeps trying", async () => {
  const { id, b, t } = await confirmedBooking();
  const eventUrl = row(id).calendar_event_url;
  world.state.calendarDeleteFailNext = 1;
  await api.call("POST", "/api/manage/cancel", { body: { b, t } });
  assert.ok(world.state.calendarEvents.has(eventUrl), "still there after the failure");
  assert.equal(row(id).calendar_event_url, eventUrl, "remembered so it can be retried");
  const admin = world.state.emails.find((e) => /^Cancelled: Jamie Rivera/.test(e.subject))!;
  assert.match(admin.text, /couldn't be removed from your Coaching calendar/);
  assert.doesNotMatch(admin.html, /The event has been removed/);
  db.prepare("UPDATE bookings SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 60000).toISOString(), id);
  await api.cron();
  assert.ok(!world.state.calendarEvents.has(eventUrl), "removed on retry");
  assert.equal(row(id).calendar_event_url, null);
});

test("refund safety: when Avery cancels, the refund is Avery's choice and shows until it's done", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const pi = row(id).stripe_payment_intent_id;
  const r = await api.call("POST", `/api/admin/bookings/${id}/cancel`, { headers: asAdmin(), body: { notifyClient: true, refund: false } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(refundsFor(pi), 0, "not refunded without Avery choosing to");
  const client = world.state.emails.find((e) => /^Cancelled:/.test(e.subject))!;
  assert.match(client.text, /either have a full refund or schedule a new time at no charge/);
  let overview = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  assert.equal(overview.data.bookings.find((x: any) => x.id === id).refundOwed, "choice");
  const refund = await api.call("POST", `/api/admin/bookings/${id}/refund`, { headers: asAdmin() });
  assert.equal(refund.status, 200);
  assert.equal(refundsFor(pi), 1);
  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/refund`, { headers: asAdmin() })).status, 409, "only once");
  overview = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  assert.equal(overview.data.bookings.find((x: any) => x.id === id).refundOwed, null);
  assert.equal(refundsFor(pi), 1);

  const second = await confirmedBooking("coaching-30", 6);
  const r2 = await api.call("POST", `/api/admin/bookings/${second.id}/cancel`, { headers: asAdmin(), body: { notifyClient: true, refund: true } });
  assert.equal(r2.status, 200);
  assert.equal(refundsFor(row(second.id).stripe_payment_intent_id), 1, "refunded right away when chosen");
  assert.match(world.state.emails.find((e) => /^Cancelled: 30 minute/.test(e.subject))!.text, /full refund of \$75 is on its way/);
});

test("after Avery cancels a paid session, the student chooses a new time (no charge) or a full refund, once", async () => {
  adminEnv();
  const one = await confirmedBooking("coaching-60", 0);
  const pi = row(one.id).stripe_payment_intent_id;
  await api.call("POST", `/api/admin/bookings/${one.id}/cancel`, { headers: asAdmin(), body: { notifyClient: true, refund: false } });
  const email = world.state.emails.find((e) => /^Cancelled:/.test(e.subject))!;
  assert.match(email.text, /Choose a new time or refund: .*book\/manage\/\?b=/, "the button goes to their session page");
  let view = await api.call("GET", `/api/manage?b=${one.b}&t=${one.t}`);
  assert.equal(view.data.cancelOffer, true);
  assert.equal(view.data.canRequestRefund, false, "no separate request link while they can choose");

  // A new time, no charge.
  const newSlot = one.slots.at(-1)!;
  world.state.emails.length = 0;
  const rebook = await api.call("POST", "/api/manage/rebook", { body: { b: one.b, t: one.t, start: newSlot } });
  assert.equal(rebook.status, 200, JSON.stringify(rebook.data));
  const back = row(one.id);
  assert.equal(back.status, "confirmed");
  assert.equal(back.start_utc, newSlot.replace(/\.000Z$/, "Z"));
  assert.equal(refundsFor(pi), 0);
  assert.ok(!(await openSlots()).includes(newSlot), "the new time is taken");
  assert.equal((await api.call("POST", "/api/manage/refund", { body: { b: one.b, t: one.t } })).status, 409, "no refund once rebooked");
  assert.equal((await api.call("POST", "/api/manage/rebook", { body: { b: one.b, t: one.t, start: one.slots[1] } })).status, 409, "only once");

  // Or a full refund.
  world.state.emails.length = 0;
  const two = await confirmedBooking("coaching-30", 6);
  const pi2 = row(two.id).stripe_payment_intent_id;
  await api.call("POST", `/api/admin/bookings/${two.id}/cancel`, { headers: asAdmin(), body: { notifyClient: true, refund: false } });
  const ref = await api.call("POST", "/api/manage/refund", { body: { b: two.b, t: two.t } });
  assert.equal(ref.status, 200, JSON.stringify(ref.data));
  assert.equal(refundsFor(pi2), 1);
  assert.equal((await api.call("POST", "/api/manage/refund", { body: { b: two.b, t: two.t } })).status, 409, "only once");
  assert.equal((await api.call("POST", "/api/manage/rebook", { body: { b: two.b, t: two.t, start: two.slots[2] } })).status, 409, "no new time once refunded");
  assert.equal(refundsFor(pi2), 1);
  view = await api.call("GET", `/api/manage?b=${two.b}&t=${two.t}`);
  assert.equal(view.data.cancelOffer, false);
});

test("payment requests: Avery asks for payment for a session; it can be paid once, and a withdrawn one is refunded", async () => {
  adminEnv();
  const r = await adminBook({ time: "10:00", students: [student("Owes Me", "owes@example.com", { priceCents: 9000 })] });
  const id = r.data.bookingId;
  endSession(id); // it happened, unpaid, with no deadline
  const invite = linkIn(world.state.emails.find((e) => e.to[0] === "owes@example.com")!.text);

  // Unpaid with no deadline: still payable after the session.
  const late = await api.call("POST", "/api/pay", { body: invite });
  assert.equal(late.status, 200, JSON.stringify(late.data));

  world.state.emails.length = 0;
  const bad = await api.call("POST", "/api/admin/payment-requests", { headers: asAdmin(), body: { bookingId: id, amountCents: 10 } });
  assert.equal(bad.status, 400, "at least $0.50");
  const made = await api.call("POST", "/api/admin/payment-requests", { headers: asAdmin(), body: { bookingId: id, amountCents: 4000, note: "For the extra half hour." } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal((await api.call("POST", "/api/admin/payment-requests", { headers: asAdmin(), body: { bookingId: id, amountCents: 4000 } })).status, 409, "one open request per session");
  const email = world.state.emails.find((e) => /^Payment request: \$40/.test(e.subject))!;
  assert.match(email.text, /Note:\nFor the extra half hour\./);
  assert.match(email.text, /payreq=/);
  const overview = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  assert.equal(overview.data.problems.paymentRequests.length, 1);

  const view = await api.call("GET", `/api/manage?b=${invite.b}&t=${invite.t}`);
  assert.equal(view.data.paymentRequests[0].status, "open");
  const reqId = view.data.paymentRequests[0].id;
  assert.equal((await api.call("POST", "/api/pay-request", { body: { ...invite, r: "nope" } })).status, 404);
  const pay = await api.call("POST", "/api/pay-request", { body: { ...invite, r: reqId } });
  assert.equal(pay.status, 200);
  const cs = [...world.state.stripeSessions.values()].find((x: any) => x.metadata.request_id === reqId)!;
  await api.webhook("checkout.session.completed", paid(cs));
  assert.equal((db.prepare("SELECT status, paid_cents FROM payment_requests WHERE id = ?").get(reqId) as any).status, "paid");
  assert.ok(world.state.emails.some((e) => e.subject === "Payment received: $40" && e.to[0] === "owes@example.com"));
  // A second completed checkout for the same request is refunded.
  await api.webhook("checkout.session.completed", { ...paid(cs), payment_intent: "pi_second" }, { id: "evt_second_request" });
  assert.equal(refundsFor("pi_second"), 1);
  assert.equal((await api.call("POST", "/api/pay-request", { body: { ...invite, r: reqId } })).status, 409, "already paid");

  // Withdrawn, then paid anyway through an old page: refunded.
  const again = await api.call("POST", "/api/admin/payment-requests", { headers: asAdmin(), body: { bookingId: id, amountCents: 2500 } });
  const payAgain = await api.call("POST", "/api/pay-request", { body: { ...invite, r: again.data.id } });
  assert.equal(payAgain.status, 200);
  const cs2 = [...world.state.stripeSessions.values()].find((x: any) => x.metadata.request_id === again.data.id)!;
  assert.equal((await api.call("POST", `/api/admin/payment-requests/${again.data.id}/cancel`, { headers: asAdmin() })).status, 200);
  await api.webhook("checkout.session.completed", paid(cs2), { id: "evt_withdrawn" });
  assert.equal(refundsFor(`pi_${cs2.id}`), 1);
  assert.equal((db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(again.data.id) as any).status, "cancelled");
});

test("refund safety: paid after the hold ran out and the time was taken, refund fails first: retried, never lost", async () => {
  const [slot] = await openSlots();
  const late = await book("coaching-60", slot);
  const s = sessionFor(late.data.bookingId);
  await api.webhook("checkout.session.expired", s);
  assert.equal((await book("coaching-60", slot, { email: "fast@example.com" })).status, 201);
  world.state.refundFailNext = 1;
  assert.equal((await api.webhook("checkout.session.completed", paid(s))).status, 200);
  let b = row(late.data.bookingId);
  assert.equal(b.cancel_reason, "slot_taken_after_payment");
  assert.equal(b.refunded_at, null);
  assert.ok(b.refund_requested_at);
  assert.ok(world.state.emails.some((e) => e.subject === "About your booking: you've been refunded"), "client still told");
  // Stripe sends the same notice again: no duplicate emails, no double refund.
  await api.webhook("checkout.session.completed", paid(s), { id: "evt_again" });
  db.prepare("UPDATE bookings SET refund_requested_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 60000).toISOString(), b.id);
  await api.cron();
  b = row(b.id);
  assert.ok(b.refunded_at);
  assert.equal(refundsFor(b.stripe_payment_intent_id), 1);
  assert.equal(world.state.emails.filter((e) => e.subject === "About your booking: you've been refunded").length, 1);
});

test("bundle safety: cancelling a bundle session twice at once returns one credit", async () => {
  const { pkg, p, t } = await paidBundle();
  const [slot] = await openSlots("coaching-60");
  const s = await bundleSession(p, t, slot);
  assert.equal(pkg().credits_used, 1);
  const results = await Promise.all([1, 2].map(() => api.call("POST", "/api/manage/cancel", { body: { b: s.b, t: s.t } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(pkg().credits_used, 0, "one credit back, not two");
  assert.equal(world.state.refunds.length, 0, "bundle sessions are never refunded individually");
});

test("bundle safety: Avery double-clicking cancel returns one credit", async () => {
  adminEnv();
  const { pkg, p, t } = await paidBundle();
  const [slot] = await openSlots("coaching-60");
  const s = await bundleSession(p, t, slot);
  const results = await Promise.all([1, 2].map(() =>
    api.call("POST", `/api/admin/bookings/${s.id}/cancel`, { headers: asAdmin(), body: { notifyClient: false, returnCredit: true } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(pkg().credits_used, 0);
});

test("bundle safety: a late payment notice never brings back a bundle the client cancelled", async () => {
  const { pkg, p, t, session } = await paidBundle();
  assert.equal((await api.call("POST", "/api/packages/cancel", { body: { p, t } })).status, 200);
  await api.webhook("checkout.session.completed", paid(session), { id: "evt_bundle_again" });
  assert.equal(pkg().status, "cancelled");
  const [slot] = await openSlots("coaching-60");
  assert.equal((await api.call("POST", "/api/packages/book", { body: { p, t, start: slot } })).status, 409, "can't book from it");
});

/* ── Other audit fixes ── */

test("intro chats: at most two per internet connection per day", async () => {
  const slots = await openSlots("intro-15");
  assert.equal((await book("intro-15", slots[0], { material: "", email: "a@example.com" })).status, 201);
  assert.equal((await book("intro-15", slots[4], { material: "", email: "b@example.com" })).status, 201);
  const third = await book("intro-15", slots[8], { material: "", email: "c@example.com" });
  assert.equal(third.status, 429);
});

test("a later booking with the same email doesn't rename earlier ones", async () => {
  const { id } = await confirmedBooking();
  const [slot] = await openSlots("intro-15", 5);
  assert.equal((await book("intro-15", slot, { material: "", name: "Someone Else", pronouns: "" })).status, 201);
  const { loadBooking } = await import("../src/bookings");
  const first = await loadBooking(env, "id", id);
  assert.equal(first!.name, "Jamie Rivera");
  assert.equal(first!.pronouns, "they/them");
});

test("a live Stripe key always means live-only access, even with a test site address left behind", async () => {
  env.SITE_URL = "http://localhost:8743";
  const origin = (o: string) => api.call("GET", "/api/services", { headers: { Origin: o } }).then((r) => r.headers.get("access-control-allow-origin"));
  assert.equal(await origin("http://localhost:8743"), "http://localhost:8743", "test mode");
  env.STRIPE_SECRET_KEY = "rk_live_example";
  assert.equal(await origin("http://localhost:8743"), null, "live key: local pages refused");
  assert.equal(await origin("https://averywhitted.com"), "https://averywhitted.com");
});

test("availability only looks up dates from today to a year out", async () => {
  const far = etDate(Date.now() + 400 * DAY);
  assert.equal((await api.call("GET", `/api/availability?service=coaching-60&from=${far}`)).status, 400);
  assert.equal((await api.call("GET", "/api/availability?service=coaching-60&from=2001-01-01")).status, 400);
  assert.equal((await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.now() + 300 * DAY)}`)).status, 200);
});

test("webhook: a malformed timestamp is rejected", async () => {
  const payload = JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: { object: {} } });
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET!).update(`abc.${payload}`).digest("hex");
  const r = await api.call("POST", "/api/stripe/webhook", { raw: payload, headers: { "Stripe-Signature": `t=abc,v1=${sig}` } });
  assert.equal(r.status, 400);
});

test("email heading images: built-in object names aren't served", async () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.equal((await api.call("GET", `/email/h/${name}`)).status, 404);
  }
});

test("iCloud: the calendar list is remembered between lookups instead of re-fetched each time", async () => {
  await openSlots();
  const propfinds = () => world.state.requests.filter((r) => r.startsWith("PROPFIND")).length;
  const before = propfinds();
  await api.call("GET", `/api/availability?service=coaching-30&from=${etDate(Date.now() + 5 * DAY)}&days=1`);
  assert.equal(propfinds(), before, "no new discovery requests");
});

test("calendar invites: a name with a colon or quotes stays one name", async () => {
  const ics = buildIcs({ uid: "x@y", sequence: 0, start: Date.UTC(2030, 0, 1, 15), end: Date.UTC(2030, 0, 1, 16), summary: "S",
    attendee: { name: 'Dr: "Kim", Jr.', email: "kim@example.com" } });
  assert.match(ics, /ATTENDEE;CN="Dr: Kim, Jr\.";ROLE=/);
});

/* ── Sessions Avery books for students ── */

const nyDate = (daysAhead: number) => etDate(Date.now() + daysAhead * DAY);
function adminBook(body: Record<string, unknown>) {
  return api.call("POST", "/api/admin/sessions", {
    headers: asAdmin(),
    body: { serviceId: "coaching-60", date: nyDate(4), time: "14:00", payBy: "none", ...body },
  });
}
const student = (name: string, email: string, extra: Record<string, unknown> = {}) => ({ name, email, ...extra });
const inviteFor = (email: string) => world.state.emails.find((e) => e.to[0] === email && /^(Session booked|You're booked)/.test(e.subject))!;
const linkIn = (text: string) => {
  const m = text.match(/book\/manage\/\?b=([0-9a-f-]{36})&t=([\w-]{32})/);
  assert.ok(m, "email has a manage link");
  return { b: m![1], t: m![2] };
};
const bookingByEmail = (email: string) => db.prepare(
  "SELECT b.* FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE c.email = ? ORDER BY b.created_at DESC LIMIT 1").get(email) as any;

test("book a student: time reserved, invite has a pay link, paying marks it paid", async () => {
  adminEnv();
  assert.equal((await api.call("POST", "/api/admin/sessions", { body: {} })).status, 403, "admin only");
  const r = await adminBook({ students: [student("Riley Park", "riley@example.com", { priceCents: 9000 })], message: "Bring the Chekhov sides." });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row0 = row(r.data.bookingId);
  assert.equal(row0.status, "confirmed");
  assert.equal(row0.created_by, "admin");
  assert.equal(row0.price_cents, 9000);
  assert.equal(row0.amount_cents, 0);
  assert.equal(claims(row0.id), 4, "just the hour, no buffer");
  assert.ok(row0.calendar_event_url, "on the Coaching calendar");
  assert.match(world.state.calendarEvents.get(row0.calendar_event_url)!, /Not paid yet: 90\.00 USD due/);

  const invite = inviteFor("riley@example.com");
  assert.match(invite.subject, /^Session booked, payment due: 1 hour session/);
  assert.match(invite.text, /Bring the Chekhov sides\./);
  assert.match(invite.text, /Please pay \$90 before your session/);
  assert.match(invite.text, /&pay=1/);
  assert.ok(!world.state.emails.some((e) => /^New booking/.test(e.subject)), "Avery isn't emailed about her own booking");
  const { b, t } = linkIn(invite.text);

  const view = await api.call("GET", `/api/manage?b=${b}&t=${t}`);
  assert.equal(view.data.payment.dueCents, 9000);
  const pay = await api.call("POST", "/api/pay", { body: { b, t } });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  const s = world.state.stripeSessions.get(row(row0.id).stripe_checkout_session_id)!;
  assert.equal(s.amount_total, 9000);
  assert.equal(s.metadata.purpose, "payment");
  assert.equal((await api.call("POST", "/api/pay", { body: { b, t } })).data.checkoutUrl, pay.data.checkoutUrl, "same checkout reused");

  await api.webhook("checkout.session.completed", paid(s));
  const after = row(row0.id);
  assert.ok(after.paid_at);
  assert.equal(after.amount_cents, 9000);
  assert.equal(after.status, "confirmed");
  assert.ok(world.state.emails.some((e) => e.subject.startsWith("Payment received: 1 hour session") && e.to[0] === "riley@example.com"));
  assert.ok(world.state.emails.some((e) => e.subject.startsWith("Payment received: Riley Park, $90")));
  assert.match(world.state.calendarEvents.get(after.calendar_event_url)!, /Paid 90\.00 USD/);
  assert.equal((await api.call("POST", "/api/pay", { body: { b, t } })).status, 409, "nothing left to pay");
  assert.equal((await api.call("GET", `/api/manage?b=${b}&t=${t}`)).data.payment, null);
});

test("book a student: a free session has no pay link; overlapping another booking is refused", async () => {
  adminEnv();
  const r = await adminBook({ students: [student("Free Student", "free@example.com", { priceCents: 0 })] });
  assert.equal(r.status, 201);
  const invite = inviteFor("free@example.com");
  assert.match(invite.subject, /^You're booked/);
  assert.doesNotMatch(invite.text, /pay=1|Please pay/);
  const clash = await adminBook({ time: "14:30", students: [student("Other", "other@example.com")] });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /overlaps another booking/);
  const backToBack = await adminBook({ time: "15:00", students: [student("Next", "next@example.com")] });
  assert.equal(backToBack.status, 201, "Avery can book back to back");
});

test("book a student: prices under Stripe's $0.50 minimum are refused (free is fine)", async () => {
  adminEnv();
  const tiny = await adminBook({ students: [student("Tiny", "tiny@example.com", { priceCents: 1 })] });
  assert.equal(tiny.status, 400);
  assert.match(tiny.data.error, /\$0\.50/);
  assert.equal((await adminBook({ time: "15:00", students: [student("Fifty", "fifty@example.com", { priceCents: 50 })] })).status, 201);
  assert.equal((await adminBook({ time: "17:00", students: [student("Free", "free@example.com", { priceCents: 0 })] })).status, 201);
});

test("book a student: pay-by deadline releases unpaid sessions automatically; a deadline that's too soon is refused", async () => {
  adminEnv();
  const soonAt = Math.ceil((Date.now() + 5 * 3600000) / 900000) * 900000; // 5 hours from now, on a quarter hour
  const soonTime = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(soonAt);
  const soon = await adminBook({ date: etDate(soonAt), time: soonTime, payBy: "before24", students: [student("A", "a@example.com")] });
  assert.equal(soon.status, 400, "24 hours before a session that's sooner than that");
  const r = await adminBook({ payBy: "after24", students: [student("Late Payer", "late@example.com")] });
  assert.equal(r.status, 201);
  const id = r.data.bookingId;
  const eventUrl = row(id).calendar_event_url;
  assert.ok(row(id).pay_by);
  assert.match(inviteFor("late@example.com").text, /Paying by then confirms your session; after that, the time will be opened up to other students/);
  await api.call("POST", "/api/pay", { body: linkIn(inviteFor("late@example.com").text) });
  db.prepare("UPDATE bookings SET pay_by = ? WHERE id = ?").run(new Date(Date.now() - 60000).toISOString(), id);
  await api.cron();
  const after = row(id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancel_reason, "unpaid");
  assert.equal(claims(id), 0, "time freed");
  assert.ok(!world.state.calendarEvents.has(eventUrl), "off the calendar");
  assert.equal(world.state.stripeSessions.get(after.stripe_checkout_session_id)!.status, "expired", "payment page closed");
  assert.ok(world.state.emails.some((e) => e.to[0] === "late@example.com" && /^Cancelled: /.test(e.subject)));
  assert.ok(world.state.emails.some((e) => /^Released \(unpaid\): Late Payer/.test(e.subject)));
});

test("payment reminder: one, a day before the deadline", async () => {
  adminEnv();
  const r = await adminBook({ payBy: "after48", students: [student("Rem Inder", "rem@example.com")] });
  const id = r.data.bookingId;
  db.prepare("UPDATE bookings SET created_at = ?, pay_by = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 3600000).toISOString(), new Date(Date.now() + 20 * 3600000).toISOString(), id);
  await api.cron();
  await api.cron();
  const reminders = world.state.emails.filter((e) => /^Payment due: /.test(e.subject));
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].text, /pay=1/);
});

test("group session: one time, own prices and links; leaving keeps it going; last one out frees the time", async () => {
  adminEnv();
  const r = await adminBook({
    students: [
      student("Ana Lee", "ana@example.com", { priceCents: 5000 }),
      student("Ben Ortiz", "ben@example.com", { priceCents: 0 }),
      student("Cam Diaz", "cam@example.com", { priceCents: 7500 }),
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const g = db.prepare("SELECT * FROM groups WHERE id = ?").get(r.data.groupId) as any;
  assert.equal(g.status, "active");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slot_claims WHERE group_id = ?").get(g.id) as any).n, 4);
  assert.equal(world.state.calendarEvents.size, 1, "one calendar event for the group");
  const event = world.state.calendarEvents.get(g.calendar_event_url)!.replace(/\r\n[ \t]/g, "");
  assert.match(event, /SUMMARY:Group coaching: Ana\\, Ben\\, Cam \(1 hour\)/);
  assert.match(event, /Ana Lee\\, ana@example.com: \$50\.00 due/);
  assert.match(event, /Ben Ortiz\\, ben@example.com: free/);

  const ana = inviteFor("ana@example.com");
  assert.match(ana.text, /group coaching session/);
  assert.match(ana.text, /Please pay \$50/);
  assert.doesNotMatch(inviteFor("ben@example.com").text, /Please pay/);
  assert.doesNotMatch(ana.text + ana.html, /Ben|Cam/, "students don't see each other's details");
  const start = row(bookingByEmail("ana@example.com").id).start_utc;
  assert.ok(!(await openSlots("coaching-60", 4)).includes(start), "time isn't offered to others");

  const a = linkIn(ana.text);
  const view = await api.call("GET", `/api/manage?b=${a.b}&t=${a.t}`);
  assert.equal(view.data.group, true);
  assert.equal(view.data.canReschedule, false);
  assert.equal((await api.call("POST", "/api/manage/reschedule", { body: { ...a, start: new Date(Date.parse(start) + 3 * DAY).toISOString() } })).status, 403);

  assert.equal((await api.call("POST", "/api/manage/cancel", { body: a })).status, 200);
  assert.equal((db.prepare("SELECT status FROM groups WHERE id = ?").get(g.id) as any).status, "active", "goes ahead for the others");
  assert.doesNotMatch(world.state.calendarEvents.get(g.calendar_event_url)!, /Ana Lee/, "calendar event updated");

  for (const email of ["ben@example.com", "cam@example.com"]) {
    assert.equal((await api.call("POST", "/api/manage/cancel", { body: linkIn(inviteFor(email).text) })).status, 200);
  }
  assert.equal((db.prepare("SELECT status FROM groups WHERE id = ?").get(g.id) as any).status, "cancelled");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slot_claims WHERE group_id = ?").get(g.id) as any).n, 0);
  assert.equal(world.state.calendarEvents.size, 0, "removed from the calendar");
  assert.ok((await openSlots("coaching-60", 4)).includes(start), "time is bookable again");
});

test("group session: an unpaid student is released at the deadline; the session goes ahead for the rest", async () => {
  adminEnv();
  const r = await adminBook({ payBy: "after24", students: [student("Pay Er", "payer@example.com"), student("No Pay", "nopay@example.com")] });
  const payer = linkIn(inviteFor("payer@example.com").text);
  await api.call("POST", "/api/pay", { body: payer });
  await api.webhook("checkout.session.completed", paid(world.state.stripeSessions.get(row(payer.b).stripe_checkout_session_id)!));
  db.prepare("UPDATE bookings SET pay_by = ? WHERE group_id = ?").run(new Date(Date.now() - 60000).toISOString(), r.data.groupId);
  await api.cron();
  assert.equal(row(payer.b).status, "confirmed", "paid: kept");
  assert.equal(bookingByEmail("nopay@example.com").status, "cancelled");
  assert.equal((db.prepare("SELECT status FROM groups WHERE id = ?").get(r.data.groupId) as any).status, "active");
  assert.match(world.state.emails.find((e) => /^Released \(unpaid\): No Pay/.test(e.subject))!.text, /will go ahead for everyone else/);
});

test("group session: Avery moves it (everyone gets the new time) and cancels it (paid students refunded once)", async () => {
  adminEnv();
  const r = await adminBook({ students: [student("Dee One", "dee@example.com"), student("Eli Two", "eli@example.com", { priceCents: 0 })] });
  const dee = linkIn(inviteFor("dee@example.com").text);
  await api.call("POST", "/api/pay", { body: dee });
  await api.webhook("checkout.session.completed", paid(world.state.stripeSessions.get(row(dee.b).stripe_checkout_session_id)!));
  world.state.emails.length = 0;

  const move = await api.call("POST", `/api/admin/groups/${r.data.groupId}/move`, { headers: asAdmin(), body: { date: nyDate(6), time: "10:15" } });
  assert.equal(move.status, 200, JSON.stringify(move.data));
  const moved = db.prepare("SELECT * FROM groups WHERE id = ?").get(r.data.groupId) as any;
  assert.equal(moved.start_utc, move.data.start);
  assert.equal(row(dee.b).start_utc, move.data.start, "students' bookings moved too");
  assert.equal(world.state.emails.filter((e) => /^Rescheduled: /.test(e.subject)).length, 2);
  assert.equal(world.state.calendarEvents.size, 1);

  const cancel = await api.call("POST", `/api/admin/groups/${r.data.groupId}/cancel`, { headers: asAdmin(), body: { notifyClient: true, refund: true } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal((db.prepare("SELECT status FROM groups WHERE id = ?").get(r.data.groupId) as any).status, "cancelled");
  assert.equal(world.state.refunds.length, 1, "only the student who paid");
  assert.equal(world.state.calendarEvents.size, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM slot_claims WHERE group_id = ?").get(r.data.groupId) as any).n, 0);
});

test("book a student with their bundle: uses a credit, no payment; cancelling in time gives it back", async () => {
  adminEnv();
  const { pkg } = await paidBundle();
  const students = (await api.call("GET", "/api/admin/students", { headers: asAdmin() })).data;
  const jamie = students.find((s: any) => s.email === "jamie@example.com");
  assert.equal(jamie.bundles[0].remaining, 4);
  assert.equal((await adminBook({ serviceId: "coaching-30", students: [student("Jamie Rivera", "jamie@example.com", { packageId: jamie.bundles[0].id })] })).status, 400, "1 hour only");
  assert.equal((await adminBook({ students: [student("Someone", "someone@example.com", { packageId: jamie.bundles[0].id })] })).status, 400, "only its owner");
  const r = await adminBook({ students: [student("Jamie Rivera", "jamie@example.com", { packageId: jamie.bundles[0].id })] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(pkg().credits_used, 1);
  const invite = inviteFor("jamie@example.com");
  assert.doesNotMatch(invite.text, /Please pay/);
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: linkIn(invite.text) })).status, 200);
  assert.equal(pkg().credits_used, 0);
});

test("payments: paying after the session was cancelled, or paying twice, is refunded automatically", async () => {
  adminEnv();
  await adminBook({ students: [student("Pat Late", "pat@example.com")] });
  const pat = linkIn(inviteFor("pat@example.com").text);
  await api.call("POST", "/api/pay", { body: pat });
  const s1 = world.state.stripeSessions.get(row(pat.b).stripe_checkout_session_id)!;
  assert.equal((await api.call("POST", "/api/manage/cancel", { body: pat })).status, 200);
  assert.equal(s1.status, "expired", "open payment page closed on cancel");
  await api.webhook("checkout.session.completed", paid(s1));
  assert.equal(row(pat.b).status, "cancelled", "stays cancelled");
  assert.equal(world.state.refunds.filter((x) => x.payment_intent === `pi_${s1.id}`).length, 1);
  assert.ok(world.state.emails.some((e) => e.subject === "About your payment: you've been refunded"));

  await adminBook({ time: "16:00", students: [student("Twice Payer", "twice@example.com")] });
  const tw = linkIn(inviteFor("twice@example.com").text);
  await api.call("POST", "/api/pay", { body: tw });
  const first = world.state.stripeSessions.get(row(tw.b).stripe_checkout_session_id)!;
  first.expires_at = Math.floor(Date.now() / 1000) + 60; // about to expire, so a new one is made
  await api.call("POST", "/api/pay", { body: tw });
  const second = world.state.stripeSessions.get(row(tw.b).stripe_checkout_session_id)!;
  assert.notEqual(first.id, second.id);
  await api.webhook("checkout.session.completed", paid(first));
  await api.webhook("checkout.session.completed", paid(second));
  assert.equal(row(tw.b).status, "confirmed");
  assert.equal(row(tw.b).stripe_payment_intent_id, `pi_${first.id}`);
  assert.equal(world.state.refunds.filter((x) => x.payment_intent === `pi_${second.id}`).length, 1, "the second payment refunded");
});

test("check a time: warns about calendar clashes, hours and notice; flags overlaps", async () => {
  adminEnv();
  const day = nyDate(4).replace(/-/g, "");
  world.state.busy = [{ calendar: "Personal", ics: `BEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=America/New_York:${day}T150000\r\nDTEND;TZID=America/New_York:${day}T160000\r\nEND:VEVENT` }];
  const check = (time: string, extra: Record<string, unknown> = {}) =>
    api.call("POST", "/api/admin/check-time", { headers: asAdmin(), body: { serviceId: "coaching-60", date: nyDate(4), time, ...extra } }).then((r) => r.data);
  const clash = await check("14:30");
  assert.equal(clash.calendarClash.length, 1);
  assert.equal(clash.overlapsBooking, false);
  const late = await check("22:00");
  assert.equal(late.outsideHours, true);
  await adminBook({ time: "10:00", students: [student("Taken", "taken@example.com")] });
  assert.equal((await check("10:30")).overlapsBooking, true);
  const id = bookingByEmail("taken@example.com").id;
  assert.equal((await check("10:30", { movingBookingId: id })).overlapsBooking, false, "its own time doesn't count when moving it");
});

/* ── Admin tools round 2 ── */

test("Zoom link: held back until a student pays, then sent with an updated invite", async () => {
  adminEnv();
  env.ZOOM_FALLBACK_URL = "https://zoom.us/j/555";
  await adminBook({ students: [student("Zed Owes", "zed@example.com", { priceCents: 4000 })] });
  const invite = inviteFor("zed@example.com");
  assert.doesNotMatch(invite.text + invite.html, /zoom\.us\/j\/555/, "no Zoom link in the invite");
  assert.match(invite.text, /Sent once you've paid/);
  const ics = Buffer.from(invite.attachments[0].content, "base64").toString();
  assert.doesNotMatch(ics, /zoom\.us\/j\/555/, "not in the calendar file either");
  const link = linkIn(invite.text);
  assert.equal((await api.call("GET", `/api/manage?b=${link.b}&t=${link.t}`)).data.zoomUrl, null, "not on the manage page");
  assert.match(world.state.calendarEvents.get(row(link.b).calendar_event_url)!, /zoom\.us\/j\/555/, "Avery's own calendar has it");

  await api.call("POST", "/api/pay", { body: link });
  await api.webhook("checkout.session.completed", paid(world.state.stripeSessions.get(row(link.b).stripe_checkout_session_id)!));
  const receipt = world.state.emails.find((e) => /^Payment received: /.test(e.subject) && e.to[0] === "zed@example.com")!;
  assert.match(receipt.text, /zoom\.us\/j\/555/, "receipt has the Zoom link");
  const updated = Buffer.from(receipt.attachments[0].content, "base64").toString();
  assert.match(updated, /zoom\.us\/j\/555/);
  assert.match(updated, /SEQUENCE:1/, "updates the event already on their calendar");
  assert.equal((await api.call("GET", `/api/manage?b=${link.b}&t=${link.t}`)).data.zoomUrl, "https://zoom.us/j/555");
});

test("Avery cancels a bundle: all upcoming sessions cancelled, refund of her choosing sent through Stripe", async () => {
  adminEnv();
  const { id, pkg, p, t } = await paidBundle(); // $440
  const slots = await openSlots("coaching-60");
  const s1 = await bundleSession(p, t, slots[0]);
  const soon = await bundleSession(p, t, slots[6]);
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(Date.now() + 5 * 3600000).toISOString(), new Date(Date.now() + 6 * 3600000).toISOString(), soon.id);
  world.state.emails.length = 0;

  const preview = await api.call("GET", `/api/admin/packages/${id}/cancel`, { headers: asAdmin() });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.paidCents, 44000);
  assert.equal(preview.data.upcoming.length, 2, "includes the one inside 24 hours");
  assert.equal(preview.data.canRefund, true);
  assert.equal((await api.call("POST", `/api/admin/packages/${id}/cancel`, { headers: asAdmin(), body: { refundCents: 50000 } })).status, 400, "not more than they paid");

  const r = await api.call("POST", `/api/admin/packages/${id}/cancel`, { headers: asAdmin(), body: { refundCents: 30000, notifyClient: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refunded, true);
  assert.equal(pkg().status, "cancelled");
  assert.equal(pkg().cancel_reason, "avery_cancelled");
  assert.ok(pkg().refunded_at);
  assert.equal(world.state.refunds.length, 1);
  assert.equal(world.state.refunds[0].amount, "30000", "a partial refund of the chosen amount");
  assert.equal(row(s1.id).status, "cancelled");
  assert.equal(row(soon.id).status, "cancelled", "Avery can cancel inside 24 hours");
  assert.equal(pkg().credits_used, 0);
  const email = world.state.emails.find((e) => /^Your bundle is cancelled/.test(e.subject))!;
  assert.match(email.text, /\$300/);
  assert.equal((await api.call("POST", `/api/admin/packages/${id}/cancel`, { headers: asAdmin(), body: { refundCents: 0 } })).status, 409, "only once");
});

test("students: a directory with upcoming, last session, what's owed, and bundles; details per student", async () => {
  adminEnv();
  await paidBundle();
  await adminBook({ students: [student("Jamie Rivera", "jamie@example.com", { priceCents: 5000 })] });
  const list = (await api.call("GET", "/api/admin/students", { headers: asAdmin() })).data;
  const jamie = list.find((s: any) => s.email === "jamie@example.com");
  assert.equal(jamie.upcoming, 1);
  assert.equal(jamie.owedCents, 5000);
  assert.equal(jamie.bundles[0].remaining, 4);
  const detail = await api.call("GET", `/api/admin/students/${jamie.id}`, { headers: asAdmin() });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.sessions.length, 1);
  assert.equal(detail.data.sessions[0].dueCents, 5000);
  assert.equal(detail.data.bundles.length, 1);
  assert.equal((await api.call("GET", "/api/admin/students/nope", { headers: asAdmin() })).status, 404);
  assert.equal((await api.call("GET", `/api/admin/students/${jamie.id}`)).status, 403, "admin only");
});

test("cleanup errors are saved so the admin page can show why", async () => {
  adminEnv();
  const { id, b, t } = await confirmedBooking();
  world.state.calendarDeleteFailNext = 1;
  await api.call("POST", "/api/manage/cancel", { body: { b, t } });
  assert.match(row(id).cleanup_error, /iCloud DELETE failed with status 503/);
  const overview = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  assert.match(overview.data.problems.leftOnCalendar[0].error, /503/);
  db.prepare("UPDATE bookings SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 60000).toISOString(), id);
  await api.cron();
  assert.equal(row(id).cleanup_error, null, "cleared once it works");
});

/* ── Admin tools round 3 ── */

test("payment reminders on demand: per session and per student; not twice in a row", async () => {
  adminEnv();
  await adminBook({ students: [student("Owen Owes", "owen@example.com", { priceCents: 6000 })] });
  await adminBook({ time: "16:00", students: [student("Owen Owes", "owen@example.com", { priceCents: 3000 })] });
  const id = bookingByEmail("owen@example.com").id;
  const r = await api.call("POST", `/api/admin/bookings/${id}/remind`, { headers: asAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/remind`, { headers: asAdmin() })).status, 429, "not again within 10 minutes");
  const customer = (db.prepare("SELECT id FROM customers WHERE email = 'owen@example.com'").get() as any).id;
  const all = await api.call("POST", `/api/admin/students/${customer}/remind`, { headers: asAdmin() });
  assert.equal(all.status, 200);
  assert.equal(all.data.sent, 1, "the other session (the first was just reminded)");
  const reminders = world.state.emails.filter((e) => /^Payment due: /.test(e.subject));
  assert.equal(reminders.length, 2);
  assert.match(reminders[0].text, /pay=1/);
  const { id: paidId } = await confirmedBooking("coaching-30", 8);
  assert.equal((await api.call("POST", `/api/admin/bookings/${paidId}/remind`, { headers: asAdmin() })).status, 409, "nothing owed");
});

test("calendar feed: sessions plus blocked time, without titles or your own sessions", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const day = etDate(Date.now() + 3 * DAY).replace(/-/g, "");
  const own = row(id);
  world.state.busy = [
    { calendar: "Personal", ics: `BEGIN:VEVENT\r\nUID:dentist\r\nDTSTART;TZID=America/New_York:${day}T080000\r\nDTEND;TZID=America/New_York:${day}T090000\r\nSUMMARY:Dentist\r\nEND:VEVENT` },
    { calendar: "Coaching", ics: `BEGIN:VEVENT\r\nUID:${own.ics_uid}\r\nDTSTART:${own.start_utc.replace(/[-:]/g, "")}\r\nDTEND:${own.end_utc.replace(/[-:]/g, "")}\r\nSUMMARY:Coaching\r\nEND:VEVENT` },
  ];
  const from = new Date(Date.now()).toISOString();
  const to = new Date(Date.now() + 7 * DAY).toISOString();
  const r = await api.call("GET", `/api/admin/calendar?from=${from}&to=${to}`, { headers: asAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.bookings.some((b: any) => b.id === id));
  assert.equal(r.data.busy.length, 1, "the dentist, not the coaching session");
  assert.doesNotMatch(JSON.stringify(r.data.busy), /Dentist/, "no titles");
  assert.equal((await api.call("GET", `/api/admin/calendar?from=${from}&to=${new Date(Date.now() + 90 * DAY).toISOString()}`, { headers: asAdmin() })).status, 400, "45 days at most");
});

test("bundle changes can email the student, with Avery's note", async () => {
  adminEnv();
  const { id } = await paidBundle();
  await api.call("POST", `/api/admin/packages/${id}/credits`, { headers: asAdmin(), body: { delta: 1, note: "private", notifyClient: true, message: "A makeup for Tuesday." } });
  const added = world.state.emails.find((e) => /^Your bundle: a session added/.test(e.subject))!;
  assert.match(added.text, /A makeup for Tuesday\./);
  assert.match(added.text, /Sessions left: 5/);
  assert.doesNotMatch(added.text, /private/, "the record-keeping note stays private");
  await api.call("POST", `/api/admin/packages/${id}/credits`, { headers: asAdmin(), body: { delta: -1, note: "" } });
  assert.ok(!world.state.emails.some((e) => /a session removed/.test(e.subject)), "no email unless asked");
  await api.call("POST", `/api/admin/packages/${id}/extend`, { headers: asAdmin(), body: { days: 14, notifyClient: true, message: "" } });
  assert.ok(world.state.emails.some((e) => e.subject === "Your bundle has been extended"));
});

/* ── Admin tools round 4 ── */

test("Avery can refund any amount of a session, even after it happened; never more than was paid", async () => {
  adminEnv();
  const { id } = await confirmedBooking(); // $130
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(Date.now() - 2 * DAY).toISOString(), new Date(Date.now() - 2 * DAY + 3600000).toISOString(), id);
  const part = await api.call("POST", `/api/admin/bookings/${id}/refund`, { headers: asAdmin(), body: { amountCents: 5000, message: "Sorry about the audio." } });
  assert.equal(part.status, 200, JSON.stringify(part.data));
  assert.equal(row(id).refunded_cents, 5000);
  assert.equal(row(id).refunded_at, null, "not refunded in full yet");
  assert.equal(row(id).status, "confirmed", "the session stays as it was");
  assert.equal(world.state.refunds.at(-1).amount, "5000");
  assert.match(world.state.emails.find((e) => e.subject === "Refund: $50")!.text, /Sorry about the audio\./);
  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/refund`, { headers: asAdmin(), body: { amountCents: 9000 } })).status, 400, "only $80 left");
  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/refund`, { headers: asAdmin(), body: {} })).status, 200, "the rest");
  assert.equal(row(id).refunded_cents, 13000);
  assert.ok(row(id).refunded_at);
  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/refund`, { headers: asAdmin(), body: {} })).status, 409);
});

test("refund requests: students can ask when they can't refund online; Avery grants or declines", async () => {
  adminEnv();
  const upcoming = await confirmedBooking();
  const early = await api.call("POST", "/api/refund-requests", { body: { kind: "booking", b: upcoming.b, t: upcoming.t } });
  assert.equal(early.status, 409, "they can still cancel it themselves");
  assert.match(early.data.error, /cancel this session yourself/);

  const past = await confirmedBooking("coaching-30", 8);
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(Date.now() - DAY).toISOString(), new Date(Date.now() - DAY + 1800000).toISOString(), past.id);
  const view = await api.call("GET", `/api/manage?b=${past.b}&t=${past.t}`);
  assert.equal(view.data.canRequestRefund, true);
  const r = await api.call("POST", "/api/refund-requests", { body: { kind: "booking", b: past.b, t: past.t, message: "Zoom kept dropping." } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await api.call("POST", "/api/refund-requests", { body: { kind: "booking", b: past.b, t: past.t } })).status, 409, "one at a time");
  const toAvery = world.state.emails.find((e) => /^Refund request: /.test(e.subject))!;
  assert.match(toAvery.text, /Zoom kept dropping\./);
  assert.equal((await api.call("GET", `/api/manage?b=${past.b}&t=${past.t}`)).data.refundRequest, "open");

  const overview = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  const req = overview.data.problems.refundRequests[0];
  assert.equal(req.message, "Zoom kept dropping.");
  const decline = await api.call("POST", `/api/admin/refund-requests/${req.id}/decline`, { headers: asAdmin(), body: { message: "The session ran its full time." } });
  assert.equal(decline.status, 200);
  assert.match(world.state.emails.find((e) => e.subject === "About your refund request")!.text, /ran its full time/);
  assert.equal((await api.call("GET", `/api/manage?b=${past.b}&t=${past.t}`)).data.refundRequest, "declined");

  // A new request, granted by refunding.
  assert.equal((await api.call("POST", "/api/refund-requests", { body: { kind: "booking", b: past.b, t: past.t } })).status, 201);
  await api.call("POST", `/api/admin/bookings/${past.id}/refund`, { headers: asAdmin(), body: { amountCents: 3000 } });
  assert.equal((await api.call("GET", `/api/manage?b=${past.b}&t=${past.t}`)).data.refundRequest, "granted");
});

test("Avery can refund part of a bundle after its use-by date", async () => {
  adminEnv();
  const { id, pkg, p, t } = await paidBundle();
  db.prepare("UPDATE packages SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - DAY).toISOString(), id);
  assert.equal((await api.call("GET", `/api/packages?p=${p}&t=${t}`)).data.canRequestRefund, true, "the student can ask");
  const r = await api.call("POST", `/api/admin/packages/${id}/refund`, { headers: asAdmin(), body: { amountCents: 13000, notifyClient: false } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(pkg().refunded_cents, 13000);
});

test("reminders: after any reminder, the next (automatic or manual) waits 12 hours", async () => {
  adminEnv();
  await adminBook({ payBy: "after48", students: [student("Lock Out", "lock@example.com")] });
  const id = bookingByEmail("lock@example.com").id;
  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/remind`, { headers: asAdmin() })).status, 200);
  // Now the automatic one would be due, but Avery just sent one.
  db.prepare("UPDATE bookings SET created_at = ?, pay_by = ? WHERE id = ?").run(new Date(Date.now() - 10 * 3600000).toISOString(), new Date(Date.now() + 20 * 3600000).toISOString(), id);
  await api.cron();
  assert.equal(world.state.emails.filter((e) => /^Payment due: /.test(e.subject)).length, 1, "the automatic one held off");
  const again = await api.call("POST", `/api/admin/bookings/${id}/remind`, { headers: asAdmin() });
  assert.equal(again.status, 429);
  assert.match(again.data.error, /You can send another after/);
  const b = (await api.call("GET", "/api/admin/overview", { headers: asAdmin() })).data.bookings.find((x: any) => x.id === id);
  assert.equal(b.remindersSent, 1);
  assert.ok(b.lastReminderAt);
  // 12 hours later the automatic one goes out.
  db.prepare("UPDATE bookings SET last_payment_reminder_at = ? WHERE id = ?").run(new Date(Date.now() - 13 * 3600000).toISOString(), id);
  await api.cron();
  assert.equal(world.state.emails.filter((e) => /^Payment due: /.test(e.subject)).length, 2);
  const reminder = world.state.emails.filter((e) => /^Payment due: /.test(e.subject)).at(-1);
  assert.match(reminder.html, /cancel the session/, "a quiet cancel link");
});

test("notes, attendance, days off, export, and backups", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const customer = row(id).customer_id;
  assert.equal((await api.call("POST", `/api/admin/students/${customer}/notes`, { headers: asAdmin(), body: { notes: "Working on Chekhov." } })).status, 200);
  assert.match(world.state.calendarEvents.get(row(id).calendar_event_url)!.replace(/\r\n[ \t]/g, ""), /Your notes: Working on Chekhov\./, "in the calendar event");
  assert.equal((await api.call("GET", `/api/admin/students/${customer}`, { headers: asAdmin() })).data.notes, "Working on Chekhov.");

  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/attendance`, { headers: asAdmin(), body: { noShow: true } })).status, 409, "not before it starts");
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(Date.now() - DAY).toISOString(), new Date(Date.now() - DAY + 3600000).toISOString(), id);
  assert.equal((await api.call("POST", `/api/admin/bookings/${id}/attendance`, { headers: asAdmin(), body: { noShow: true } })).status, 200);
  assert.equal(row(id).attendance, "no_show");

  // Days off block admin bookings too.
  const day = new Date(Date.now() + 5 * DAY);
  const weekday = new Date(Date.UTC(+etDate(day.getTime()).slice(0, 4), +etDate(day.getTime()).slice(5, 7) - 1, +etDate(day.getTime()).slice(8))).getUTCDay();
  await api.call("POST", "/api/admin/settings", { headers: asAdmin(), body: { dayStartHour: 9, dayEndHour: 21, workDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekday), bufferMinutes: 15, minNoticeHours: 24, slotStepMinutes: 30, packageValidDays: 90, busyCalendars: ["Professional", "Personal", "Coaching"], bookingCalendar: "Coaching", remindersEnabled: true } });
  const off = await adminBook({ date: etDate(day.getTime()), time: "12:00", students: [student("Off Day", "off@example.com")] });
  assert.equal(off.status, 400);
  assert.match(off.data.error, /days off/);
  const check = await api.call("POST", "/api/admin/check-time", { headers: asAdmin(), body: { serviceId: "coaching-60", date: etDate(day.getTime()), time: "12:00" } });
  assert.equal(check.data.dayOff, true);

  const csv = await api.call("GET", `/api/admin/export?from=${etDate(Date.now() - 3 * DAY)}&to=${etDate(Date.now() + 30 * DAY)}`, { headers: asAdmin() });
  assert.equal(csv.status, 200);
  assert.match(csv.data, /"Session","\d{4}-\d{2}-\d{2}",.*"Jamie Rivera"/);
  assert.match(csv.data, /"No-show"/);
  const backup = await api.call("GET", "/api/admin/backup", { headers: asAdmin() });
  assert.ok(backup.data.tables.bookings.length >= 1);
  assert.equal((await api.call("GET", "/api/admin/backup")).status, 403, "admin only");
});

test("iCloud down for 15 minutes: Avery is emailed once, and again when it's back", async () => {
  env.ICLOUD_APP_PASSWORD = "wrong";
  await api.cron();
  assert.ok(!world.state.emails.some((e) => /can't reach your iCloud/.test(e.subject)), "not straight away");
  db.prepare("UPDATE health SET failing_since = ? WHERE key = 'icloud'").run(new Date(Date.now() - 20 * 60000).toISOString());
  await api.cron();
  await api.cron();
  assert.equal(world.state.emails.filter((e) => /can't reach your iCloud/.test(e.subject)).length, 1);
  env.ICLOUD_APP_PASSWORD = "app-pass";
  await api.cron();
  assert.ok(world.state.emails.some((e) => /iCloud is working again/.test(e.subject)));
});

/* ── Repeating sessions ── */

// Pretends a session happened `daysAgo` days ago at the same time of day, and the series last booked it.
function endSession(id: string, daysAgo = 1) {
  const b = row(id);
  const start = Date.parse(b.start_utc) - Math.ceil((Date.parse(b.start_utc) - Date.now()) / (7 * DAY)) * 7 * DAY - (daysAgo - 0) * 0;
  const past = start > Date.now() - 3600000 ? start - 7 * DAY : start;
  const s = new Date(past).toISOString().replace(/\.000Z$/, "Z");
  const e = new Date(past + (Date.parse(b.end_utc) - Date.parse(b.start_utc))).toISOString().replace(/\.000Z$/, "Z");
  db.prepare("DELETE FROM slot_claims WHERE booking_id = ?").run(id);
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(s, e, id);
  if (b.series_id) db.prepare("UPDATE series SET last_start = ? WHERE id = ?").run(s, b.series_id);
  return past;
}
const seriesOf = (id: string) => db.prepare("SELECT * FROM series WHERE id = (SELECT series_id FROM bookings WHERE id = ?)").get(id) as any;
const inSeries = (seriesId: string) => db.prepare("SELECT * FROM bookings WHERE series_id = ? ORDER BY start_utc").all(seriesId) as any[];

test("repeating: a student's weekly session books the next one after each ends, with a pay link", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot, {}, { repeat: { everyWeeks: 1 } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const first = res.data.bookingId;
  assert.equal(seriesOf(first).status, "pending", "starts once paid");
  await api.webhook("checkout.session.completed", paid(sessionFor(first)));
  assert.equal(seriesOf(first).status, "active");
  const confirmation = world.state.emails.find((e) => /^You're booked/.test(e.subject))!;
  assert.match(confirmation.text + confirmation.html, /repeats every week/);

  await api.cron();
  assert.equal(inSeries(seriesOf(first).id).length, 1, "nothing new until this one ends");
  const past = endSession(first);
  world.state.emails.length = 0;
  await api.cron();
  const all = inSeries(seriesOf(first).id);
  assert.equal(all.length, 2);
  const next = all[1];
  assert.equal(Date.parse(next.start_utc) - past, 7 * DAY, "same time, a week later");
  assert.equal(next.status, "confirmed");
  assert.equal(next.price_cents, 13000);
  assert.equal(next.amount_cents, 0);
  assert.equal(Date.parse(next.pay_by), Date.parse(next.start_utc) - DAY, "due 24 hours before");
  const invite = world.state.emails.find((e) => /^Next session booked, payment due/.test(e.subject))!;
  assert.match(invite.text, /pay=1/);
  await api.cron();
  assert.equal(inSeries(seriesOf(first).id).length, 2, "only one at a time");

  const link = linkIn(invite.text);
  const view = await api.call("GET", `/api/manage?b=${link.b}&t=${link.t}`);
  assert.equal(view.data.series.everyWeeks, 1);
  assert.equal((await api.call("POST", "/api/series/stop", { body: link })).status, 200);
  assert.equal(seriesOf(first).status, "stopped");
  assert.ok(world.state.emails.some((e) => e.subject === "Your sessions won't repeat anymore"));
  assert.equal(row(next.id).status, "confirmed", "already-booked sessions stay booked");
});

test("repeating: a clash skips that week and carries on; two unpaid in a row stops it", async () => {
  adminEnv();
  const r = await adminBook({ students: [student("Rep Eat", "rep@example.com", { priceCents: 5000 })], payBy: "before24", repeat: { everyWeeks: 1 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const first = r.data.bookingId;
  const sid = seriesOf(first).id;
  const past = endSession(first);
  // Someone else has the usual time next week.
  const nextTime = new Date(past + 7 * DAY);
  await adminBook({ date: etDate(nextTime.getTime()), time: new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).format(nextTime), students: [student("Other", "other@example.com")] });
  world.state.emails.length = 0;
  await api.cron();
  assert.equal(inSeries(sid).length, 1, "skipped");
  assert.ok(world.state.emails.some((e) => /^No session on /.test(e.subject) && e.to[0] === "rep@example.com"));
  assert.ok(world.state.emails.some((e) => /^Repeat skipped: Rep Eat/.test(e.subject)));
  assert.equal(Date.parse(seriesOf(first).last_start), past + 7 * DAY, "moves on to the following week");

  // The following week is booked; it goes unpaid, then the next one too: the series stops.
  db.prepare("UPDATE series SET last_start = ? WHERE id = ?").run(new Date(past).toISOString().replace(/\.000Z$/, "Z"), sid);
  db.prepare("DELETE FROM slot_claims WHERE booking_id IN (SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE c.email = 'other@example.com')").run();
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE customer_id = (SELECT id FROM customers WHERE email = 'other@example.com')").run();
  for (let i = 0; i < 2; i++) {
    await api.cron();
    const latest = inSeries(sid).at(-1);
    assert.equal(latest.series_id, sid);
    db.prepare("UPDATE bookings SET pay_by = ? WHERE id = ?").run(new Date(Date.now() - 60000).toISOString(), latest.id);
    await api.cron(); // released unpaid
    assert.equal(row(latest.id).cancel_reason, "unpaid");
    endSession(latest.id);
  }
  assert.equal(seriesOf(first).status, "stopped");
  assert.equal(seriesOf(first).stopped_reason, "unpaid");
  assert.ok(world.state.emails.some((e) => /^Repeats stopped: Rep Eat/.test(e.subject)));
});

test("repeating: a set number of sessions ends by itself; groups and bundle credits can't repeat", async () => {
  adminEnv();
  const r = await adminBook({ students: [student("Two Times", "two@example.com", { priceCents: 0 })], repeat: { everyWeeks: 2, total: 2 } });
  const first = r.data.bookingId;
  const sid = seriesOf(first).id;
  const past = endSession(first);
  await api.cron();
  const all = inSeries(sid);
  assert.equal(all.length, 2);
  assert.equal(Date.parse(all[1].start_utc) - past, 14 * DAY, "every 2 weeks");
  assert.equal(all[1].price_cents, 0, "free, so no pay link");
  assert.equal(seriesOf(first).status, "ended");
  endSession(all[1].id);
  await api.cron();
  assert.equal(inSeries(sid).length, 2, "no more after the set number");

  const group = await adminBook({ time: "18:00", students: [student("A", "a1@example.com"), student("B", "b1@example.com")], repeat: { everyWeeks: 1 } });
  assert.equal(group.status, 400);
  assert.equal((await book("intro-15", (await openSlots("intro-15"))[0], { material: "" }, { repeat: { everyWeeks: 1 } })).status, 400, "intro chats can't repeat");
  assert.equal((await api.call("POST", `/api/admin/series/${sid}/stop`, { headers: asAdmin(), body: {} })).status, 409, "already ended");
});

test("repeating: a repeat whose first time is taken leaves no schedule behind", async () => {
  adminEnv();
  assert.equal((await adminBook({ time: "11:00", students: [student("First In", "first@example.com")] })).status, 201);
  const r = await adminBook({ time: "11:00", students: [student("Too Late", "late2@example.com")], repeat: { everyWeeks: 1 } });
  assert.equal(r.status, 409);
  const left = db.prepare("SELECT COUNT(*) AS n FROM series s JOIN customers c ON c.id = s.customer_id WHERE c.email = 'late2@example.com'").get() as any;
  assert.equal(left.n, 0, "no repeat schedule without its first booking");
});

test("repeating: a skipped week doesn't use up one of a set number of sessions", async () => {
  adminEnv();
  const r = await adminBook({ time: "16:00", students: [student("Count Me", "count@example.com", { priceCents: 0 })], repeat: { everyWeeks: 1, total: 2 } });
  const first = r.data.bookingId;
  const sid = seriesOf(first).id;
  assert.equal(seriesOf(first).sessions_left, 1);
  const past = endSession(first);
  const nextTime = new Date(past + 7 * DAY);
  await adminBook({ date: etDate(nextTime.getTime()), time: new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).format(nextTime), students: [student("Other Two", "other2@example.com")] });
  await api.cron();
  assert.equal(inSeries(sid).length, 1, "skipped");
  assert.equal(seriesOf(first).sessions_left, 1, "still one to come");
  assert.equal(seriesOf(first).status, "active");
});

test("repeating: future times are kept for the student; others can't book them, Avery is warned", async () => {
  adminEnv();
  const r = await adminBook({ time: "13:00", students: [student("Kept Time", "kept@example.com", { priceCents: 0 })], repeat: { everyWeeks: 1 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const first = row(r.data.bookingId);
  const nextWeek = Date.parse(first.start_utc) + 7 * DAY;
  const nextIso = new Date(nextWeek).toISOString().replace(/\.000Z$/, "Z");
  const dayOf = async () => (await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(nextWeek)}&days=1&fresh=${Math.random()}`)).data.slots as string[];
  const slots = await dayOf();
  assert.ok(slots.length > 0, "other times that day are offered");
  assert.ok(!slots.includes(nextIso), "next week's time isn't offered on the site");
  const check = await api.call("POST", "/api/admin/check-time", { headers: asAdmin(), body: { serviceId: "coaching-60", date: etDate(nextWeek), time: "13:00" } });
  assert.deepEqual(check.data.reservedFor, ["Kept Time"]);
  assert.equal(check.data.overlapsBooking, false, "a warning, not a block");
  await api.call("POST", `/api/admin/series/${first.series_id}/stop`, { headers: asAdmin(), body: { notifyClient: false } });
  assert.ok((await dayOf()).includes(nextIso), "offered again once the repeats stop");
});

test("repeating: a week that clashes with Avery's calendar is held until she keeps or moves it", async () => {
  adminEnv();
  const r = await adminBook({ time: "15:00", students: [student("Held Up", "held@example.com", { priceCents: 5000 })], payBy: "before24", repeat: { everyWeeks: 1 } });
  const first = r.data.bookingId;
  const sid = seriesOf(first).id;
  const past = endSession(first);
  const next = past + 7 * DAY;
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  world.state.busy.push({ calendar: "Personal", ics: `BEGIN:VEVENT\r\nUID:dentist\r\nDTSTART:${stamp(next)}\r\nDTEND:${stamp(next + 3600000)}\r\nEND:VEVENT` });
  world.state.emails.length = 0;
  await api.cron();
  const held = inSeries(sid)[1];
  assert.equal(held.status, "confirmed", "booked, so the time stays kept");
  assert.equal(held.series_conflict, "calendar");
  assert.ok(!world.state.emails.some((e) => e.to[0] === "held@example.com"), "the student hasn't been told");
  assert.ok(world.state.emails.some((e) => /^Repeat clash: Held Up/.test(e.subject)));
  const overview = await api.call("GET", "/api/admin/overview", { headers: asAdmin() });
  assert.equal(overview.data.problems.held.length, 1);

  // Retries and reminders leave it alone.
  db.prepare("UPDATE bookings SET confirmed_at = ?, pay_by = ? WHERE id = ?").run(new Date(Date.now() - DAY).toISOString(), new Date(Date.now() - 60000).toISOString(), held.id);
  await api.cron();
  assert.equal(row(held.id).status, "confirmed", "not released as unpaid while held");
  assert.ok(!world.state.emails.some((e) => e.to[0] === "held@example.com"));

  // Keep it: the invite goes out, with at least 12 hours to pay.
  assert.equal((await api.call("POST", `/api/admin/bookings/${held.id}/keep`, { headers: asAdmin(), body: {} })).status, 200);
  const kept = row(held.id);
  assert.equal(kept.series_conflict, null);
  assert.ok(Date.parse(kept.pay_by) >= Date.now() + 12 * 3600000 - 60000, "never less than 12 hours to pay");
  assert.ok(world.state.emails.some((e) => e.to[0] === "held@example.com" && /payment due/.test(e.subject)));
  assert.equal((await api.call("POST", `/api/admin/bookings/${held.id}/keep`, { headers: asAdmin(), body: {} })).status, 409);
});

test("repeating: a held week Avery never decides goes ahead 2 days before", async () => {
  adminEnv();
  const r = await adminBook({ time: "17:00", students: [student("No Word", "noword@example.com", { priceCents: 0 })], repeat: { everyWeeks: 1 } });
  const first = r.data.bookingId;
  const sid = seriesOf(first).id;
  const past = endSession(first);
  const next = past + 7 * DAY;
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  world.state.busy.push({ calendar: "Professional", ics: `BEGIN:VEVENT\r\nUID:meeting\r\nDTSTART:${stamp(next)}\r\nDTEND:${stamp(next + 3600000)}\r\nEND:VEVENT` });
  await api.cron();
  const held = inSeries(sid)[1];
  assert.equal(held.series_conflict, "calendar");
  const soon = Date.now() + DAY;
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?").run(new Date(soon).toISOString(), new Date(soon + 3600000).toISOString(), held.id);
  world.state.emails.length = 0;
  await api.cron();
  assert.equal(row(held.id).series_conflict, null);
  assert.ok(world.state.emails.some((e) => e.to[0] === "noword@example.com"), "the student gets the invite");
  assert.ok(world.state.emails.some((e) => /^Repeat went ahead: No Word/.test(e.subject)));
});

test("repeating: a first session that's never paid drops the series", async () => {
  const [slot] = await openSlots();
  const res = await book("coaching-60", slot, {}, { repeat: { everyWeeks: 1 } });
  const sid = seriesOf(res.data.bookingId).id;
  await expireHold(res.data.bookingId);
  db.prepare("UPDATE series SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * DAY).toISOString(), sid);
  await api.cron();
  assert.equal((db.prepare("SELECT status FROM series WHERE id = ?").get(sid) as any).status, "stopped");
});

test("iCloud password from the admin page: checked with iCloud, stored encrypted, never shown or backed up", async () => {
  adminEnv();
  const { forgetStoredPassword } = await import("../src/secrets");
  const save = (password: string, headers = asAdmin()) => api.call("POST", "/api/admin/icloud-password", { headers, body: { password } });
  delete (env as any).SECRETS_KEY;
  assert.equal((await save("abcd-efgh-ijkl-mnop")).status, 503, "needs the one-time key first");
  (env as any).SECRETS_KEY = "a".repeat(64);
  forgetStoredPassword();

  assert.equal((await save("abcd-efgh-ijkl-mnop", {})).status, 403, "admin only");
  assert.equal((await save("hunter2")).status, 400, "not an app-specific password");
  const wrong = await save("wxyz-wxyz-wxyz-wxyz");
  assert.equal(wrong.status, 400, "iCloud refused it");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM stored_secrets").get() as any).n, 0, "nothing saved");

  world.state.emails.length = 0;
  const ok = await save("ABCD EFGH IJKL MNOP");
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(!JSON.stringify(ok.data).includes("abcd"), "never sent back");
  assert.equal(ok.data.icloudPassword.fromAdmin, true);
  const stored = db.prepare("SELECT * FROM stored_secrets").get() as any;
  assert.ok(!JSON.stringify(stored).includes("abcd"), "stored encrypted");
  assert.ok(world.state.emails.some((e) => e.subject === "Booking system: iCloud password changed"));

  // The old setup password stops working; the new one is used.
  env.ICLOUD_APP_PASSWORD = "wrong";
  const avail = await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.now() + 5 * DAY)}&days=1&v=${Math.random()}`);
  assert.equal(avail.status, 200, "calendar works with the new password");
  const backup = await api.call("GET", "/api/admin/backup", { headers: asAdmin() });
  assert.ok(!JSON.stringify(backup.data).includes(stored.ciphertext), "not in backups");

  // A different key can't read it: falls back to the setup password (here, broken).
  (env as any).SECRETS_KEY = "b".repeat(64);
  forgetStoredPassword();
  const broken = await api.call("GET", `/api/availability?service=coaching-60&from=${etDate(Date.now() + 6 * DAY)}&days=1&v=${Math.random()}`);
  assert.equal(broken.status, 503);

  (env as any).SECRETS_KEY = "a".repeat(64);
  env.ICLOUD_APP_PASSWORD = "app-pass";
  assert.equal((await api.call("POST", "/api/admin/icloud-password/reset", { headers: asAdmin() })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM stored_secrets").get() as any).n, 0);
  delete (env as any).SECRETS_KEY;
  forgetStoredPassword();
});

test("backups restore cleanly into a fresh database, with every row and link intact", async () => {
  adminEnv();
  await confirmedBooking();
  const bundle = await paidBundle("bundle-2");
  await api.call("POST", "/api/packages/cancel", { body: { p: bundle.p, t: bundle.t } });
  await adminBook({ time: "12:00", students: [student("Re Store", "restore@example.com", { priceCents: 5000 })], repeat: { everyWeeks: 2 } });
  await adminBook({ time: "18:00", students: [student("G One", "g1@example.com"), student("G Two", "g2@example.com")] });
  const backup = await api.call("GET", "/api/admin/backup", { headers: asAdmin() });
  assert.equal(backup.status, 200);
  const { checkBackup } = await import("../scripts/check-backup");
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(new URL(f, dir), "utf8"));
  const r = checkBackup(JSON.stringify(backup.data), migrations);
  assert.deepEqual(r.problems, []);
  assert.ok(r.counts.bookings.restored >= 4 && r.counts.series.restored === 1 && r.counts.groups.restored === 1);
  assert.ok(!("stored_secrets" in r.counts), "the encrypted password is never in a backup");
  assert.match(r.sql, /INSERT INTO bookings/);

  // A damaged backup is caught.
  const broken = JSON.parse(JSON.stringify(backup.data));
  broken.tables.customers = [];
  assert.ok(checkBackup(JSON.stringify(broken), migrations).problems.some((p: string) => /missing customers row/.test(p)));
});

test("clear test data: only in test mode, removes calendar events, keeps settings", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const eventUrl = row(id).calendar_event_url;
  await api.call("POST", "/api/admin/settings", { headers: asAdmin(), body: { dayStartHour: 10, dayEndHour: 20, workDays: [1, 2, 3, 4, 5], bufferMinutes: 15, minNoticeHours: 24, slotStepMinutes: 30, packageValidDays: 90, busyCalendars: ["Professional", "Personal", "Coaching"], bookingCalendar: "Coaching", remindersEnabled: true } });
  assert.equal((await api.call("POST", "/api/admin/clear-test-data", { headers: asAdmin(), body: { confirm: "nope" } })).status, 400);
  const r = await api.call("POST", "/api/admin/clear-test-data", { headers: asAdmin(), body: { confirm: "CLEAR" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM bookings").get() as any).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM customers").get() as any).n, 0);
  assert.ok(!world.state.calendarEvents.has(eventUrl), "test event removed from the calendar");
  assert.equal((await api.call("GET", "/api/admin/settings", { headers: asAdmin() })).data.values.dayStartHour, 10, "settings kept");
  env.STRIPE_SECRET_KEY = "rk_live_example";
  assert.equal((await api.call("POST", "/api/admin/clear-test-data", { headers: asAdmin(), body: { confirm: "CLEAR" } })).status, 403, "never in live mode");
});

/* ── Favicon, students edit/delete, status lights ── */

test("the booking service serves the same favicon files as averywhitted.com", async () => {
  for (const [path, type] of [["/favicon.ico", "image/x-icon"], ["/favicon.svg", "image/svg+xml"], ["/apple-touch-icon.png", "image/png"]]) {
    const r = await api.call("GET", path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-type"), type);
  }
  adminEnv();
  const page = await api.call("GET", "/admin", { headers: { "Cf-Access-Jwt-Assertion": accessToken() } });
  assert.match(page.data, /rel="icon" href="\/favicon\.svg"/);
});

test("admin: editing a student updates name, pronouns and email everywhere; refuses a taken email", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const cid = row(id).customer_id;
  await book("coaching-60", (await openSlots("coaching-60", 5))[0], { name: "Other Person", email: "other@example.com" });
  const other = (db.prepare("SELECT id FROM customers WHERE email = 'other@example.com'").get() as any).id;
  assert.equal((await api.call("POST", `/api/admin/students/${cid}/edit`, { headers: asAdmin(), body: { name: "", email: "a@b.co" } })).status, 400);
  assert.equal((await api.call("POST", `/api/admin/students/${cid}/edit`, { headers: asAdmin(), body: { name: "Jamie R", email: "not-an-email" } })).status, 400);
  assert.equal((await api.call("POST", `/api/admin/students/${cid}/edit`, { headers: asAdmin(), body: { name: "Jamie R", email: "OTHER@example.com" } })).status, 409, "email already used");
  const r = await api.call("POST", `/api/admin/students/${cid}/edit`, { headers: asAdmin(), body: { name: "Jamie Q. Rivera", email: "Jamie.New@Example.com", pronouns: "he/him" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.emailChanged, true);
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(cid) as any;
  assert.deepEqual([c.name, c.email, c.pronouns], ["Jamie Q. Rivera", "jamie.new@example.com", "he/him"]);
  assert.equal(row(id).client_name, "Jamie Q. Rivera", "the copy on the booking follows");
  assert.equal((db.prepare("SELECT name FROM customers WHERE id = ?").get(other) as any).name, "Other Person", "nobody else changed");
  assert.equal((await api.call("POST", "/api/admin/students/nope/edit", { headers: asAdmin(), body: { name: "X", email: "x@y.co" } })).status, 404);
});

test("admin: a student with live business can't be deleted, and says why", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const cid = row(id).customer_id;
  const preview = await api.call("GET", `/api/admin/students/${cid}/delete`, { headers: asAdmin() });
  assert.equal(preview.status, 200);
  assert.ok(preview.data.blockers.some((b: string) => /upcoming session/.test(b)), JSON.stringify(preview.data));
  const del = await api.call("POST", `/api/admin/students/${cid}/delete`, { headers: asAdmin(), body: { confirm: "DELETE" } });
  assert.equal(del.status, 409);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM customers WHERE id = ?").get(cid) as any).n, 1, "still there");
});

test("admin: deleting a student removes their records here (needs DELETE typed) and nobody else's", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const cid = row(id).customer_id;
  const { id: otherId } = await (async () => {
    const slots = await openSlots("coaching-60", 6);
    const res = await book("coaching-60", slots[0], { name: "Other Person", email: "other@example.com" });
    await api.webhook("checkout.session.completed", paid(sessionFor(res.data.bookingId)));
    return { id: res.data.bookingId as string };
  })();
  // Make Jamie's session a past one.
  db.prepare("UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?")
    .run(new Date(Date.now() - 3 * DAY).toISOString(), new Date(Date.now() - 3 * DAY + 3600000).toISOString(), id);
  db.prepare("DELETE FROM slot_claims WHERE booking_id = ?").run(id);
  const preview = await api.call("GET", `/api/admin/students/${cid}/delete`, { headers: asAdmin() });
  assert.deepEqual(preview.data.blockers, []);
  assert.equal(preview.data.removes.sessions, 1);
  assert.equal((await api.call("POST", `/api/admin/students/${cid}/delete`, { headers: asAdmin(), body: { confirm: "delete please" } })).status, 400, "must type DELETE");
  const del = await api.call("POST", `/api/admin/students/${cid}/delete`, { headers: asAdmin(), body: { confirm: "DELETE" } });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM customers WHERE id = ?").get(cid) as any).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM bookings WHERE id = ?").get(id) as any).n, 0);
  assert.equal(row(otherId).status, "confirmed", "the other student's booking is untouched");
  assert.ok(claims(otherId) > 0, "and still holds its time");
  // Nothing was sent to Stripe to remove or refund anything.
  assert.equal((await api.call("GET", `/api/admin/students/${cid}`, { headers: asAdmin() })).status, 404);
});

test("admin: status lights cover every connection; logs fill in as things happen; check now is logged", async () => {
  adminEnv();
  await confirmedBooking();
  const r = await api.call("GET", "/api/admin/status", { headers: asAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.services.map((s: any) => s.id), ["stripe", "icloud", "resend", "zoom", "database", "backups", "turnstile"]);
  for (const s of r.data.services) assert.match(s.light, /^(ok|warn|error|idle)$/);
  assert.equal(r.data.services.find((s: any) => s.id === "database").light, "ok");
  const resend = await api.call("GET", "/api/admin/status/resend", { headers: asAdmin() });
  assert.ok(resend.data.events.some((e: any) => e.level === "ok" && /Sent a "/.test(e.message)), "emails show in the Resend log");
  assert.equal((await api.call("GET", "/api/admin/status/bogus", { headers: asAdmin() })).status, 404);
  const chk = await api.call("POST", "/api/admin/status/database/check", { headers: asAdmin() });
  assert.equal(chk.status, 200);
  assert.match(chk.data.events[0].message, /^Checked by hand/);
  assert.equal((await api.call("GET", "/api/admin/status")).status, 403, "needs the admin pass");
  // A forged Stripe notice lands in the Stripe log as a warning.
  await api.webhook("checkout.session.completed", {}, { secret: "whsec_wrong" });
  const stripe = await api.call("GET", "/api/admin/status/stripe", { headers: asAdmin() });
  assert.ok(stripe.data.events.some((e: any) => e.level === "warn" && /bad signature/.test(e.message)));
});

/* ── Duplicates, merging, and per-student export ── */

async function twoJamies() {
  const { id } = await confirmedBooking();
  const slots = await openSlots("coaching-60", 6);
  const res = await book("coaching-60", slots[0], { name: "jamie  rivera", email: "jamie.alt@example.org", pronouns: "" });
  await api.webhook("checkout.session.completed", paid(sessionFor(res.data.bookingId)));
  // A different person, who must never be suggested.
  const third = await book("coaching-60", slots[6], { name: "Casey Lane", email: "casey@example.com" });
  await api.webhook("checkout.session.completed", paid(sessionFor(third.data.bookingId)));
  return { firstId: id, secondId: res.data.bookingId as string, first: row(id).customer_id as string, second: row(res.data.bookingId).customer_id as string };
}

test("admin: duplicates are found by name or inbox; 'not the same person' hides them for good", async () => {
  adminEnv();
  const { first, second } = await twoJamies();
  const r = await api.call("GET", "/api/admin/duplicates", { headers: asAdmin() });
  assert.equal(r.status, 200);
  assert.equal(r.data.groups.length, 1, JSON.stringify(r.data));
  assert.deepEqual(r.data.groups[0].members.map((m: any) => m.id).sort(), [first, second].sort());
  assert.match(r.data.groups[0].why.join(), /same name/);
  assert.equal((await api.call("POST", "/api/admin/duplicates/ignore", { headers: asAdmin(), body: { ids: [first] } })).status, 400);
  assert.equal((await api.call("POST", "/api/admin/duplicates/ignore", { headers: asAdmin(), body: { ids: [first, second] } })).status, 200);
  assert.equal((await api.call("GET", "/api/admin/duplicates", { headers: asAdmin() })).data.groups.length, 0);
  // Gmail dots and +tags count as the same inbox.
  db.prepare("UPDATE customers SET email = 'casey.lane+x@gmail.com' WHERE email = 'casey@example.com'").run();
  db.prepare("UPDATE customers SET name = 'Someone Else', email = 'caseylane@gmail.com' WHERE id = ?").run(second);
  db.prepare("DELETE FROM duplicate_ignores").run();
  assert.equal((await api.call("GET", "/api/admin/duplicates", { headers: asAdmin() })).data.groups.length, 1, "same Gmail inbox");
});

test("admin: merging moves everything to the kept student and their old email still finds them", async () => {
  adminEnv();
  const { firstId, secondId, first, second } = await twoJamies();
  db.prepare("UPDATE customers SET notes = 'Works on comedy' WHERE id = ?").run(second);
  db.prepare("UPDATE customers SET notes = 'Prefers mornings' WHERE id = ?").run(first);
  assert.equal((await api.call("POST", "/api/admin/duplicates/merge", { headers: asAdmin(), body: { keepId: first, mergeIds: [first] } })).status, 400, "nothing to merge");
  const r = await api.call("POST", "/api/admin/duplicates/merge", { headers: asAdmin(), body: { keepId: first, mergeIds: [second] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM customers WHERE id = ?").get(second) as any).n, 0);
  assert.equal(row(firstId).customer_id, first);
  assert.equal(row(secondId).customer_id, first, "the other booking moved over");
  assert.equal(row(secondId).client_name, "Jamie Rivera", "and shows the kept name");
  const kept = db.prepare("SELECT notes, pronouns FROM customers WHERE id = ?").get(first) as any;
  assert.match(kept.notes, /Prefers mornings[\s\S]*jamie\.alt@example\.org[\s\S]*Works on comedy/);
  assert.equal(kept.pronouns, "they/them");
  assert.equal((await api.call("GET", "/api/admin/duplicates", { headers: asAdmin() })).data.groups.length, 0);
  // Booking again with the old address goes to the same student.
  const slots = await openSlots("coaching-60", 9);
  const again = await book("coaching-60", slots[0], { name: "J Rivera", email: "JAMIE.ALT@example.org" });
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.equal(row(again.data.bookingId).customer_id, first);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM customers WHERE email LIKE 'jamie.alt%'").get() as any).n, 0);
});

test("admin: changing a student's email keeps the old one pointing at them", async () => {
  adminEnv();
  const { id } = await confirmedBooking();
  const cid = row(id).customer_id;
  await api.call("POST", `/api/admin/students/${cid}/edit`, { headers: asAdmin(), body: { name: "Jamie Rivera", email: "jamie.new@example.com", pronouns: "they/them" } });
  const slots = await openSlots("coaching-60", 8);
  const again = await book("coaching-60", slots[0], { email: "jamie@example.com" });
  assert.equal(row(again.data.bookingId).customer_id, cid);
});

test("admin: export one student's records as CSV", async () => {
  adminEnv();
  const { first, second } = await twoJamies();
  await api.call("POST", "/api/admin/duplicates/merge", { headers: asAdmin(), body: { keepId: first, mergeIds: [second] } });
  const r = await api.call("GET", `/api/admin/students/${first}/export`, { headers: asAdmin() });
  assert.equal(r.status, 200);
  const lines = String(r.data).trim().split("\r\n");
  assert.match(lines[0], /^"Type","Date"/);
  assert.equal(lines.length, 3, "two sessions plus the header");
  assert.ok(!String(r.data).includes("Casey Lane"), "only this student");
  assert.equal((await api.call("GET", "/api/admin/students/nope/export", { headers: asAdmin() })).status, 404);
});
