// The booking lifecycle:
//
//   createBooking   client submits the form. We re-check the time live, then
//                   hold it (claiming its 15-minute blocks) and send paid
//                   bookings to Stripe. Free intro calls are confirmed at once.
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
import { createMeeting } from "./zoom";
import { sendEmail } from "./email";
import { buildIcs } from "./ics";
import * as T from "./templates";
import { verifyHuman } from "./turnstile";

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
  if (service.kind !== "intro" && !intake.material) throw new BookingError(400, "Please add the material you'd like to work on (\"not sure yet\" is fine).");
  if (intake.link) {
    let ok = false;
    try { ok = ["http:", "https:"].includes(new URL(intake.link).protocol); } catch { /* not a URL */ }
    if (!ok) throw new BookingError(400, "The materials link should start with https://");
  }
  if (r.policyAccepted !== true) throw new BookingError(400, "Please accept the reschedule and cancellation policy.");
  return intake;
}

/* ── Helpers ── */

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function serviceLabel(s: Service): string {
  if (s.kind === "intro") return "Intro call";
  return s.durationMinutes === 60 ? "1 hour session" : `${s.durationMinutes} minute session`;
}

function stripeProductName(s: Service): string {
  return s.kind === "intro" ? "Intro call" : `Private coaching, ${s.durationMinutes === 60 ? "1 hour" : `${s.durationMinutes} minutes`}`;
}

function describeTime(start: number, tz: string): string {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(start);
  return `${d} on Zoom`;
}

const UNIQUE_CLAIM = /UNIQUE constraint failed: slot_claims/i;

// Is this exact start time still offered right now (live calendar + bookings)?
export async function isStillOpen(env: Env, service: Service, start: number, now: number): Promise<boolean> {
  const [y, m, d] = zonedDate(start, AVERY_TZ);
  const from = zonedToUtc(y, m, d, 0, 0, AVERY_TZ);
  const to = from + 24 * 60 * MIN;
  const busy = await calendarFor(env).getBusy(from, to);
  const rows = await env.DB.prepare(
    `SELECT sc.slot_start FROM slot_claims sc JOIN bookings b ON b.id = sc.booking_id
     WHERE sc.slot_start >= ?1 AND sc.slot_start < ?2
       AND (b.status = 'confirmed' OR (b.status = 'held' AND b.hold_expires_at > ?3))`,
  ).bind(iso(from - 60 * MIN), iso(to + 60 * MIN), iso(now)).all<{ slot_start: string }>();
  const claimed = new Set(rows.results.map((r) => r.slot_start));
  return openSlots({ durationMinutes: service.durationMinutes, from, to, now, busy, claimed }).includes(iso(start));
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
      throw new BookingError(409, "You already have an intro call coming up. Check your email for the details, or reply to it to change the time.");
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
           ics_uid, intake_json, client_time_zone, ip_hash, confirmed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(id, customer!.id, service.id, iso(start), iso(end), intro ? "confirmed" : "held", intro ? null : iso(holdUntil),
        intro ? 0 : service.priceCents, `${id}@averywhitted.com`, intakeJson, clientTz, ipHash, intro ? iso(now) : null),
      ...blocksFor(start, service.durationMinutes).map((blk) =>
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

type BookingRow = {
  id: string; customer_id: string; service_id: string; start_utc: string; end_utc: string; status: string;
  hold_expires_at: string | null; amount_cents: number; stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null; zoom_meeting_id: string | null; zoom_join_url: string | null;
  calendar_event_url: string | null; ics_uid: string; ics_sequence: number; intake_json: string | null;
  client_time_zone: string | null; cancel_reason: string | null; confirmed_at: string | null;
  client_email_sent_at: string | null; admin_email_sent_at: string | null; reminder_sent_at: string | null;
  refunded_at: string | null; name: string; email: string; pronouns: string | null;
};

async function loadBooking(env: Env, where: string, value: string): Promise<BookingRow | null> {
  return env.DB.prepare(
    `SELECT b.*, c.name, c.email, c.pronouns FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.${where} = ?1`,
  ).bind(value).first<BookingRow>();
}

function view(row: BookingRow): T.BookingView {
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
  };
}

// Returns the booking id if it's now confirmed and needs its follow-up steps.
export async function confirmPaid(env: Env, session: stripe.CheckoutSession, now: number): Promise<string | null> {
  const row = (session.metadata?.booking_id && await loadBooking(env, "id", session.metadata.booking_id))
    || await loadBooking(env, "stripe_checkout_session_id", session.id);
  if (!row) { console.error("confirmPaid: no booking for checkout session"); return null; }
  if (row.status === "confirmed") return null; // already done (duplicate notice)

  const paid = session.amount_total ?? row.amount_cents;
  const pi = session.payment_intent;

  if (row.status === "held") {
    const res = await env.DB.prepare(
      `UPDATE bookings SET status = 'confirmed', confirmed_at = ?1, hold_expires_at = NULL, amount_cents = ?2,
         stripe_payment_intent_id = ?3, updated_at = ?1 WHERE id = ?4 AND status = 'held'`,
    ).bind(iso(now), paid, pi, row.id).run();
    return res.meta.changes ? row.id : null;
  }

  // The hold had lapsed before payment arrived. Take the time back if it's still free.
  if (row.status === "cancelled" && row.cancel_reason === "hold_expired") {
    const service = findService(row.service_id)!;
    try {
      await env.DB.batch([
        ...blocksFor(Date.parse(row.start_utc), service.durationMinutes).map((blk) =>
          env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, row.id)),
        env.DB.prepare(
          `UPDATE bookings SET status = 'confirmed', cancel_reason = NULL, confirmed_at = ?1, amount_cents = ?2,
             stripe_payment_intent_id = ?3, updated_at = ?1 WHERE id = ?4`,
        ).bind(iso(now), paid, pi, row.id),
      ]);
      return row.id;
    } catch (err) {
      if (!UNIQUE_CLAIM.test((err as Error).message)) throw err;
    }
    // Someone else has it now: refund in full and tell both people.
    await env.DB.prepare(
      `UPDATE bookings SET cancel_reason = 'slot_taken_after_payment', amount_cents = ?1, stripe_payment_intent_id = ?2, updated_at = ?3 WHERE id = ?4`,
    ).bind(paid, pi, iso(now), row.id).run();
    if (pi) {
      await stripe.refundPayment(env, pi, row.id);
      await env.DB.prepare("UPDATE bookings SET refunded_at = ?1 WHERE id = ?2").bind(iso(now), row.id).run();
    }
    const v = { ...view(row), amountCents: paid };
    const bookUrl = `${env.SITE_URL}/book/?service=${row.service_id}`;
    await sendEmail(env, "slot_taken_refund", row.id, T.slotTakenRefund(v, bookUrl));
    const note = T.adminNotification(v, {
      zoomMissing: false, calendarFailed: false,
      notice: "Not booked: this client paid after their hold ran out and someone else had taken the time. They were refunded in full automatically and asked to pick a new time. Nothing was added to your calendar.",
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

export async function afterConfirm(env: Env, bookingId: string): Promise<void> {
  let row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "confirmed") return;
  const service = findService(row.service_id)!;
  const start = Date.parse(row.start_utc);
  const end = Date.parse(row.end_utc);

  // 1. Zoom
  if (!row.zoom_join_url) {
    const meeting = await createMeeting(env, {
      topic: service.kind === "intro" ? `Intro call: ${row.name} + Avery Whitted` : `Coaching: ${row.name} + Avery Whitted`,
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

  // 2. Avery's Coaching calendar (includes the intake answers for prep)
  let calendarFailed = false;
  if (!row.calendar_event_url) {
    const lines = [
      `${row.name}${row.pronouns ? ` (${row.pronouns})` : ""}`, row.email, "",
      ...(v.zoomUrl ? [`Zoom: ${v.zoomUrl}`, ""] : []),
      ...(v.goal ? [`${service.kind === "intro" ? "Wants to talk about" : "Goal"}: ${v.goal}`] : []),
      ...(v.material ? [`Material: ${v.material}`] : []),
      ...(v.link ? [`Link: ${v.link}`] : []),
      ...(v.notes ? [`Notes: ${v.notes}`] : []),
      "", v.amountCents ? `Paid ${(v.amountCents / 100).toFixed(2)} USD` : "Free",
    ];
    try {
      const url = await calendarFor(env).putEvent(row.ics_uid, buildIcs({
        uid: row.ics_uid, sequence: row.ics_sequence, start, end,
        summary: service.kind === "intro" ? `Intro call: ${row.name}` : `Coaching: ${row.name} (${v.serviceName.replace(/ session$/, "")})`,
        description: lines.join("\n"), location: v.zoomUrl ?? "Zoom",
      }));
      await env.DB.prepare("UPDATE bookings SET calendar_event_url = ?1 WHERE id = ?2").bind(url, row.id).run();
    } catch (err) {
      calendarFailed = true;
      console.error("afterConfirm: calendar write failed:", (err as Error).message);
    }
  }

  // 3. Client confirmation with calendar invite
  if (!row.client_email_sent_at) {
    const ics = buildIcs({
      uid: row.ics_uid, sequence: row.ics_sequence, start, end, method: "REQUEST",
      summary: service.kind === "intro" ? "Intro call with Avery Whitted" : "Private coaching with Avery Whitted",
      description: `${v.zoomUrl ? `Join on Zoom: ${v.zoomUrl}\n\n` : ""}To reschedule or cancel, reply to your confirmation email at least 24 hours before.`,
      location: v.zoomUrl ?? "Zoom (link to follow)",
      organizer: { name: "Avery Whitted", email: env.EMAIL_REPLY_TO },
      attendee: { name: row.name, email: row.email },
    });
    if (await sendEmail(env, "client_confirmation", row.id, T.clientConfirmation(v, ics))) {
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
        if (s.status === "complete" && s.payment_status === "paid") {
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
  if (env.REMINDERS_ENABLED !== "1") return 0;
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
  };
}
