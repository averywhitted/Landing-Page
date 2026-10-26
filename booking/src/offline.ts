// Payments outside Stripe: Avery records money a student paid them directly
// (cash, Venmo, Zelle, a check), or lets some of what they owe go, for:
//   a session Avery booked   part of it leaves the rest to pay by the usual
//                            link; all of it marks the session paid, exactly as
//                            a card payment would (Zoom link, calendar, repeats)
//   a payment request        the same, for the request's amount
//   a bundle                 sold directly: an active bundle, paid in full
//
// Safety: these are records only. Nothing recorded here is ever refunded
// through Stripe; the refund code only looks at card payments
// (stripe_payment_intent_id). The database refuses totals above the price.
// A bundle paid this way can't be cancelled online; Avery cancels it.

import type { Env } from "./env";
import { RULES } from "./settings";
import { iso, zonedDate } from "./time";
import * as stripe from "./stripe";
import { sendEmail } from "./email";
import * as T from "./templates";
import { manageUrl } from "./manage";
import { scheduling } from "./config";
import { BookingError, clean, clientIcs, dueCents, loadBooking, payUrl, refreshCalendarEvent, serviceLabel, view, type BookingRow } from "./bookings";
import { findService } from "./services";
import { loadRequest, requestDue, requestPayUrl } from "./requests";

export const METHODS = ["cash", "venmo", "zelle", "check", "other", "waived"] as const;
type Method = (typeof METHODS)[number];

type PaymentRow = {
  id: string; booking_id: string | null; request_id: string | null; package_id: string | null; customer_id: string; method: Method;
  amount_cents: number; received_on: string; note: string | null; settled: number; status: "active" | "removed"; created_at: string;
};

const money = T.formatMoney;
const DAY = 24 * 60 * 60000;
const today = (now: number) => zonedDate(now, RULES.timeZone).map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-");
type Ctx = { now: number; waitUntil: (p: Promise<unknown>) => void };

// The calendar event (and a group's) shows what's paid and what's left.
async function refreshCalendars(env: Env, row: BookingRow) {
  if (row.group_id) await (await import("./sessions")).setUpGroup(env, row.group_id);
  else await refreshCalendarEvent(env, row.id);
}

// Amount, method, date and note, checked the same way for everything.
function readPayment(b: Record<string, unknown>, now: number, opts: { maxCents: number; allowWaive: boolean }) {
  const method = String(b.method ?? "") as Method;
  if (!METHODS.includes(method) || (method === "waived" && !opts.allowWaive)) throw new BookingError(400, "Pick how they paid.");
  const amount = Math.round(Number(b.amountCents));
  if (!Number.isInteger(amount) || amount <= 0) throw new BookingError(400, "Enter the amount.");
  if (amount > opts.maxCents) throw new BookingError(400, `That's more than the ${money(opts.maxCents)} still owed.`);
  const receivedOn = b.receivedOn ? String(b.receivedOn) : today(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || receivedOn > today(now)) throw new BookingError(400, "Pick the day you got it (today or earlier).");
  return { method, amount, receivedOn, note: clean(b.note, 300, true) || null, notify: b.notifyClient !== false };
}

// Closes a payment page that's still open, so they can't also pay the old
// amount by card. If it was paid at that very moment, that's recorded instead.
async function closeCheckout(env: Env, sessionId: string | null, now: number, record: (s: stripe.CheckoutSession) => Promise<void>) {
  if (!sessionId) return;
  let s: stripe.CheckoutSession;
  try { s = await stripe.expireCheckoutSession(env, sessionId); }
  catch { throw new BookingError(502, "Their open payment page in Stripe couldn't be closed. Please try again in a minute."); }
  if (s.status === "complete" && stripe.isPaid(s)) {
    await record(s);
    throw new BookingError(409, "They've just paid this by card, so there's nothing left to record.");
  }
}

const recorded = (amount: number, method: Method, left: number, notify: boolean) =>
  `${money(amount)} ${method === "waived" ? "waived" : "recorded"}. ${left ? `${money(left)} left to pay` : "Paid in full"}${notify ? ", and they've been emailed" : ""}.`;

/* ── A session Avery booked ── */

export async function adminRecordPayment(env: Env, bookingId: string, body: unknown, ctx: Ctx) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const now = ctx.now;
  const row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "confirmed") throw new BookingError(409, "Payments can only be recorded for booked sessions.");
  if (row.series_conflict) throw new BookingError(409, "This session is waiting for you to keep or move it first.");
  const due = dueCents(row);
  if (!due) throw new BookingError(409, "Nothing is owed on this session.");
  const { method, amount, receivedOn, note, notify } = readPayment(b, now, { maxCents: due, allowWaive: true });
  await closeCheckout(env, row.stripe_checkout_session_id, now, async (s) => (await import("./sessions")).recordPayment(env, s, now));

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
  return { ok: true, id, dueCents: left, settled: settles, message: recorded(amount, method, left, notify) };
}

/* ── A payment request ── */

export async function adminRecordRequestPayment(env: Env, requestId: string, body: unknown, ctx: Ctx) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const now = ctx.now;
  const r = await loadRequest(env, requestId);
  if (!r || r.status !== "open") throw new BookingError(409, "This request isn't open anymore.");
  const due = requestDue(r);
  if (!due) throw new BookingError(409, "Nothing is owed on this request.");
  const { method, amount, receivedOn, note, notify } = readPayment(b, now, { maxCents: due, allowWaive: true });
  await closeCheckout(env, r.stripe_checkout_session_id, now, async (s) => (await import("./requests")).recordRequestPayment(env, s, now));

  const settles = amount === due;
  const waived = method === "waived";
  const id = crypto.randomUUID();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_requests SET offline_cents = offline_cents + ?1, waived_cents = waived_cents + ?2,
         status = CASE WHEN ?3 THEN 'paid' ELSE status END, paid_at = CASE WHEN ?3 THEN ?4 ELSE paid_at END, updated_at = ?4
       WHERE id = ?5 AND status = 'open' AND offline_cents = ?6 AND waived_cents = ?7`,
    ).bind(waived ? 0 : amount, waived ? amount : 0, settles ? 1 : 0, iso(now), r.id, r.offline_cents, r.waived_cents),
    env.DB.prepare(
      `INSERT INTO offline_payments (id, booking_id, request_id, customer_id, method, amount_cents, received_on, note, settled, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE changes() = 1`,
    ).bind(id, r.booking_id, r.id, r.customer_id, method, amount, receivedOn, note, settles ? 1 : 0, iso(now)),
  ]);
  if (!res[1].meta.changes) throw new BookingError(409, "This request changed in the meantime. Refresh and try again.");

  const left = due - amount;
  if (notify) {
    ctx.waitUntil((async () => {
      const row = (await loadBooking(env, "id", r.booking_id))!;
      const manage = await manageUrl(env, row.id);
      await sendEmail(env, "offline_payment", row.id, T.offlinePaymentReceived({ ...view(row), dueCents: 0 },
        { amountCents: amount, method, upcoming: false, forRequest: true, leftCents: left }, manage, left ? requestPayUrl(manage, r.id) : null));
    })());
  }
  return { ok: true, id, dueCents: left, settled: settles, message: recorded(amount, method, left, notify) };
}

/* ── A bundle sold directly ── */

export async function adminSellBundle(env: Env, body: unknown, ctx: Ctx) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const now = ctx.now;
  const service = findService(String(b.serviceId ?? ""));
  if (!service || service.kind !== "bundle" || !service.credits) throw new BookingError(400, "Pick a bundle.");

  // An existing student, or a new one by name and email.
  let customerId: string;
  if (typeof b.customerId === "string" && b.customerId) {
    const c = await env.DB.prepare("SELECT id FROM customers WHERE id = ?1").bind(b.customerId).first<{ id: string }>();
    if (!c) throw new BookingError(404, "Student not found.");
    customerId = c.id;
  } else {
    const name = clean(b.name, 120);
    const email = clean(b.email, 200).toLowerCase();
    if (!name) throw new BookingError(400, "Add the student's name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BookingError(400, "Please check the email address.");
    customerId = await (await import("./sessions")).upsertCustomer(env, { name, email, pronouns: clean(b.pronouns, 40) });
  }

  // $0 is a free bundle (no payment record); otherwise they paid it all.
  const free = Number(b.amountCents) === 0;
  const pay = free ? null : readPayment(b, now, { maxCents: 500000, allowWaive: false });
  const amount = pay?.amount ?? 0;
  const notify = b.notifyClient !== false;
  const id = crypto.randomUUID();
  const expires = now + (await scheduling(env)).packageValidDays * DAY;
  await env.DB.batch([
    // Avery isn't emailed about their own sale; the student's confirmation goes out below (or is marked done if not wanted).
    env.DB.prepare(
      `INSERT INTO packages (id, customer_id, service_id, status, credits_total, expires_at, amount_cents, offline_cents, client_time_zone,
         admin_email_sent_at, confirmation_sent_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?5, 0, ?6, ?7, ?8, ?9, ?8, ?8)`,
    ).bind(id, customerId, service.id, service.credits, iso(expires), amount, RULES.timeZone, iso(now), notify ? null : iso(now)),
    env.DB.prepare("INSERT INTO credit_ledger (package_id, delta, reason, note) VALUES (?1, ?2, 'purchased', ?3)")
      .bind(id, service.credits, free ? "given by Avery" : `paid outside Stripe (${pay!.method})`),
    ...(pay ? [env.DB.prepare(
      `INSERT INTO offline_payments (id, package_id, customer_id, method, amount_cents, received_on, note, settled, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)`,
    ).bind(crypto.randomUUID(), id, customerId, pay.method, amount, pay.receivedOn, pay.note, iso(now))] : []),
  ]);
  if (notify) ctx.waitUntil((await import("./packages")).afterPackage(env, id));
  return {
    ok: true, packageId: id,
    message: `${service.credits} session bundle added${amount ? `, ${money(amount)} recorded` : " for free"}${notify ? ". They've been emailed their bundle link" : ""}.`,
  };
}

/* ── Avery takes one back (a typo, or the wrong session) ── */

export async function adminRemovePayment(env: Env, paymentId: string, ctx: Ctx) {
  const p = await env.DB.prepare("SELECT * FROM offline_payments WHERE id = ?1").bind(paymentId).first<PaymentRow>();
  if (!p || p.status !== "active") throw new BookingError(409, "That payment has already been removed.");
  const now = iso(ctx.now);
  const waived = p.method === "waived";
  const markRemoved = env.DB.prepare("UPDATE offline_payments SET status = 'removed', removed_at = ?1 WHERE id = ?2 AND status = 'active'").bind(now, p.id);

  if (p.package_id) {
    // A bundle sold by mistake goes away, as long as nothing has been booked with it.
    const pkg = await env.DB.prepare("SELECT status, credits_used FROM packages WHERE id = ?1").bind(p.package_id).first<{ status: string; credits_used: number }>();
    if (pkg?.status !== "active" || pkg.credits_used > 0) {
      throw new BookingError(409, "Sessions have been booked with this bundle (or it's been cancelled), so the sale can't be taken back. Cancel the bundle instead.");
    }
    const res = await env.DB.batch([
      markRemoved,
      env.DB.prepare(
        `UPDATE packages SET status = 'cancelled', cancel_reason = 'avery_cancelled', cancelled_at = ?1, refund_due_cents = 0, offline_cents = 0, updated_at = ?1
         WHERE id = ?2 AND status = 'active' AND credits_used = 0 AND changes() = 1`,
      ).bind(now, p.package_id),
      env.DB.prepare(
        `INSERT INTO credit_ledger (package_id, delta, reason, note) SELECT ?1, 0, 'avery_cancelled', 'sale removed' WHERE changes() = 1`,
      ).bind(p.package_id),
    ]);
    if (!res[0].meta.changes) throw new BookingError(409, "That payment has already been removed.");
    return { ok: true, dueCents: 0 };
  }

  if (p.request_id) {
    const r = (await loadRequest(env, p.request_id))!;
    if (r.status === "cancelled") throw new BookingError(409, "This request was withdrawn, so its payments can't be changed.");
    if (r.status === "paid" && !p.settled) throw new BookingError(409, "The rest has been paid since, so this one can't be removed on its own.");
    const res = await env.DB.batch([
      markRemoved,
      env.DB.prepare(
        `UPDATE payment_requests SET offline_cents = offline_cents - ?1, waived_cents = waived_cents - ?2,
           status = CASE WHEN ?3 THEN 'open' ELSE status END, paid_at = CASE WHEN ?3 THEN NULL ELSE paid_at END, updated_at = ?4
         WHERE id = ?5 AND status IN ('open', 'paid') AND changes() = 1`,
      ).bind(waived ? 0 : p.amount_cents, waived ? p.amount_cents : 0, p.settled ? 1 : 0, now, r.id),
    ]);
    if (!res[0].meta.changes) throw new BookingError(409, "That payment has already been removed.");
    return { ok: true, dueCents: requestDue((await loadRequest(env, r.id))!) };
  }

  const row = (await loadBooking(env, "id", p.booking_id!))!;
  if (row.status !== "confirmed") throw new BookingError(409, "This session has been cancelled, so its payments can't be changed.");
  // Paid off since by a later payment (card or another one recorded here): taking this one out would leave it marked paid but short.
  if (row.paid_at && !p.settled) throw new BookingError(409, "The rest has been paid since, so this one can't be removed on its own.");
  const res = await env.DB.batch([
    markRemoved,
    env.DB.prepare(
      `UPDATE bookings SET offline_cents = offline_cents - ?1, waived_cents = waived_cents - ?2,
         paid_at = CASE WHEN ?3 THEN NULL ELSE paid_at END, updated_at = ?4
       WHERE id = ?5 AND status = 'confirmed' AND changes() = 1`,
    ).bind(waived ? 0 : p.amount_cents, waived ? p.amount_cents : 0, p.settled ? 1 : 0, now, row.id),
  ]);
  if (!res[0].meta.changes) throw new BookingError(409, "That payment has already been removed.");
  const fresh = (await loadBooking(env, "id", row.id))!;
  ctx.waitUntil(refreshCalendars(env, fresh));
  return { ok: true, dueCents: dueCents(fresh) };
}

/* ── For the student's profile ── */

export async function offlinePaymentsFor(env: Env, customerId: string) {
  const rows = await env.DB.prepare(
    `SELECT o.*, b.service_id, b.start_utc, b.status AS booking_status, b.paid_at AS booking_paid_at,
       r.status AS request_status, p.service_id AS bundle_service, p.status AS bundle_status, p.credits_used
     FROM offline_payments o LEFT JOIN bookings b ON b.id = o.booking_id LEFT JOIN payment_requests r ON r.id = o.request_id
       LEFT JOIN packages p ON p.id = o.package_id
     WHERE o.customer_id = ?1 AND o.status = 'active' ORDER BY o.received_on DESC, o.created_at DESC, o.rowid DESC`,
  ).bind(customerId).all<PaymentRow & Record<string, any>>();
  return rows.results.map((r) => {
    const kind = r.package_id ? "bundle" : r.request_id ? "request" : "session";
    return {
      id: r.id, kind, method: r.method, amountCents: r.amount_cents, receivedOn: r.received_on, note: r.note,
      what: kind === "bundle" ? `${findService(r.bundle_service)?.credits ?? ""} session bundle`
        : `${kind === "request" ? "payment request for " : ""}${serviceLabel(findService(r.service_id)!).toLowerCase()}`,
      start: kind === "bundle" ? null : r.start_utc,
      canRemove: kind === "bundle" ? r.bundle_status === "active" && r.credits_used === 0
        : kind === "request" ? r.request_status === "open" || (r.request_status === "paid" && !!r.settled)
        : r.booking_status === "confirmed" && (!r.booking_paid_at || !!r.settled),
    };
  });
}
