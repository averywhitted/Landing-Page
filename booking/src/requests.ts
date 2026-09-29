// Payment requests: Avery asks a student to pay an amount for one of their
// sessions (for example one that went ahead before it was paid for). The
// student pays from their session page; the link in the email opens checkout.
//
// Safety: a request can only be paid once. If a second payment, or a payment
// for a request Avery has since cancelled, comes through, it's refunded in
// full automatically.

import type { Env } from "./env";
import { findService } from "./services";
import { RULES } from "./settings";
import { iso } from "./time";
import * as stripe from "./stripe";
import { sendEmail } from "./email";
import * as T from "./templates";
import { manageUrl, validManageToken } from "./manage";
import { BookingError, clean, loadBooking, serviceLabel, stripePaymentUrl, view } from "./bookings";

const MIN = 60000;
const REMINDER_GAP = 12 * 60 * MIN;

export type RequestRow = {
  id: string; booking_id: string; customer_id: string; amount_cents: number; note: string | null; status: "open" | "paid" | "cancelled";
  stripe_checkout_session_id: string | null; stripe_payment_intent_id: string | null; paid_cents: number | null; paid_at: string | null;
  last_reminder_at: string | null; reminders_sent: number; created_at: string;
};

const loadRequest = (env: Env, id: string) => env.DB.prepare("SELECT * FROM payment_requests WHERE id = ?1").bind(id).first<RequestRow>();
export const requestPayUrl = (manage: string, id: string) => `${manage}&payreq=${encodeURIComponent(id)}`;

async function requestEmail(env: Env, r: RequestRow, reminder: boolean) {
  const row = (await loadBooking(env, "id", r.booking_id))!;
  const manage = await manageUrl(env, row.id);
  return T.paymentRequest({ ...view(row), dueCents: 0 }, { amountCents: r.amount_cents, note: r.note, reminder }, requestPayUrl(manage, r.id));
}

/* ── Avery ── */

export async function adminCreateRequest(env: Env, body: unknown, now: number) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const row = await loadBooking(env, "id", String(b.bookingId ?? ""));
  if (!row || !["confirmed", "cancelled"].includes(row.status)) throw new BookingError(404, "Pick one of their sessions.");
  if (row.series_conflict) throw new BookingError(409, "This session is waiting for you to keep or move it first.");
  const amount = Math.round(Number(b.amountCents));
  if (!Number.isInteger(amount) || amount < 50 || amount > 500000) throw new BookingError(400, "The amount has to be between $0.50 and $5,000.");
  const open = await env.DB.prepare("SELECT 1 AS x FROM payment_requests WHERE booking_id = ?1 AND status = 'open'").bind(row.id).first();
  if (open) throw new BookingError(409, "There's already an open payment request for this session. Cancel it first to send a different one.");
  const r: RequestRow = {
    id: crypto.randomUUID(), booking_id: row.id, customer_id: row.customer_id, amount_cents: amount, note: clean(b.note, 1000, true) || null,
    status: "open", stripe_checkout_session_id: null, stripe_payment_intent_id: null, paid_cents: null, paid_at: null,
    last_reminder_at: iso(now), reminders_sent: 0, created_at: iso(now),
  };
  await env.DB.prepare(
    `INSERT INTO payment_requests (id, booking_id, customer_id, amount_cents, note, status, last_reminder_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?6, ?6)`,
  ).bind(r.id, r.booking_id, r.customer_id, r.amount_cents, r.note, iso(now)).run();
  const sent = await sendEmail(env, "payment_request", row.id, await requestEmail(env, r, false));
  return { ok: true, id: r.id, message: sent ? "Payment request sent." : "Saved, but the email couldn't be sent. Try Remind in a few minutes." };
}

export async function adminRemindRequest(env: Env, id: string, now: number) {
  const r = await loadRequest(env, id);
  if (!r || r.status !== "open") throw new BookingError(409, "This request isn't open anymore.");
  const last = r.last_reminder_at ? Date.parse(r.last_reminder_at) : 0;
  if (last > now - REMINDER_GAP) {
    const fmt = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: RULES.timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(ms);
    throw new BookingError(429, `The last email went out ${fmt(last)}. You can send another after ${fmt(last + REMINDER_GAP)}.`);
  }
  if (!(await sendEmail(env, "payment_request_reminder", r.booking_id, await requestEmail(env, r, true)))) {
    throw new BookingError(502, "The reminder couldn't be sent. Please try again.");
  }
  await env.DB.prepare("UPDATE payment_requests SET last_reminder_at = ?1, reminders_sent = reminders_sent + 1, updated_at = ?1 WHERE id = ?2").bind(iso(now), id).run();
  return { ok: true };
}

export async function adminCancelRequest(env: Env, id: string, now: number) {
  const r = await loadRequest(env, id);
  const res = await env.DB.prepare("UPDATE payment_requests SET status = 'cancelled', updated_at = ?1 WHERE id = ?2 AND status = 'open'").bind(iso(now), id).run();
  if (!r || !res.meta.changes) throw new BookingError(409, "This request isn't open anymore.");
  // Close any payment page still open. If it was paid at that very moment, it's refunded.
  if (r.stripe_checkout_session_id) {
    try {
      const s = await stripe.expireCheckoutSession(env, r.stripe_checkout_session_id);
      if (s.status === "complete" && stripe.isPaid(s) && s.metadata?.purpose === "request") await recordRequestPayment(env, s, now);
    } catch (err) { console.error("cancel request: couldn't close the payment page:", (err as Error).message); }
  }
  return { ok: true };
}

// Open requests, for Needs attention and the student profile.
export async function openRequests(env: Env, customerId?: string) {
  const rows = await env.DB.prepare(
    `SELECT r.*, b.start_utc, b.service_id, COALESCE(b.client_name, c.name) AS name, c.email, c.pronouns
     FROM payment_requests r JOIN bookings b ON b.id = r.booking_id JOIN customers c ON c.id = r.customer_id
     WHERE r.status = 'open' ${customerId ? "AND r.customer_id = ?1" : ""} ORDER BY r.created_at`,
  ).bind(...(customerId ? [customerId] : [])).all<RequestRow & { start_utc: string; service_id: string; name: string; email: string; pronouns: string | null }>();
  return rows.results.map((r) => ({
    id: r.id, bookingId: r.booking_id, customerId: r.customer_id, name: r.name, email: r.email, pronouns: r.pronouns,
    session: serviceLabel(findService(r.service_id)!), start: r.start_utc, amountCents: r.amount_cents, note: r.note,
    remindersSent: r.reminders_sent, lastReminderAt: r.last_reminder_at, createdAt: r.created_at,
  }));
}

/* ── The student ── */

// What their session page shows.
export async function requestsForBooking(env: Env, bookingId: string) {
  const rows = await env.DB.prepare(
    "SELECT id, amount_cents, note, status, paid_at FROM payment_requests WHERE booking_id = ?1 AND status IN ('open', 'paid') ORDER BY created_at",
  ).bind(bookingId).all<{ id: string; amount_cents: number; note: string | null; status: string; paid_at: string | null }>();
  return rows.results.map((r) => ({ id: r.id, amountCents: r.amount_cents, note: r.note, status: r.status, paidAt: r.paid_at }));
}

// From the Pay button: a Stripe checkout page for the request.
export async function startRequestPayment(env: Env, bookingId: unknown, token: unknown, requestId: unknown, now: number) {
  const notFound = new BookingError(404, "We couldn't find that payment request. Please use the link in your email.");
  if (!(await validManageToken(env, bookingId, token))) throw notFound;
  const r = await loadRequest(env, String(requestId ?? ""));
  if (!r || r.booking_id !== bookingId) throw notFound;
  if (r.status === "paid") throw new BookingError(409, "This is already paid. Thank you!");
  if (r.status !== "open") throw new BookingError(409, "This payment request has been withdrawn. There's nothing to pay.");

  // Reuse a checkout that's still open, so two clicks don't make two payments.
  if (r.stripe_checkout_session_id) {
    try {
      const s = await stripe.getCheckoutSession(env, r.stripe_checkout_session_id);
      if (s.status === "open" && s.url && (s.expires_at ?? 0) * 1000 > now + 10 * MIN) return { checkoutUrl: s.url };
      if (s.status === "complete" && stripe.isPaid(s)) {
        await recordRequestPayment(env, s, now);
        throw new BookingError(409, "This is already paid. Thank you!");
      }
    } catch (err) {
      if (err instanceof BookingError) throw err;
      console.warn("request payment: couldn't check the last checkout:", (err as Error).message);
    }
  }
  const row = (await loadBooking(env, "id", r.booking_id))!;
  const manage = await manageUrl(env, row.id);
  const when = new Intl.DateTimeFormat("en-US", { timeZone: row.client_time_zone || RULES.timeZone, weekday: "short", month: "short", day: "numeric" }).format(Date.parse(row.start_utc));
  let session: stripe.CheckoutSession;
  try {
    session = await stripe.createCheckoutSession(env, {
      bookingId: row.id, requestId: r.id, kind: "request", idempotencyKey: `payreq-${r.id}-${now}`,
      email: row.email, productName: `Private coaching, ${serviceLabel(findService(row.service_id)!).toLowerCase()}`,
      description: `Session on ${when}`, amountCents: r.amount_cents, expiresAt: now + 60 * MIN,
      successUrl: `${manage}&paid=1`, cancelUrl: manage,
    });
  } catch (err) {
    console.error("request payment: Stripe checkout failed:", (err as Error).message);
    throw new BookingError(502, "Payment couldn't be started. Please try again in a moment.");
  }
  await env.DB.prepare("UPDATE payment_requests SET stripe_checkout_session_id = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'open'")
    .bind(session.id, iso(now), r.id).run();
  return { checkoutUrl: session.url! };
}

// Stripe says a payment request was paid.
export async function recordRequestPayment(env: Env, s: stripe.CheckoutSession, now: number): Promise<void> {
  const r = await loadRequest(env, s.metadata?.request_id ?? "");
  if (!r) { console.error("recordRequestPayment: no request for checkout session"); return; }
  const pi = s.payment_intent;
  const paid = s.amount_total ?? 0;
  if (r.status === "paid" && r.stripe_payment_intent_id === pi) return; // the same notice twice
  const res = await env.DB.prepare(
    `UPDATE payment_requests SET status = 'paid', paid_at = ?1, paid_cents = ?2, stripe_payment_intent_id = ?3, updated_at = ?1
     WHERE id = ?4 AND status = 'open'`,
  ).bind(iso(now), paid, pi, r.id).run();
  const row = await loadBooking(env, "id", r.booking_id);
  if (!res.meta.changes) {
    // Paid twice, or after Avery withdrew it: give it back.
    if (!pi || paid <= 0) return;
    try { await stripe.refundPayment(env, pi, r.id); }
    catch (err) {
      await sendEmail(env, "attention_alert", r.booking_id, {
        ...T.attentionAlert([{ text: `${row?.name ?? "A student"} paid ${T.formatMoney(paid)} for a payment request that was already ${r.status}, and refunding it didn't work. Please refund it in Stripe.`,
          fix: ["Resolve in Stripe", stripePaymentUrl(env, pi) ?? T.FIX_ADMIN[1]] }]),
        to: env.ADMIN_EMAIL,
      });
      console.error("recordRequestPayment: refund failed:", (err as Error).message);
    }
    return;
  }
  if (!row) return;
  const v = { ...view(row), dueCents: 0 };
  await sendEmail(env, "payment_request_paid", row.id, T.requestPaid(v, paid, await manageUrl(env, row.id)));
  await sendEmail(env, "admin_payment_request_paid", row.id, { ...T.adminPaymentReceived({ ...v, amountCents: paid }), to: env.ADMIN_EMAIL });
}
