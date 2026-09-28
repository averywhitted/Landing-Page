// Refunds Avery gives by hand (any amount, any time, e.g. a goodwill refund
// on a session that already happened), and refund requests from students for
// things that can't be refunded online. Avery decides each request.
//
// Safety: each refund is for at most what's left unrefunded, and the record
// is only updated if nothing changed since it was read, so two clicks can't
// refund twice. A session refunded this way stays as it is (it isn't
// cancelled): Avery chose to refund it.

import type { Env } from "./env";
import { findService } from "./services";
import { RULES } from "./settings";
import { iso } from "./time";
import * as stripe from "./stripe";
import { sendEmail } from "./email";
import * as T from "./templates";
import { validManageToken, validPackageToken } from "./manage";
import { BookingError, CLIENT_COLUMNS, clean, loadBooking, serviceLabel, type BookingRow } from "./bookings";

const DAY = 24 * 60 * 60000;
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

type Target = {
  kind: "booking" | "package";
  id: string;
  customerId: string;
  name: string;
  pronouns: string | null;
  email: string;
  timeZone: string;
  paidCents: number;
  refundedCents: number;
  pi: string | null;
  what: string;          // "your 1 hour session on Tuesday, September 30"
};

function whenText(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(ms);
}

async function loadTarget(env: Env, kind: string, id: string): Promise<Target> {
  if (kind === "booking") {
    const row = await loadBooking(env, "id", id);
    if (!row) throw new BookingError(404, "Session not found.");
    const tz = row.client_time_zone || RULES.timeZone;
    return {
      kind, id, customerId: row.customer_id, name: row.name, pronouns: row.pronouns, email: row.email, timeZone: tz,
      paidCents: row.package_id ? 0 : row.amount_cents, refundedCents: row.refunded_cents ?? 0, pi: row.stripe_payment_intent_id,
      what: `your ${serviceLabel(findService(row.service_id)!).toLowerCase()} on ${whenText(Date.parse(row.start_utc), tz)}`,
    };
  }
  if (kind === "package") {
    const p = await env.DB.prepare(
      `SELECT p.*, ${CLIENT_COLUMNS("p")} FROM packages p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?1`,
    ).bind(id).first<Record<string, any>>();
    if (!p) throw new BookingError(404, "Bundle not found.");
    return {
      kind, id, customerId: p.customer_id, name: p.name, pronouns: p.pronouns, email: p.email, timeZone: p.client_time_zone || RULES.timeZone,
      paidCents: p.amount_cents, refundedCents: p.refunded_cents ?? 0, pi: p.stripe_payment_intent_id,
      what: `your ${findService(p.service_id)?.credits ?? p.credits_total} session bundle`,
    };
  }
  throw new BookingError(400, "Unknown refund type.");
}

/* ── Avery refunds any amount ── */

export async function adminRefundAmount(env: Env, kind: string, id: string, amountRaw: unknown,
  opts: { notifyClient: boolean; message?: string }, now: number) {
  const t = await loadTarget(env, kind, id);
  const left = t.paidCents - t.refundedCents;
  if (!t.pi || left <= 0) throw new BookingError(409, left <= 0 && t.paidCents > 0 ? "This has already been refunded in full." : "There's no card payment to refund.");
  const amount = amountRaw === undefined || amountRaw === null || amountRaw === "" ? left : Math.round(Number(amountRaw));
  if (!Number.isInteger(amount) || amount <= 0 || amount > left) {
    throw new BookingError(400, `The refund has to be between $0.01 and ${money(left)} (what's left of the payment).`);
  }
  // Keyed by what was refunded before, so a double click is the same refund, not two.
  try {
    await stripe.refundPayment(env, t.pi, t.id, amount === t.paidCents ? undefined : amount, `refund-${t.pi}-${t.refundedCents}-${amount}`);
  } catch (err) {
    throw new BookingError(502, `Stripe didn't accept the refund: ${(err as Error).message.replace(/^Stripe [^:]+: /, "")}`);
  }
  const table = t.kind === "booking" ? "bookings" : "packages";
  const fullTarget = t.kind === "booking" ? "amount_cents" : "CASE WHEN status = 'cancelled' THEN COALESCE(refund_due_cents, amount_cents) ELSE amount_cents END";
  await env.DB.prepare(
    `UPDATE ${table} SET refunded_cents = refunded_cents + ?1,
       refunded_at = CASE WHEN refunded_cents + ?1 >= ${fullTarget} THEN COALESCE(refunded_at, ?2) ELSE refunded_at END
     WHERE id = ?3 AND refunded_cents = ?4`,
  ).bind(amount, iso(now), t.id, t.refundedCents).run();
  await env.DB.prepare("UPDATE refund_requests SET status = 'granted', resolved_at = ?1 WHERE kind = ?2 AND target_id = ?3 AND status = 'open'")
    .bind(iso(now), t.kind, t.id).run();
  if (opts.notifyClient) {
    await sendEmail(env, "refund_issued", t.kind === "booking" ? t.id : null,
      T.refundIssued({ name: t.name, email: t.email, what: t.what, amountCents: amount, message: clean(opts.message, 1000, true) }));
  }
  return { ok: true, refundedCents: amount, message: `Refunded ${money(amount)}.` };
}

/* ── Students asking for a refund ── */

export async function studentRefundRequest(env: Env, body: unknown, now: number) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const kind = b.kind === "package" ? "package" : "booking";
  const id = String((kind === "package" ? b.p : b.b) ?? "");
  const valid = kind === "package" ? await validPackageToken(env, id, b.t) : await validManageToken(env, id, b.t);
  if (!valid) throw new BookingError(404, "We couldn't find that. Please use the link in your email.");
  const t = await loadTarget(env, kind, id);
  if (!t.pi || t.paidCents - t.refundedCents <= 0) throw new BookingError(409, "There's nothing left to refund here.");

  // Where there's a way to cancel and be refunded online, point to it instead.
  if (kind === "booking") {
    const row = (await loadBooking(env, "id", id)) as BookingRow;
    if (row.status === "confirmed" && Date.parse(row.start_utc) - now >= DAY) {
      throw new BookingError(409, "You can still cancel this session yourself for a full refund, using the Cancel button on this page.");
    }
    if (row.status === "cancelled" && row.refund_requested_at) throw new BookingError(409, "Your refund for this session is already on its way.");
  } else {
    const p = await env.DB.prepare("SELECT status, expires_at, credits_total, credits_used FROM packages WHERE id = ?1").bind(id)
      .first<{ status: string; expires_at: string | null; credits_total: number; credits_used: number }>();
    const active = p!.status === "active" && (!p!.expires_at || Date.parse(p!.expires_at) > now);
    if (active && p!.credits_used < p!.credits_total) {
      throw new BookingError(409, "You can cancel your bundle from this page, and any refund is worked out automatically.");
    }
  }
  const message = clean(b.message, 1000, true);
  try {
    await env.DB.prepare(
      "INSERT INTO refund_requests (id, kind, target_id, customer_id, message, status) VALUES (?1, ?2, ?3, ?4, ?5, 'open')",
    ).bind(crypto.randomUUID(), kind, id, t.customerId, message || null).run();
  } catch (err) {
    if (/UNIQUE/i.test((err as Error).message)) throw new BookingError(409, "You've already sent a request. Avery will get back to you soon.");
    throw err;
  }
  await sendEmail(env, "admin_refund_request", kind === "booking" ? id : null, {
    ...T.adminRefundRequest({ name: t.name, email: t.email, what: t.what.replace(/^your /, ""), paidCents: t.paidCents, leftCents: t.paidCents - t.refundedCents, message }),
    to: env.ADMIN_EMAIL,
  });
  return { ok: true };
}

// The latest request for something, for the student's page.
export async function refundRequestStatus(env: Env, kind: "booking" | "package", id: string) {
  const r = await env.DB.prepare("SELECT status FROM refund_requests WHERE kind = ?1 AND target_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(kind, id).first<{ status: string }>();
  return r?.status ?? null;
}

/* ── Avery: open requests, and declining one ── */

export async function openRefundRequests(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.kind, r.target_id, r.message, r.created_at, c.id AS customer_id FROM refund_requests r
     JOIN customers c ON c.id = r.customer_id WHERE r.status = 'open' ORDER BY r.created_at`,
  ).all<{ id: string; kind: string; target_id: string; message: string | null; created_at: string; customer_id: string }>();
  const out = [];
  for (const r of rows.results) {
    const t = await loadTarget(env, r.kind, r.target_id).catch(() => null);
    if (!t) continue;
    out.push({
      id: r.id, kind: r.kind, targetId: r.target_id, customerId: r.customer_id, name: t.name, pronouns: t.pronouns, email: t.email,
      what: t.what.replace(/^your /, ""), paidCents: t.paidCents, leftCents: t.paidCents - t.refundedCents,
      message: r.message, at: r.created_at,
    });
  }
  return out;
}

export async function adminDeclineRefundRequest(env: Env, requestId: string, message: string, now: number) {
  const r = await env.DB.prepare("SELECT kind, target_id FROM refund_requests WHERE id = ?1 AND status = 'open'").bind(requestId)
    .first<{ kind: string; target_id: string }>();
  if (!r) throw new BookingError(409, "This request has already been answered.");
  const t = await loadTarget(env, r.kind, r.target_id);
  await env.DB.prepare("UPDATE refund_requests SET status = 'declined', resolved_at = ?1 WHERE id = ?2 AND status = 'open'").bind(iso(now), requestId).run();
  await sendEmail(env, "refund_declined", r.kind === "booking" ? r.target_id : null,
    T.refundDeclined({ name: t.name, email: t.email, what: t.what, message: clean(message, 1000, true) }));
  return { ok: true };
}
