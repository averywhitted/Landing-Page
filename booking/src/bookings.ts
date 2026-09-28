// The booking lifecycle:
//
//   createBooking   client submits the form. We re-check the time live, then
//                   hold it (claiming its 15-minute blocks) and send paid
//                   bookings to Stripe. Free intro chats are confirmed at once.
//   confirmPaid     Stripe says the payment went through. The hold becomes a
//                   confirmed booking (or, if the hold had lapsed and someone
//                   else took the time, the client is refunded automatically).
//   afterConfirm    Zoom meeting, Coaching calendar event, and emails. Each
//                   piece is recorded, so a failure can be retried later.
//   expireHolds     unpaid holds past 30 minutes are released.
//   sendReminders   "finish your booking" email for abandoned checkouts.
//   retryConfirmations  finishes any afterConfirm pieces that failed.

import type { Env } from "./env";
import { findService, type Service } from "./services";
import { RULES } from "./settings";
import { calendarFor } from "./calendar";
import { blocksFor, openSlots } from "./availability";
import { iso, isValidTimeZone, zonedDate, zonedToUtc } from "./time";
import * as stripe from "./stripe";
import { createMeeting, deleteMeeting, updateMeeting } from "./zoom";
import { scheduling } from "./config";
import { sendEmail } from "./email";
import { buildIcs } from "./ics";
import * as T from "./templates";
import { verifyHuman } from "./turnstile";
import { manageUrl, packageUrl, validManageToken } from "./manage";

const AVERY_TZ = RULES.timeZone;
const MIN = 60000;

export class BookingError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429 | 502 | 503, message: string) { super(message); }
}

/* ── Intake form ── */

export type Intake = {
  name: string; email: string; pronouns: string;
  goal: string; material: string; link: string; notes: string;
};

// Strips invisible control characters (which could break calendar files or
// email subjects). One-line fields also lose line breaks.
const clean = (v: unknown, max: number, multiline = false) => {
  if (typeof v !== "string") return "";
  let t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/g, multiline ? " " : "");
  if (!multiline) t = t.replace(/\n/g, " ");
  return t.trim().slice(0, max);
};

export function validateIntake(raw: unknown, service: Service): Intake {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const intake: Intake = {
    name: clean(r.name, 120),
    email: clean(r.email, 200).toLowerCase(),
    pronouns: clean(r.pronouns, 40),
    goal: clean(r.goal, 2000, true),
    material: clean(r.material, 2000, true),
    link: clean(r.link, 500),
    notes: clean(r.notes, 2000, true),
  };
  if (!intake.name) throw new BookingError(400, "Please add your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(intake.email)) throw new BookingError(400, "Please check your email address.");
  if (!intake.goal) throw new BookingError(400, "Please tell Avery what you'd like to focus on.");
  if (service.kind === "single" && !intake.material) throw new BookingError(400, "Please add the material you'd like to work on (\"not sure yet\" is fine).");
  if (intake.link) {
    let ok = false;
    try { ok = ["http:", "https:"].includes(new URL(intake.link).protocol); } catch { /* not a URL */ }
    if (!ok) throw new BookingError(400, "The materials link should start with https://");
  }
  if (r.policyAccepted !== true) throw new BookingError(400, "Please accept the reschedule and cancellation policy.");
  return intake;
}

/* ── Helpers ── */

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function serviceLabel(s: Service): string {
  if (s.kind === "intro") return "Intro chat";
  return s.durationMinutes === 60 ? "1 hour session" : `${s.durationMinutes} minute session`;
}

function stripeProductName(s: Service): string {
  return s.kind === "intro" ? "Intro chat" : `Private coaching, ${s.durationMinutes === 60 ? "1 hour" : `${s.durationMinutes} minutes`}`;
}

function describeTime(start: number, tz: string): string {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(start);
  return `${d} on Zoom`;
}

export const UNIQUE_CLAIM = /UNIQUE constraint failed: slot_claims/i;
// From the database's own guards (migration 0008).
export const INACTIVE_CLAIM = /only active bookings can claim time/i;
export const ONCE_ONLY = /UNIQUE constraint failed: credit_ledger/i;

// Is this exact start time still offered right now (live calendar + bookings)?
// `ignore` skips one booking's own blocks and calendar event (used when moving it).
export async function isStillOpen(env: Env, service: Service, start: number, now: number,
  ignore?: { bookingId: string; uid: string }): Promise<boolean> {
  const [y, m, d] = zonedDate(start, AVERY_TZ);
  const from = zonedToUtc(y, m, d, 0, 0, AVERY_TZ);
  const to = from + 24 * 60 * MIN;
  const cfg = await scheduling(env);
  const busy = (await calendarFor(env, cfg).getBusy(from, to)).filter((b) => !ignore || b.uid !== ignore.uid);
  const rows = await env.DB.prepare(
    `SELECT sc.slot_start FROM slot_claims sc JOIN bookings b ON b.id = sc.booking_id
     WHERE sc.slot_start >= ?1 AND sc.slot_start < ?2 AND b.id <> ?4
       AND (b.status = 'confirmed' OR (b.status = 'held' AND b.hold_expires_at > ?3))`,
  ).bind(iso(from - 60 * MIN), iso(to + 60 * MIN), iso(now), ignore?.bookingId ?? "").all<{ slot_start: string }>();
  const claimed = new Set(rows.results.map((r) => r.slot_start));
  return openSlots({ durationMinutes: service.durationMinutes, from, to, now, busy, claimed, rules: cfg }).includes(iso(start));
}

/* ── Create ── */

export type CreateResult = { checkoutUrl?: string; confirmationUrl?: string; bookingId: string };

export async function createBooking(env: Env, body: unknown, ctx: { ip: string; now: number; waitUntil: (p: Promise<unknown>) => void }): Promise<CreateResult> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const service = findService(String(b.serviceId ?? ""));
  if (!service || service.kind === "bundle") throw new BookingError(400, "Unknown session type.");
  const start = Date.parse(String(b.start ?? ""));
  if (!Number.isFinite(start)) throw new BookingError(400, "Please pick a time.");
  const clientTz = typeof b.timeZone === "string" && isValidTimeZone(b.timeZone) ? b.timeZone : AVERY_TZ;
  const intake = validateIntake(b.intake, service);
  if (!(await verifyHuman(env, b.turnstileToken, ctx.ip))) {
    throw new BookingError(403, "We couldn't confirm you're a real person. Please refresh the page and try again.");
  }
  const now = ctx.now;
  const ipHash = await sha256(`${env.HASH_SALT ?? "averywhitted-booking"}|${ctx.ip}`);

  // Limit unpaid holds per person and per network, so nobody can tie up the calendar.
  const holds = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.status = 'held' AND b.hold_expires_at > ?1 AND (c.email = ?2 OR b.ip_hash = ?3)`,
  ).bind(iso(now), intake.email, ipHash).first<{ n: number }>();
  if ((holds?.n ?? 0) >= RULES.maxActiveHoldsPerPerson) {
    throw new BookingError(429, "You have a booking waiting for payment. Please finish it, or try again in 30 minutes.");
  }
  if (service.kind === "intro") {
    const intros = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE b.service_id = ?1 AND b.status = 'confirmed' AND b.start_utc > ?2 AND c.email = ?3`,
    ).bind(service.id, iso(now), intake.email).first<{ n: number }>();
    if ((intros?.n ?? 0) >= RULES.maxUpcomingIntros) {
      throw new BookingError(409, "You already have an intro chat coming up. Check your email for the details, or reply to it to change the time.");
    }
    // Intro chats are free and confirmed at once, so also limit how many one
    // network can book in a day (made-up email addresses can't fill the calendar).
    const fromNetwork = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bookings WHERE service_id = ?1 AND ip_hash = ?2 AND created_at > ?3`,
    ).bind(service.id, ipHash, iso(now - 24 * 60 * MIN)).first<{ n: number }>();
    if ((fromNetwork?.n ?? 0) >= RULES.maxIntrosPerNetworkPerDay) {
      throw new BookingError(429, "A few intro chats have already been booked from this connection today. Please email info@averywhitted.com and we'll find a time.");
    }
  }

  if (!(await isStillOpen(env, service, start, now))) {
    throw new BookingError(409, "Sorry, that time was just taken. Please pick another.");
  }

  const customer = await env.DB.prepare(
    `INSERT INTO customers (id, name, email, pronouns) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, pronouns = excluded.pronouns
     RETURNING id`,
  ).bind(crypto.randomUUID(), intake.name, intake.email, intake.pronouns || null).first<{ id: string }>();

  const id = crypto.randomUUID();
  const end = start + service.durationMinutes * MIN;
  const intro = service.kind === "intro";
  const holdUntil = now + RULES.holdMinutes * MIN;
  const intakeJson = JSON.stringify({ goal: intake.goal, material: intake.material, link: intake.link, notes: intake.notes });

  // One atomic batch: the booking plus every block it claims. If any block is
  // already taken, the whole thing is rolled back.
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bookings (id, customer_id, service_id, start_utc, end_utc, status, hold_expires_at, amount_cents,
           ics_uid, intake_json, client_time_zone, ip_hash, confirmed_at, client_name, client_pronouns)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      ).bind(id, customer!.id, service.id, iso(start), iso(end), intro ? "confirmed" : "held", intro ? null : iso(holdUntil),
        intro ? 0 : service.priceCents, `${id}@averywhitted.com`, intakeJson, clientTz, ipHash, intro ? iso(now) : null,
        intake.name, intake.pronouns || null),
      ...blocksFor(start, service.durationMinutes, (await scheduling(env)).bufferMinutes).map((blk) =>
        env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, id)),
    ]);
  } catch (err) {
    if (UNIQUE_CLAIM.test((err as Error).message)) throw new BookingError(409, "Sorry, that time was just taken. Please pick another.");
    throw err;
  }

  if (intro) {
    ctx.waitUntil(afterConfirm(env, id));
    return { bookingId: id, confirmationUrl: `${env.SITE_URL}/book/confirmed/?booking=${id}` };
  }

  let session: stripe.CheckoutSession;
  try {
    session = await stripe.createCheckoutSession(env, {
      bookingId: id,
      email: intake.email,
      productName: stripeProductName(service),
      description: describeTime(start, clientTz),
      amountCents: service.priceCents,
      expiresAt: holdUntil,
      successUrl: `${env.SITE_URL}/book/confirmed/?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${env.SITE_URL}/book/?service=${service.id}&checkout=cancelled`,
      promotionCodeId: (await stripe.lookupPromotionCode(env, b.promo)) ?? undefined,
    });
  } catch (err) {
    console.error("createBooking: Stripe checkout failed:", (err as Error).message);
    await env.DB.prepare("DELETE FROM bookings WHERE id = ?1").bind(id).run(); // also frees its blocks
    throw new BookingError(502, "Payment couldn't be started. Please try again in a moment.");
  }
  await env.DB.prepare("UPDATE bookings SET stripe_checkout_session_id = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(session.id, iso(now), id).run();
  return { bookingId: id, checkoutUrl: session.url! };
}

/* ── Confirm after payment ── */

export type BookingRow = {
  id: string; customer_id: string; service_id: string; start_utc: string; end_utc: string; status: string;
  hold_expires_at: string | null; amount_cents: number; stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null; zoom_meeting_id: string | null; zoom_join_url: string | null;
  calendar_event_url: string | null; ics_uid: string; ics_sequence: number; intake_json: string | null;
  client_time_zone: string | null; cancel_reason: string | null; confirmed_at: string | null;
  client_email_sent_at: string | null; admin_email_sent_at: string | null; reminder_sent_at: string | null;
  refunded_at: string | null; name: string; email: string; pronouns: string | null;
  reschedule_count: number; previous_start_utc: string | null; session_reminder_sent_at: string | null;
  package_id: string | null; promo_code: string | null;
  refund_requested_at: string | null; refund_attempts: number; refund_error: string | null; cancelled_at: string | null;
};

// The name and pronouns given with this booking (older rows fall back to the customer's).
export const CLIENT_COLUMNS = (t: string) =>
  `COALESCE(${t}.client_name, c.name) AS name, c.email, CASE WHEN ${t}.client_name IS NULL THEN c.pronouns ELSE ${t}.client_pronouns END AS pronouns`;

export async function loadBooking(env: Env, where: string, value: string): Promise<BookingRow | null> {
  return env.DB.prepare(
    `SELECT b.*, ${CLIENT_COLUMNS("b")} FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.${where} = ?1`,
  ).bind(value).first<BookingRow>();
}

/* ── Refunds ──
   Only ever for a booking that is already cancelled in the database and was
   marked as owed a refund (refund_requested_at). The database won't let such a
   booking become active again, and Stripe's idempotency key means a booking
   can't be refunded twice. Returns true once Stripe has confirmed it. */
export async function issueRefund(env: Env, bookingId: string, now = Date.now()): Promise<boolean> {
  const row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "cancelled" || !row.refund_requested_at || row.refunded_at) return !!row?.refunded_at;
  if (row.package_id || row.amount_cents <= 0 || !row.stripe_payment_intent_id) return false;
  try {
    await stripe.refundPayment(env, row.stripe_payment_intent_id, row.id);
    await env.DB.prepare("UPDATE bookings SET refunded_at = ?1, refund_error = NULL WHERE id = ?2").bind(iso(now), row.id).run();
    return true;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    console.error(`refund for ${row.id} failed:`, msg);
    await env.DB.prepare("UPDATE bookings SET refund_attempts = refund_attempts + 1, refund_error = ?1 WHERE id = ?2").bind(msg, row.id).run();
    return false;
  }
}

// Cron: keeps trying refunds that didn't go through (Avery is alerted after 15 minutes).
export async function retryRefunds(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM bookings WHERE status = 'cancelled' AND refund_requested_at IS NOT NULL AND refunded_at IS NULL
       AND refund_attempts < 12 AND refund_requested_at <= ?1 LIMIT 20`,
  ).bind(iso(now - 2 * MIN)).all<{ id: string }>();
  let done = 0;
  for (const { id } of rows.results) if (await issueRefund(env, id, now)) done++;
  return done;
}

export function view(row: BookingRow): T.BookingView {
  const service = findService(row.service_id)!;
  const intake = row.intake_json ? JSON.parse(row.intake_json) : {};
  return {
    id: row.id,
    kind: service.kind,
    serviceName: serviceLabel(service),
    durationMinutes: service.durationMinutes,
    start: Date.parse(row.start_utc),
    end: Date.parse(row.end_utc),
    clientTimeZone: row.client_time_zone || AVERY_TZ,
    amountCents: row.amount_cents,
    name: row.name,
    email: row.email,
    pronouns: row.pronouns ?? undefined,
    goal: intake.goal, material: intake.material, link: intake.link, notes: intake.notes,
    zoomUrl: row.zoom_join_url,
    bundleNote: row.package_id ? "Bundle session" : undefined,
    promoCode: row.promo_code,
  };
}

// Returns the booking id if it's now confirmed and needs its follow-up steps.
export async function confirmPaid(env: Env, session: stripe.CheckoutSession, now: number, promoCode?: string | null): Promise<string | null> {
  const row = (session.metadata?.booking_id && await loadBooking(env, "id", session.metadata.booking_id))
    || await loadBooking(env, "stripe_checkout_session_id", session.id);
  if (!row) { console.error("confirmPaid: no booking for checkout session"); return null; }
  if (row.status === "confirmed") return null; // already done (duplicate notice)
  if (row.cancel_reason === "slot_taken_after_payment") return null; // already refunded (or retrying)

  const paid = session.amount_total ?? row.amount_cents;
  const pi = session.payment_intent;

  if (row.status === "held") {
    const res = await env.DB.prepare(
      `UPDATE bookings SET status = 'confirmed', confirmed_at = ?1, hold_expires_at = NULL, amount_cents = ?2,
         stripe_payment_intent_id = ?3, promo_code = COALESCE(?5, promo_code), updated_at = ?1 WHERE id = ?4 AND status = 'held'`,
    ).bind(iso(now), paid, pi, row.id, promoCode ?? null).run();
    return res.meta.changes ? row.id : null;
  }

  // The hold had lapsed before payment arrived. Take the time back if it's still free.
  if (row.status === "cancelled" && row.cancel_reason === "hold_expired") {
    const service = findService(row.service_id)!;
    try {
      // Reactivate first (only active bookings may claim time), then claim.
      // If any block is taken, the whole batch is rolled back.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE bookings SET status = 'confirmed', cancel_reason = NULL, confirmed_at = ?1, amount_cents = ?2,
             stripe_payment_intent_id = ?3, updated_at = ?1 WHERE id = ?4 AND status = 'cancelled' AND cancel_reason = 'hold_expired'`,
        ).bind(iso(now), paid, pi, row.id),
        ...blocksFor(Date.parse(row.start_utc), service.durationMinutes, (await scheduling(env)).bufferMinutes).map((blk) =>
          env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, row.id)),
      ]);
      return row.id;
    } catch (err) {
      if (INACTIVE_CLAIM.test((err as Error).message)) return null; // its state changed meanwhile
      if (!UNIQUE_CLAIM.test((err as Error).message)) throw err;
    }
    // Someone else has it now: refund in full and tell both people. The refund
    // is recorded as owed first, so if Stripe fails it's retried by cron.
    const marked = await env.DB.prepare(
      `UPDATE bookings SET cancel_reason = 'slot_taken_after_payment', amount_cents = ?1, stripe_payment_intent_id = ?2,
         refund_requested_at = CASE WHEN ?2 IS NOT NULL AND ?1 > 0 THEN ?3 END, updated_at = ?3
       WHERE id = ?4 AND status = 'cancelled' AND cancel_reason = 'hold_expired'`,
    ).bind(paid, pi, iso(now), row.id).run();
    if (!marked.meta.changes) return null;
    const refunded = await issueRefund(env, row.id, now);
    const v = { ...view(row), amountCents: paid };
    const bookUrl = `${env.SITE_URL}/book/?service=${row.service_id}`;
    await sendEmail(env, "slot_taken_refund", row.id, T.slotTakenRefund(v, bookUrl));
    const note = T.adminNotification(v, {
      zoomMissing: false, calendarFailed: false, title: "Auto-refunded",
      notice: refunded || !pi || paid <= 0
        ? "Not booked: this client paid after their hold ran out and someone else had taken the time. They were refunded in full automatically and asked to pick a new time. Nothing was added to your calendar."
        : "Not booked: this client paid after their hold ran out and someone else had taken the time. The automatic refund hasn't gone through yet. It will keep retrying, and you'll get an alert if it doesn't. Nothing was added to your calendar.",
    });
    await sendEmail(env, "admin_slot_taken_refund", row.id, {
      ...note, to: env.ADMIN_EMAIL, subject: `Auto-refunded: ${row.name} paid after their time was taken`,
    });
    return null;
  }
  console.error(`confirmPaid: booking ${row.id} in unexpected state ${row.status}`);
  return null;
}

/* ── Follow-up after confirming ── */

// The event written to Avery's Coaching calendar, with intake answers for prep.
function averyEventIcs(row: BookingRow, v: T.BookingView): string {
  const service = findService(row.service_id)!;
  const lines = [
    `${row.name}${row.pronouns ? ` (${row.pronouns})` : ""}`, row.email, "",
    ...(v.zoomUrl ? [`Zoom: ${v.zoomUrl}`, ""] : []),
    ...(v.goal ? [`${service.kind === "intro" ? "Wants to talk about" : "Goal"}: ${v.goal}`] : []),
    ...(v.material ? [`Material: ${v.material}`] : []),
    ...(v.link ? [`Link: ${v.link}`] : []),
    ...(v.notes ? [`Notes: ${v.notes}`] : []),
    "", v.amountCents ? `Paid ${(v.amountCents / 100).toFixed(2)} USD` : "Free",
  ];
  return buildIcs({
    uid: row.ics_uid, sequence: row.ics_sequence, start: v.start, end: v.end,
    summary: service.kind === "intro" ? `Intro chat: ${row.name}` : `Coaching: ${row.name} (${v.serviceName.replace(/ session$/, "")})`,
    description: lines.join("\n"), location: v.zoomUrl ?? "Zoom",
  });
}

// The invite attached to the client's emails (same UID for the booking's whole life).
function clientIcs(env: Env, row: BookingRow, v: T.BookingView, method: "REQUEST" | "CANCEL"): string {
  return buildIcs({
    uid: row.ics_uid, sequence: row.ics_sequence, start: v.start, end: v.end, method, cancelled: method === "CANCEL",
    summary: v.kind === "intro" ? "Intro chat with Avery Whitted" : "Private coaching with Avery Whitted",
    description: `${v.zoomUrl ? `Join on Zoom: ${v.zoomUrl}\n\n` : ""}Reschedule or cancel up to 24 hours before using the link in your confirmation email.`,
    location: v.zoomUrl ?? "Zoom (link to follow)",
    organizer: { name: "Avery Whitted", email: env.EMAIL_REPLY_TO },
    attendee: { name: row.name, email: row.email },
  });
}

export async function afterConfirm(env: Env, bookingId: string): Promise<void> {
  let row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "confirmed") return;
  const service = findService(row.service_id)!;
  const start = Date.parse(row.start_utc);
  const end = Date.parse(row.end_utc);

  // 1. Zoom
  if (!row.zoom_join_url) {
    const meeting = await createMeeting(env, {
      topic: service.kind === "intro" ? `Intro chat: ${row.name} + Avery Whitted` : `Coaching: ${row.name} + Avery Whitted`,
      start, durationMinutes: service.durationMinutes,
    });
    const url = meeting?.joinUrl ?? env.ZOOM_FALLBACK_URL ?? null;
    if (url) {
      await env.DB.prepare("UPDATE bookings SET zoom_meeting_id = ?1, zoom_join_url = ?2 WHERE id = ?3")
        .bind(meeting?.id ?? null, url, row.id).run();
      row = { ...row, zoom_meeting_id: meeting?.id ?? null, zoom_join_url: url };
    }
  }
  const v = view(row);
  if (row.package_id) {
    const pkg = await env.DB.prepare("SELECT credits_total, credits_used FROM packages WHERE id = ?1").bind(row.package_id)
      .first<{ credits_total: number; credits_used: number }>();
    if (pkg) v.bundleNote = `Bundle session (${pkg.credits_total - pkg.credits_used} of ${pkg.credits_total} left)`;
  }

  // 2. Avery's Coaching calendar (includes the intake answers for prep)
  let calendarFailed = false;
  if (!row.calendar_event_url) {
    try {
      const url = await calendarFor(env, await scheduling(env)).putEvent(row.ics_uid, averyEventIcs(row, v));
      await env.DB.prepare("UPDATE bookings SET calendar_event_url = ?1 WHERE id = ?2").bind(url, row.id).run();
    } catch (err) {
      calendarFailed = true;
      console.error("afterConfirm: calendar write failed:", (err as Error).message);
    }
  }

  // Cancelled while this was running: stop here (cron removes anything just created).
  const still = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?1").bind(row.id).first<{ status: string }>();
  if (still?.status !== "confirmed") return;

  // 3. Client confirmation with calendar invite
  if (!row.client_email_sent_at) {
    const ics = clientIcs(env, row, v, "REQUEST");
    if (await sendEmail(env, "client_confirmation", row.id, T.clientConfirmation(v, ics, await manageUrl(env, row.id)))) {
      await env.DB.prepare("UPDATE bookings SET client_email_sent_at = ?1 WHERE id = ?2").bind(iso(Date.now()), row.id).run();
    }
  }

  // 4. Notice to Avery
  if (!row.admin_email_sent_at) {
    const note = T.adminNotification(v, { zoomMissing: !v.zoomUrl, calendarFailed });
    if (await sendEmail(env, "admin_notification", row.id, { ...note, to: env.ADMIN_EMAIL })) {
      await env.DB.prepare("UPDATE bookings SET admin_email_sent_at = ?1 WHERE id = ?2").bind(iso(Date.now()), row.id).run();
    }
  }
}

/* ── Holds that ran out ── */

async function releaseHold(env: Env, id: string, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET status = 'cancelled', cancel_reason = 'hold_expired', hold_expires_at = NULL, updated_at = ?1
       WHERE id = ?2 AND status = 'held'`,
    ).bind(iso(now), id),
    env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(id),
  ]);
}

// Called when Stripe reports a checkout expired.
export async function releaseForSession(env: Env, sessionId: string, now: number): Promise<void> {
  const row = await loadBooking(env, "stripe_checkout_session_id", sessionId);
  if (row && row.status === "held") await releaseHold(env, row.id, now);
}

export async function expireHolds(env: Env, now: number): Promise<{ released: number; confirmed: number }> {
  const due = await env.DB.prepare(
    "SELECT id, stripe_checkout_session_id FROM bookings WHERE status = 'held' AND hold_expires_at <= ?1 LIMIT 50",
  ).bind(iso(now)).all<{ id: string; stripe_checkout_session_id: string | null }>();
  let released = 0;
  let confirmed = 0;
  for (const h of due.results) {
    try {
      if (h.stripe_checkout_session_id) {
        const s = await stripe.expireCheckoutSession(env, h.stripe_checkout_session_id);
        // Paid just in time but Stripe's notice hasn't arrived yet: confirm instead.
        if (s.status === "complete" && stripe.isPaid(s)) {
          const id = await confirmPaid(env, s, now);
          if (id) { await afterConfirm(env, id); confirmed++; }
          continue;
        }
      }
      await releaseHold(env, h.id, now);
      released++;
    } catch (err) {
      console.error("expireHolds:", (err as Error).message);
    }
  }
  return { released, confirmed };
}

/* ── "Finish your booking" reminders ── */

export async function sendReminders(env: Env, now: number): Promise<number> {
  if (!(await scheduling(env)).remindersEnabled) return 0;
  const rows = await env.DB.prepare(
    `SELECT b.id FROM bookings b
     WHERE b.status = 'cancelled' AND b.cancel_reason = 'hold_expired' AND b.reminder_sent_at IS NULL
       AND b.updated_at >= ?1 AND b.start_utc > ?2
       AND (SELECT COUNT(*) FROM email_log e WHERE e.booking_id = b.id AND e.kind = 'checkout_reminder') < 3
       AND NOT EXISTS (
         SELECT 1 FROM bookings o WHERE o.customer_id = b.customer_id AND o.id <> b.id
           AND o.created_at >= b.created_at AND o.status IN ('held', 'confirmed'))
       -- At most one reminder per person per week, so nobody can use this to spam an address.
       AND NOT EXISTS (
         SELECT 1 FROM bookings r WHERE r.customer_id = b.customer_id AND r.reminder_sent_at >= ?3)
       AND NOT EXISTS (
         SELECT 1 FROM packages r WHERE r.customer_id = b.customer_id AND r.reminder_sent_at >= ?3)
     LIMIT 20`,
  ).bind(iso(now - 24 * 60 * MIN), iso(now + RULES.minNoticeHours * 60 * MIN), iso(now - 7 * 24 * 60 * MIN)).all<{ id: string }>();
  let sent = 0;
  for (const { id } of rows.results) {
    const row = await loadBooking(env, "id", id);
    if (!row) continue;
    const bookUrl = `${env.SITE_URL}/book/?service=${row.service_id}`;
    if (await sendEmail(env, "checkout_reminder", id, T.checkoutReminder(view(row), bookUrl))) {
      await env.DB.prepare("UPDATE bookings SET reminder_sent_at = ?1 WHERE id = ?2").bind(iso(now), id).run();
      sent++;
    }
  }
  return sent;
}

/* ── Retry anything that failed after confirming ── */

export async function retryConfirmations(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT b.id FROM bookings b
     WHERE b.status = 'confirmed' AND b.end_utc > ?1 AND b.confirmed_at <= ?2
       AND (b.calendar_event_url IS NULL OR b.client_email_sent_at IS NULL OR b.admin_email_sent_at IS NULL)
       AND (SELECT COUNT(*) FROM email_log e WHERE e.booking_id = b.id AND e.status = 'failed') < 5
     LIMIT 20`,
  ).bind(iso(now), iso(now - 2 * MIN)).all<{ id: string }>();
  for (const { id } of rows.results) await afterConfirm(env, id);
  return rows.results.length;
}

/* ── What the confirmation page may show (no personal details) ── */

export async function publicStatus(env: Env, by: "booking" | "session", value: string) {
  const row = await loadBooking(env, by === "booking" ? "id" : "stripe_checkout_session_id", value);
  if (!row) return null;
  const service = findService(row.service_id)!;
  const status = row.status === "confirmed" ? "confirmed"
    : row.status === "held" ? "processing"
    : row.cancel_reason === "slot_taken_after_payment" ? "refunded"
    : "cancelled";
  return {
    status,
    service: serviceLabel(service),
    kind: service.kind,
    durationMinutes: service.durationMinutes,
    start: row.start_utc,
    end: row.end_utc,
    timeZone: row.client_time_zone || AVERY_TZ,
    firstName: row.name.trim().split(/\s+/)[0],
    icsUid: row.ics_uid, // lets "Add to calendar" update the same event as the emailed invite
  };
}

/* ── Client self-service: view, cancel, reschedule (from the manage link) ── */

export const CHANGE_CUTOFF_HOURS = 24;
export const MAX_RESCHEDULES = 3;

async function loadManaged(env: Env, bookingId: unknown, token: unknown): Promise<BookingRow> {
  // Same answer for a wrong link and a missing booking, so links can't be probed.
  if (!(await validManageToken(env, bookingId, token))) throw new BookingError(404, "We couldn't find that booking. Please use the link in your confirmation email.");
  const row = await loadBooking(env, "id", bookingId as string);
  if (!row) throw new BookingError(404, "We couldn't find that booking. Please use the link in your confirmation email.");
  return row;
}

const canChange = (row: BookingRow, now: number) =>
  row.status === "confirmed" && Date.parse(row.start_utc) - now >= CHANGE_CUTOFF_HOURS * 60 * MIN;

export async function manageView(env: Env, bookingId: unknown, token: unknown, now: number) {
  const row = await loadManaged(env, bookingId, token);
  const service = findService(row.service_id)!;
  const past = Date.parse(row.end_utc) <= now;
  return {
    status: row.status === "confirmed" ? (past ? "past" : "confirmed") : row.status === "cancelled" ? "cancelled" : "pending",
    canChange: canChange(row, now),
    canReschedule: canChange(row, now) && row.reschedule_count < MAX_RESCHEDULES,
    cutoffHours: CHANGE_CUTOFF_HOURS,
    serviceId: row.service_id,
    service: serviceLabel(service),
    kind: service.kind,
    durationMinutes: service.durationMinutes,
    start: row.start_utc,
    end: row.end_utc,
    timeZone: row.client_time_zone || AVERY_TZ,
    firstName: row.name.trim().split(/\s+/)[0],
    zoomUrl: row.status === "confirmed" ? row.zoom_join_url : null,
    amountCents: row.amount_cents,
    cancelReason: row.cancel_reason,
    // Bundle sessions link back to the bundle page, and must stay before its use-by date.
    bundleUrl: row.package_id ? await packageUrl(env, row.package_id) : null,
    bundleExpiresAt: row.package_id
      ? (await env.DB.prepare("SELECT expires_at FROM packages WHERE id = ?1").bind(row.package_id).first<{ expires_at: string | null }>())?.expires_at ?? null
      : null,
  };
}

export function stripePaymentUrl(env: Env, pi: string | null): string | null {
  if (!pi) return null;
  const test = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "");
  return `https://dashboard.stripe.com/${test ? "test/" : ""}payments/${encodeURIComponent(pi)}`;
}

export async function cancelBooking(env: Env, bookingId: unknown, token: unknown, ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const row = await loadManaged(env, bookingId, token);
  if (row.status === "cancelled") throw new BookingError(409, "This session is already cancelled.");
  if (row.status !== "confirmed") throw new BookingError(409, "This booking can't be cancelled online. Please email info@averywhitted.com.");
  if (!canChange(row, ctx.now)) {
    throw new BookingError(403, `Sessions can only be changed online until ${CHANGE_CUTOFF_HOURS} hours before they start. Please email info@averywhitted.com.`);
  }
  // A paid single session cancelled in time is refunded in full automatically.
  // The refund is only sent after this cancellation is saved, and only by the
  // one request that actually made the change.
  const owesRefund = !row.package_id && row.amount_cents > 0 && !!row.stripe_payment_intent_id;
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE bookings SET status = 'cancelled', cancel_reason = 'client_cancelled', cancelled_at = ?1,
           refund_requested_at = ?3, ics_sequence = ics_sequence + 1, updated_at = ?1 WHERE id = ?2 AND status = 'confirmed'`,
      ).bind(iso(ctx.now), row.id, owesRefund ? iso(ctx.now) : null),
      env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(row.id),
      // Cancelled at least 24 hours ahead: the session goes back into the bundle.
      // The ledger entry can only be written once per booking, so a second
      // cancellation arriving at the same moment is rolled back entirely.
      ...(row.package_id ? [
        env.DB.prepare("INSERT INTO credit_ledger (package_id, booking_id, delta, reason) VALUES (?1, ?2, 1, 'cancelled_in_time')").bind(row.package_id, row.id),
        env.DB.prepare("UPDATE packages SET credits_used = credits_used - 1, updated_at = ?1 WHERE id = ?2").bind(iso(ctx.now), row.package_id),
      ] : []),
    ]);
  } catch (err) {
    if (ONCE_ONLY.test((err as Error).message)) throw new BookingError(409, "This session is already cancelled.");
    throw err;
  }
  if (!res[0].meta.changes) throw new BookingError(409, "This session is already cancelled.");
  ctx.waitUntil((async () => {
    if (owesRefund) await issueRefund(env, row.id, ctx.now);
    await afterCancelShared(env, row.id, { notifyClient: true, notifyAvery: true });
  })());
  return { ok: true };
}

// Removes the calendar event and Zoom meeting (recording that they're gone, so
// anything that failed is retried), then emails whoever should hear about it.
export async function afterCancelShared(env: Env, bookingId: string, opts: { notifyClient: boolean; notifyAvery: boolean }): Promise<void> {
  const row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "cancelled") return;
  const v = view(row);
  const removed = await removeCancelled(env, row);
  const refund: T.RefundState = row.package_id || row.amount_cents <= 0 ? "none"
    : row.refunded_at ? "refunded" : row.refund_requested_at ? "pending" : "offer";
  const againUrl = row.package_id ? await packageUrl(env, row.package_id) : `${env.SITE_URL}/book/`;
  const creditReturned = !row.package_id || !!(await env.DB.prepare(
    "SELECT 1 AS ok FROM credit_ledger WHERE booking_id = ?1 AND delta > 0 AND reason IN ('cancelled_in_time', 'avery_cancelled')",
  ).bind(row.id).first());
  if (opts.notifyClient) await sendEmail(env, "client_cancelled", row.id, T.clientCancelled(v, clientIcs(env, row, v, "CANCEL"), againUrl, refund, creditReturned));
  if (opts.notifyAvery) {
    await sendEmail(env, "admin_cancelled", row.id, {
      ...T.adminCancelled(v, stripePaymentUrl(env, row.stripe_payment_intent_id), { refund, ...removed }), to: env.ADMIN_EMAIL,
    });
  }
}

// Deletes a cancelled booking's calendar event and Zoom meeting. Each is
// forgotten only once it's really gone; cron retries whatever is left.
async function removeCancelled(env: Env, row: BookingRow): Promise<{ calendarRemoved: boolean; zoomRemoved: boolean }> {
  let calendarRemoved = !row.calendar_event_url;
  let zoomRemoved = !row.zoom_meeting_id;
  if (row.calendar_event_url) {
    try {
      await calendarFor(env).deleteEvent(row.calendar_event_url);
      await env.DB.prepare("UPDATE bookings SET calendar_event_url = NULL WHERE id = ?1 AND status = 'cancelled'").bind(row.id).run();
      calendarRemoved = true;
    } catch (err) { console.error("cancel: calendar delete failed:", (err as Error).message); }
  }
  if (row.zoom_meeting_id) {
    try {
      await deleteMeeting(env, row.zoom_meeting_id);
      await env.DB.prepare("UPDATE bookings SET zoom_meeting_id = NULL WHERE id = ?1 AND status = 'cancelled'").bind(row.id).run();
      zoomRemoved = true;
    } catch (err) { console.error("cancel: zoom delete failed:", (err as Error).message); }
  }
  return { calendarRemoved, zoomRemoved };
}

// Cron: finishes removing cancelled sessions from the calendar and Zoom.
export async function cleanUpCancelled(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM bookings WHERE status = 'cancelled' AND (calendar_event_url IS NOT NULL OR zoom_meeting_id IS NOT NULL)
       AND updated_at <= ?1 LIMIT 20`,
  ).bind(iso(now - 2 * MIN)).all<{ id: string }>();
  for (const { id } of rows.results) {
    const row = await loadBooking(env, "id", id);
    if (row) await removeCancelled(env, row);
  }
  return rows.results.length;
}

export async function rescheduleBooking(env: Env, bookingId: unknown, token: unknown, newStartRaw: unknown,
  ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const row = await loadManaged(env, bookingId, token);
  if (row.status !== "confirmed") throw new BookingError(409, "This session can't be rescheduled because it isn't active.");
  if (!canChange(row, ctx.now)) {
    throw new BookingError(403, `Sessions can only be changed online until ${CHANGE_CUTOFF_HOURS} hours before they start. Please email info@averywhitted.com.`);
  }
  if (row.reschedule_count >= MAX_RESCHEDULES) {
    throw new BookingError(403, "This session has already been moved a few times. Please email info@averywhitted.com to change it again.");
  }
  const service = findService(row.service_id)!;
  const newStart = Date.parse(String(newStartRaw ?? ""));
  if (!Number.isFinite(newStart)) throw new BookingError(400, "Please pick a new time.");
  if (row.package_id) {
    const pkg = await env.DB.prepare("SELECT expires_at FROM packages WHERE id = ?1").bind(row.package_id).first<{ expires_at: string | null }>();
    if (pkg?.expires_at && newStart >= Date.parse(pkg.expires_at)) {
      throw new BookingError(409, "Bundle sessions need to take place before the bundle's use-by date. Please pick an earlier time.");
    }
  }
  if (newStart === Date.parse(row.start_utc)) throw new BookingError(400, "That's already your session time.");
  if (!(await isStillOpen(env, service, newStart, ctx.now, { bookingId: row.id, uid: row.ics_uid }))) {
    throw new BookingError(409, "Sorry, that time was just taken. Please pick another.");
  }
  const newEnd = newStart + service.durationMinutes * MIN;
  // If the booking was cancelled a moment ago, the database refuses the new
  // claims (only active bookings can hold time) and nothing changes.
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(row.id),
      ...blocksFor(newStart, service.durationMinutes, (await scheduling(env)).bufferMinutes).map((blk) =>
        env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, row.id)),
      env.DB.prepare(
        `UPDATE bookings SET previous_start_utc = start_utc, start_utc = ?1, end_utc = ?2, ics_sequence = ics_sequence + 1,
           reschedule_count = reschedule_count + 1, session_reminder_sent_at = NULL, updated_at = ?3 WHERE id = ?4 AND status = 'confirmed'`,
      ).bind(iso(newStart), iso(newEnd), iso(ctx.now), row.id),
    ]);
  } catch (err) {
    if (UNIQUE_CLAIM.test((err as Error).message)) throw new BookingError(409, "Sorry, that time was just taken. Please pick another.");
    if (INACTIVE_CLAIM.test((err as Error).message)) throw new BookingError(409, "This session can't be rescheduled because it isn't active.");
    throw err;
  }
  if (!res.at(-1)!.meta.changes) throw new BookingError(409, "This session can't be rescheduled because it isn't active.");
  ctx.waitUntil(afterReschedule(env, row.id));
  return { ok: true, start: iso(newStart), end: iso(newEnd) };
}

async function afterReschedule(env: Env, bookingId: string): Promise<void> {
  const row = await loadBooking(env, "id", bookingId);
  // Never touch the calendar or Zoom for a booking that's no longer active.
  if (!row || row.status !== "confirmed" || !row.previous_start_utc) return;
  const v = view(row);
  const previous = Date.parse(row.previous_start_utc);
  if (row.zoom_meeting_id) {
    try { await updateMeeting(env, row.zoom_meeting_id, { start: v.start, durationMinutes: v.durationMinutes }); }
    catch (err) { console.error("afterReschedule: zoom update failed:", (err as Error).message); }
  }
  let calendarFailed = false;
  try {
    const url = await calendarFor(env, await scheduling(env)).putEvent(row.ics_uid, averyEventIcs(row, v), row.calendar_event_url);
    // Always recorded: if the booking was cancelled meanwhile, cron removes it again.
    await env.DB.prepare("UPDATE bookings SET calendar_event_url = ?1 WHERE id = ?2").bind(url, row.id).run();
  } catch (err) {
    calendarFailed = true;
    console.error("afterReschedule: calendar update failed:", (err as Error).message);
  }
  await sendEmail(env, "client_rescheduled", row.id, T.clientRescheduled(v, previous, clientIcs(env, row, v, "REQUEST"), await manageUrl(env, row.id)));
  await sendEmail(env, "admin_rescheduled", row.id, { ...T.adminRescheduled(v, previous, { calendarFailed }), to: env.ADMIN_EMAIL });
}

/* ── Day-before session reminders ── */

export async function sendSessionReminders(env: Env, now: number): Promise<number> {
  // Due once a session is within 24 hours. Skipped for bookings confirmed in the
  // last 2 hours, since they just got their confirmation email.
  const rows = await env.DB.prepare(
    `SELECT b.id FROM bookings b
     WHERE b.status = 'confirmed' AND b.session_reminder_sent_at IS NULL
       AND b.start_utc > ?1 AND b.start_utc <= ?2 AND b.confirmed_at <= ?3
       AND (SELECT COUNT(*) FROM email_log e WHERE e.booking_id = b.id AND e.kind = 'session_reminder') < 3
     LIMIT 25`,
  ).bind(iso(now + 60 * MIN), iso(now + 24 * 60 * MIN), iso(now - 120 * MIN)).all<{ id: string }>();
  let sent = 0;
  for (const { id } of rows.results) {
    const row = await loadBooking(env, "id", id);
    if (!row) continue;
    if (await sendEmail(env, "session_reminder", id, T.sessionReminder(view(row), now))) {
      await env.DB.prepare("UPDATE bookings SET session_reminder_sent_at = ?1 WHERE id = ?2").bind(iso(now), id).run();
      sent++;
    }
  }
  return sent;
}

/* ── Keeping only what's needed (privacy policy: answers deleted after 2 years) ── */

export async function runRetention(env: Env, now: number): Promise<number> {
  const twoYears = iso(now - 730 * 24 * 60 * MIN);
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET intake_json = NULL WHERE intake_json IS NOT NULL AND end_utc < ?1").bind(twoYears),
    env.DB.prepare("UPDATE packages SET intake_json = NULL WHERE intake_json IS NOT NULL AND expires_at < ?1").bind(twoYears),
    env.DB.prepare("DELETE FROM email_log WHERE created_at < ?1").bind(iso(now - 365 * 24 * 60 * MIN)),
    env.DB.prepare("DELETE FROM processed_webhooks WHERE processed_at < ?1").bind(iso(now - 90 * 24 * 60 * MIN)),
  ]);
  return res[0].meta.changes;
}

/* ── Telling Avery when something needs a human ── */

export async function checkAlerts(env: Env, now: number): Promise<string[]> {
  const last = await env.DB.prepare("SELECT last_sent_at FROM alerts_sent WHERE kind = 'attention'").first<{ last_sent_at: string }>();
  if (last && Date.parse(last.last_sent_at) > now - 60 * MIN) return [];
  const since = last?.last_sent_at ?? iso(now - 24 * 60 * MIN);
  const problems: string[] = [];

  const failedEmails = await env.DB.prepare(
    `SELECT e.kind, COUNT(*) AS n FROM email_log e
     WHERE e.status = 'failed' AND e.created_at > ?1 AND e.kind <> 'attention_alert'
     GROUP BY e.kind`,
  ).bind(since).all<{ kind: string; n: number }>();
  for (const f of failedEmails.results) problems.push(`${f.n} "${f.kind.replace(/_/g, " ")}" email${f.n === 1 ? "" : "s"} failed to send.`);

  const stuck = await env.DB.prepare(
    `SELECT b.start_utc, ${CLIENT_COLUMNS("b")}, b.calendar_event_url IS NULL AS no_cal, b.client_email_sent_at IS NULL AS no_email
     FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.status = 'confirmed' AND b.end_utc > ?1 AND b.confirmed_at <= ?2
       AND (b.calendar_event_url IS NULL OR b.client_email_sent_at IS NULL)
     LIMIT 10`,
  ).bind(iso(now), iso(now - 15 * MIN)).all<{ start_utc: string; name: string; no_cal: number; no_email: number }>();
  for (const s of stuck.results) {
    const when = new Intl.DateTimeFormat("en-US", { timeZone: AVERY_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(Date.parse(s.start_utc));
    const missing = [s.no_cal ? "isn't in your Coaching calendar" : "", s.no_email ? "hasn't received their confirmation email" : ""].filter(Boolean).join(" and ");
    problems.push(`${s.name}'s session on ${when} ${missing}.`);
  }

  const unsentBundles = await env.DB.prepare(
    `SELECT c.name FROM packages p JOIN customers c ON c.id = p.customer_id
     WHERE p.status = 'active' AND p.confirmation_sent_at IS NULL AND p.updated_at <= ?1 LIMIT 10`,
  ).bind(iso(now - 15 * MIN)).all<{ name: string }>();
  for (const p of unsentBundles.results) problems.push(`${p.name} bought a bundle but hasn't received their bundle email.`);

  const stuckRefunds = await env.DB.prepare(
    `SELECT b.amount_cents, b.refund_error, ${CLIENT_COLUMNS("b")} FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.status = 'cancelled' AND b.refund_requested_at IS NOT NULL AND b.refunded_at IS NULL AND b.refund_requested_at <= ?1 LIMIT 10`,
  ).bind(iso(now - 15 * MIN)).all<{ amount_cents: number; refund_error: string | null; name: string }>();
  for (const r of stuckRefunds.results) {
    problems.push(`The automatic refund of $${(r.amount_cents / 100).toFixed(2)} to ${r.name} hasn't gone through${r.refund_error ? ` (Stripe said: ${r.refund_error})` : ""}. It keeps retrying; you can also refund it in Stripe.`);
  }

  const leftOver = await env.DB.prepare(
    `SELECT b.start_utc, ${CLIENT_COLUMNS("b")} FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.status = 'cancelled' AND b.calendar_event_url IS NOT NULL AND b.updated_at <= ?1 AND b.end_utc > ?2 LIMIT 10`,
  ).bind(iso(now - 15 * MIN), iso(now)).all<{ start_utc: string; name: string }>();
  for (const s of leftOver.results) {
    const when = new Intl.DateTimeFormat("en-US", { timeZone: AVERY_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(Date.parse(s.start_utc));
    problems.push(`${s.name}'s session on ${when} is cancelled but couldn't be removed from your Coaching calendar yet. Please delete it by hand; it isn't happening.`);
  }

  if (!problems.length) return [];
  await sendEmail(env, "attention_alert", null, { ...T.attentionAlert(problems), to: env.ADMIN_EMAIL });
  await env.DB.prepare(
    "INSERT INTO alerts_sent (kind, last_sent_at) VALUES ('attention', ?1) ON CONFLICT(kind) DO UPDATE SET last_sent_at = excluded.last_sent_at",
  ).bind(iso(now)).run();
  return problems;
}
