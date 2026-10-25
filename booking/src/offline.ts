// Payments outside Stripe: Avery records money a student paid them directly
// (cash, Venmo, Zelle, a check) for a session Avery booked, or lets some of what
// they owe go. Either way it comes off what's due; part of it leaves the rest
// to pay by the usual link, and all of it marks the session paid, exactly as a
// card payment would (Zoom link, calendar, repeats).
//
// Safety: these are records only. Nothing recorded here is ever refunded
// through Stripe; the refund code only looks at card payments
// (stripe_payment_intent_id). The database refuses totals above the price.

import type { Env } from "./env";
import { RULES } from "./settings";
import { iso, zonedDate } from "./time";
import * as stripe from "./stripe";
import { sendEmail } from "./email";
import * as T from "./templates";
import { manageUrl } from "./manage";
import { BookingError, clean, clientIcs, dueCents, loadBooking, payUrl, refreshCalendarEvent, serviceLabel, view, type BookingRow } from "./bookings";
import { findService } from "./services";

export const METHODS = ["cash", "venmo", "zelle", "check", "other", "waived"] as const;
type Method = (typeof METHODS)[number];

type PaymentRow = {
  id: string; booking_id: string; customer_id: string; method: Method; amount_cents: number; received_on: string;
  note: string | null; settled: number; status: "active" | "removed"; created_at: string;
};

const money = T.formatMoney;
const today = (now: number) => zonedDate(now, RULES.timeZone).map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-");

// The calendar event (and a group's) shows what's paid and what's left.
async function refreshCalendars(env: Env, row: BookingRow) {
  if (row.group_id) await (await import("./sessions")).setUpGroup(env, row.group_id);
  else await refreshCalendarEvent(env, row.id);
}

/* ── Avery records a payment ── */

export async function adminRecordPayment(env: Env, bookingId: string, body: unknown, ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const now = ctx.now;
  const row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "confirmed") throw new BookingError(409, "Payments can only be recorded for booked sessions.");
  if (row.series_conflict) throw new BookingError(409, "This session is waiting for you to keep or move it first.");
  const due = dueCents(row);
  if (!due) throw new BookingError(409, "Nothing is owed on this session.");
  const method = String(b.method ?? "") as Method;
  if (!METHODS.includes(method)) throw new BookingError(400, "Pick how they paid.");
  const amount = Math.round(Number(b.amountCents));
  if (!Number.isInteger(amount) || amount <= 0) throw new BookingError(400, "Enter the amount.");
  if (amount > due) throw new BookingError(400, `That's more than the ${money(due)} still owed for this session.`);
  const receivedOn = b.receivedOn ? String(b.receivedOn) : today(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || receivedOn > today(now)) throw new BookingError(400, "Pick the day you got it (today or earlier).");
  const note = clean(b.note, 300, true) || null;

  // Close a payment page that's still open, so they can't also pay the old amount by card.
  if (row.stripe_checkout_session_id) {
    let s: stripe.CheckoutSession;
    try { s = await stripe.expireCheckoutSession(env, row.stripe_checkout_session_id); }
    catch { throw new BookingError(502, "Their open payment page in Stripe couldn't be closed. Please try again in a minute."); }
    if (s.status === "complete" && stripe.isPaid(s)) {
      await (await import("./sessions")).recordPayment(env, s, now);
      throw new BookingError(409, "They've just paid for this session by card, so there's nothing left to record.");
    }
  }

  const settles = amount === due;
  const waived = method === "waived";
  const id = crypto.randomUUID();
  // The booking is updated only if nothing changed since it was read; the
  // record is written only if that update happened (a double click adds nothing).
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET offline_cents = offline_cents + ?1, waived_cents = waived_cents + ?2, pay_by = NULL,
         paid_at = CASE WHEN ?3 THEN ?4 ELSE paid_at END, ics_sequence = ics_sequence + ?3, updated_at = ?4
       WHERE id = ?5 AND status = 'confirmed' AND paid_at IS NULL AND offline_cents = ?6 AND waived_cents = ?7`,
    ).bind(waived ? 0 : amount, waived ? amount : 0, settles ? 1 : 0, iso(now), row.id, row.offline_cents, row.waived_cents),
    env.DB.prepare(
      `INSERT INTO offline_payments (id, booking_id, customer_id, method, amount_cents, received_on, note, settled, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE changes() = 1`,
    ).bind(id, row.id, row.customer_id, method, amount, receivedOn, note, settles ? 1 : 0, iso(now)),
  ]);
  if (!res[1].meta.changes) throw new BookingError(409, "This session changed in the meantime. Refresh and try again.");

  const fresh = (await loadBooking(env, "id", row.id))!;
  const notify = b.notifyClient !== false;
  ctx.waitUntil((async () => {
    if (settles && fresh.series_id) await (await import("./series")).seriesPaid(env, fresh.series_id);
    await refreshCalendars(env, fresh);
    if (notify) {
      const v = view(fresh);
      const manage = await manageUrl(env, fresh.id);
      await sendEmail(env, "offline_payment", fresh.id, T.offlinePaymentReceived(v, { amountCents: amount, method, upcoming: Date.parse(fresh.end_utc) > Date.now() },
        manage, v.dueCents ? payUrl(manage) : null, clientIcs(env, fresh, v, "REQUEST")));
    }
  })());
  const left = dueCents(fresh);
  return {
    ok: true, id, dueCents: left, settled: settles,
    message: `${waived ? `${money(amount)} waived` : `${money(amount)} recorded`}. ${left ? `${money(left)} left to pay` : "Paid in full"}${notify ? ", and they've been emailed" : ""}.`,
  };
}

/* ── Avery takes one back (a typo, or the wrong session) ── */

export async function adminRemovePayment(env: Env, paymentId: string, ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const p = await env.DB.prepare("SELECT * FROM offline_payments WHERE id = ?1").bind(paymentId).first<PaymentRow>();
  if (!p || p.status !== "active") throw new BookingError(409, "That payment has already been removed.");
  const row = (await loadBooking(env, "id", p.booking_id))!;
  if (row.status !== "confirmed") throw new BookingError(409, "This session has been cancelled, so its payments can't be changed.");
  // Paid off since by a later payment (card or another one recorded here): taking this one out would leave it marked paid but short.
  if (row.paid_at && !p.settled) throw new BookingError(409, "The rest has been paid since, so this one can't be removed on its own.");
  const waived = p.method === "waived";
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE offline_payments SET status = 'removed', removed_at = ?1 WHERE id = ?2 AND status = 'active'").bind(iso(ctx.now), p.id),
    env.DB.prepare(
      `UPDATE bookings SET offline_cents = offline_cents - ?1, waived_cents = waived_cents - ?2,
         paid_at = CASE WHEN ?3 THEN NULL ELSE paid_at END, updated_at = ?4
       WHERE id = ?5 AND status = 'confirmed' AND changes() = 1`,
    ).bind(waived ? 0 : p.amount_cents, waived ? p.amount_cents : 0, p.settled ? 1 : 0, iso(ctx.now), row.id),
  ]);
  if (!res[0].meta.changes) throw new BookingError(409, "That payment has already been removed.");
  const fresh = (await loadBooking(env, "id", row.id))!;
  ctx.waitUntil(refreshCalendars(env, fresh));
  return { ok: true, dueCents: dueCents(fresh) };
}

/* ── For the student's profile ── */

export async function offlinePaymentsFor(env: Env, customerId: string) {
  const rows = await env.DB.prepare(
    `SELECT o.*, b.service_id, b.start_utc, b.status AS booking_status, b.paid_at AS booking_paid_at FROM offline_payments o
     JOIN bookings b ON b.id = o.booking_id WHERE o.customer_id = ?1 AND o.status = 'active' ORDER BY o.received_on DESC, o.created_at DESC`,
  ).bind(customerId).all<PaymentRow & { service_id: string; start_utc: string; booking_status: string; booking_paid_at: string | null }>();
  return rows.results.map((r) => ({
    id: r.id, bookingId: r.booking_id, method: r.method, amountCents: r.amount_cents, receivedOn: r.received_on, note: r.note,
    session: serviceLabel(findService(r.service_id)!), start: r.start_utc,
    canRemove: r.booking_status === "confirmed" && (!r.booking_paid_at || !!r.settled),
  }));
}
