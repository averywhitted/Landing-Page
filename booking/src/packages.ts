// Session bundles: buying one, confirming it after payment, the client's
// bundle page, and booking sessions with its credits.
//
// Credits: packages.credits_used counts sessions booked; the database refuses
// to let it go past credits_total. Every change is also written to
// credit_ledger so there's a full history.

import type { Env } from "./env";
import { findService, type Service } from "./services";
import { RULES } from "./settings";
import { blocksFor } from "./availability";
import { iso, isValidTimeZone } from "./time";
import * as stripe from "./stripe";
import { sendEmail } from "./email";
import { verifyHuman } from "./turnstile";
import { manageUrl, packageUrl, validPackageToken } from "./manage";
import * as T from "./templates";
import {
  BookingError, CLIENT_COLUMNS, INACTIVE_CLAIM, ONCE_ONLY, UNIQUE_CLAIM, afterCancelShared, afterConfirm, isStillOpen, sha256,
  stripePaymentUrl, validateIntake,
} from "./bookings";
import { scheduling } from "./config";

const MIN = 60000;
const DAY = 24 * 60 * MIN;

export type PackageRow = {
  id: string; customer_id: string; service_id: string; status: "pending" | "active" | "cancelled";
  credits_total: number; credits_used: number; expires_at: string | null; amount_cents: number;
  promo_code: string | null; stripe_checkout_session_id: string | null; stripe_payment_intent_id: string | null;
  intake_json: string | null; client_time_zone: string | null; confirmation_sent_at: string | null;
  admin_email_sent_at: string | null; expiry_notice_sent_at: string | null; created_at: string;
  cancel_reason: string | null; cancelled_at: string | null; refund_due_cents: number | null; refunded_at: string | null; refunded_cents: number;
  reminder_sent_at: string | null;
  name: string; email: string; pronouns: string | null;
};

export async function loadPackage(env: Env, where: "id" | "stripe_checkout_session_id", value: string): Promise<PackageRow | null> {
  return env.DB.prepare(
    `SELECT p.*, ${CLIENT_COLUMNS("p")} FROM packages p JOIN customers c ON c.id = p.customer_id WHERE p.${where} = ?1`,
  ).bind(value).first<PackageRow>();
}

const sessionService = () => findService(RULES.packageSessionService)!;
const lengthLabel = (min: number) => (min === 60 ? "1 hour" : `${min} minute`);
export const bundleName = (s: Service) => `${s.credits} session bundle`;

export function bundleView(p: PackageRow): T.BundleView {
  const intake = p.intake_json ? JSON.parse(p.intake_json) : {};
  return {
    name: p.name, email: p.email, pronouns: p.pronouns ?? undefined,
    credits: p.credits_total, remaining: p.credits_total - p.credits_used,
    sessionLength: lengthLabel(sessionService().durationMinutes),
    expiresAt: p.expires_at ? Date.parse(p.expires_at) : Date.now() + RULES.packageValidDays * DAY,
    clientTimeZone: p.client_time_zone || RULES.timeZone,
    amountCents: p.amount_cents,
    bundleName: bundleName(findService(p.service_id)!),
    goal: intake.goal,
  };
}

/* ── Buying a bundle ── */

export async function createPackagePurchase(env: Env, body: unknown, ctx: { ip: string; now: number }) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const service = findService(String(b.serviceId ?? ""));
  if (!service || service.kind !== "bundle" || !service.credits) throw new BookingError(400, "Unknown bundle.");
  const clientTz = typeof b.timeZone === "string" && isValidTimeZone(b.timeZone) ? b.timeZone : RULES.timeZone;
  const intake = validateIntake(b.intake, service);
  if (!(await verifyHuman(env, b.turnstileToken, ctx.ip))) {
    throw new BookingError(403, "We couldn't confirm you're a real person. Please refresh the page and try again.");
  }
  const ipHash = await sha256(`${env.HASH_SALT ?? "averywhitted-booking"}|${ctx.ip}`);
  const pendingCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM packages p JOIN customers c ON c.id = p.customer_id
     WHERE p.status = 'pending' AND p.created_at > ?1 AND (c.email = ?2 OR p.ip_hash = ?3)`,
  ).bind(iso(ctx.now - RULES.holdMinutes * MIN), intake.email, ipHash).first<{ n: number }>();
  if ((pendingCount?.n ?? 0) >= RULES.maxActiveHoldsPerPerson) {
    throw new BookingError(429, "You have a checkout in progress. Please finish it, or try again in 30 minutes.");
  }

  const customer = await env.DB.prepare(
    `INSERT INTO customers (id, name, email, pronouns) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, pronouns = excluded.pronouns
     RETURNING id`,
  ).bind(crypto.randomUUID(), intake.name, intake.email, intake.pronouns || null).first<{ id: string }>();

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO packages (id, customer_id, service_id, status, credits_total, amount_cents, intake_json, client_time_zone, ip_hash,
       client_name, client_pronouns)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(id, customer!.id, service.id, service.credits, service.priceCents,
    JSON.stringify({ goal: intake.goal, material: intake.material, link: intake.link, notes: intake.notes }), clientTz, ipHash,
    intake.name, intake.pronouns || null).run();

  let session: stripe.CheckoutSession;
  try {
    session = await stripe.createCheckoutSession(env, {
      bookingId: id,
      kind: "package",
      email: intake.email,
      productName: `${bundleName(service)} (private coaching)`,
      description: `${service.credits} one-hour sessions on Zoom, to use within ${(await scheduling(env)).packageValidDays} days`,
      amountCents: service.priceCents,
      expiresAt: ctx.now + RULES.holdMinutes * MIN,
      successUrl: `${env.SITE_URL}/book/confirmed/?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${env.SITE_URL}/book/?service=${service.id}&checkout=cancelled`,
      promotionCodeId: (await stripe.lookupPromotionCode(env, b.promo)) ?? undefined,
    });
  } catch (err) {
    console.error("createPackagePurchase: Stripe checkout failed:", (err as Error).message);
    await env.DB.prepare("DELETE FROM packages WHERE id = ?1").bind(id).run();
    throw new BookingError(502, "Payment couldn't be started. Please try again in a moment.");
  }
  await env.DB.prepare("UPDATE packages SET stripe_checkout_session_id = ?1 WHERE id = ?2").bind(session.id, id).run();
  return { packageId: id, checkoutUrl: session.url! };
}

/* ── After payment ── */

export async function confirmPackage(env: Env, session: stripe.CheckoutSession, now: number, promoCode?: string | null): Promise<string | null> {
  const pkg = (session.metadata?.package_id && await loadPackage(env, "id", session.metadata.package_id))
    || await loadPackage(env, "stripe_checkout_session_id", session.id);
  if (!pkg) { console.error("confirmPackage: no bundle for checkout session"); return null; }
  if (pkg.status === "active") return null;
  // Only a checkout still waiting, or one that ran out before this payment
  // arrived, can become active. A bundle the client cancelled never comes back.
  const res = await env.DB.prepare(
    `UPDATE packages SET status = 'active', cancel_reason = NULL, expires_at = ?1, amount_cents = ?2, stripe_payment_intent_id = ?3,
       promo_code = COALESCE(?4, promo_code), updated_at = ?5
     WHERE id = ?6 AND (status = 'pending' OR (status = 'cancelled' AND cancel_reason = 'checkout_expired'))`,
  ).bind(iso(now + (await scheduling(env)).packageValidDays * DAY), session.amount_total ?? pkg.amount_cents, session.payment_intent,
    promoCode ?? null, iso(now), pkg.id).run();
  if (!res.meta.changes) return null;
  await env.DB.prepare("INSERT INTO credit_ledger (package_id, delta, reason) VALUES (?1, ?2, 'purchased')")
    .bind(pkg.id, pkg.credits_total).run();
  return pkg.id;
}

export async function afterPackage(env: Env, id: string): Promise<void> {
  const pkg = await loadPackage(env, "id", id);
  if (!pkg || pkg.status !== "active") return;
  const v = bundleView(pkg);
  if (!pkg.confirmation_sent_at && await sendEmail(env, "bundle_confirmation", null, T.bundlePurchased(v, await packageUrl(env, id)))) {
    await env.DB.prepare("UPDATE packages SET confirmation_sent_at = ?1 WHERE id = ?2").bind(iso(Date.now()), id).run();
  }
  if (!pkg.admin_email_sent_at && await sendEmail(env, "admin_bundle", null, { ...T.adminBundlePurchased(v), to: env.ADMIN_EMAIL })) {
    await env.DB.prepare("UPDATE packages SET admin_email_sent_at = ?1 WHERE id = ?2").bind(iso(Date.now()), id).run();
  }
}

export async function releasePackageForSession(env: Env, sessionId: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE packages SET status = 'cancelled', cancel_reason = 'checkout_expired', updated_at = ?1 WHERE stripe_checkout_session_id = ?2 AND status = 'pending'")
    .bind(iso(now), sessionId).run();
}

// Cron fallback for bundle checkouts Stripe never told us about.
export async function expirePendingPackages(env: Env, now: number): Promise<number> {
  const due = await env.DB.prepare(
    "SELECT id, stripe_checkout_session_id FROM packages WHERE status = 'pending' AND created_at <= ?1 LIMIT 20",
  ).bind(iso(now - (RULES.holdMinutes + 5) * MIN)).all<{ id: string; stripe_checkout_session_id: string | null }>();
  let n = 0;
  for (const p of due.results) {
    try {
      if (p.stripe_checkout_session_id) {
        const s = await stripe.expireCheckoutSession(env, p.stripe_checkout_session_id);
        if (s.status === "complete" && stripe.isPaid(s)) {
          const id = await confirmPackage(env, s, now);
          if (id) await afterPackage(env, id);
          continue;
        }
      }
      await env.DB.prepare("UPDATE packages SET status = 'cancelled', cancel_reason = 'checkout_expired', updated_at = ?1 WHERE id = ?2 AND status = 'pending'").bind(iso(now), p.id).run();
      n++;
    } catch (err) {
      console.error("expirePendingPackages:", (err as Error).message);
    }
  }
  return n;
}

/* ── The client's bundle page ── */

async function loadManagedPackage(env: Env, id: unknown, token: unknown): Promise<PackageRow> {
  const notFound = new BookingError(404, "We couldn't find that bundle. Please use the link in your bundle email.");
  if (!(await validPackageToken(env, id, token))) throw notFound;
  const pkg = await loadPackage(env, "id", id as string);
  if (!pkg) throw notFound;
  return pkg;
}

export async function packageView(env: Env, id: unknown, token: unknown, now: number) {
  const pkg = await loadManagedPackage(env, id, token);
  const expired = !!pkg.expires_at && Date.parse(pkg.expires_at) <= now;
  const remaining = pkg.credits_total - pkg.credits_used;
  const sessions = await env.DB.prepare(
    "SELECT id, start_utc, end_utc, status FROM bookings WHERE package_id = ?1 AND status IN ('confirmed', 'cancelled') ORDER BY start_utc",
  ).bind(pkg.id).all<{ id: string; start_utc: string; end_utc: string; status: string }>();
  const service = sessionService();
  const quote = pkg.status === "active" ? await packageCancelQuote(env, pkg, now) : null;
  return {
    status: pkg.status === "active" ? (expired ? "expired" : "active") : pkg.status === "pending" ? "processing" : "cancelled",
    cancelQuote: quote,
    refundDueCents: pkg.cancel_reason === "client_cancelled" ? pkg.refund_due_cents : null,
    refunded: !!pkg.refunded_at,
    canRequestRefund: !!pkg.stripe_payment_intent_id && pkg.amount_cents - (pkg.refunded_cents ?? 0) > 0
      && !(pkg.status === "active" && !expired && remaining > 0)
      && !(pkg.status === "cancelled" && (pkg.refund_due_cents ?? 0) > (pkg.refunded_cents ?? 0)),
    refundRequest: await (await import("./refunds")).refundRequestStatus(env, "package", pkg.id),
    canBook: pkg.status === "active" && !expired && remaining > 0,
    bundleName: bundleName(findService(pkg.service_id)!),
    credits: pkg.credits_total,
    remaining,
    expiresAt: pkg.expires_at,
    timeZone: pkg.client_time_zone || RULES.timeZone,
    firstName: pkg.name.trim().split(/\s+/)[0],
    serviceId: service.id,
    sessionLength: lengthLabel(service.durationMinutes),
    sessions: await Promise.all(sessions.results.map(async (s) => ({
      start: s.start_utc,
      end: s.end_utc,
      status: s.status === "confirmed" ? (Date.parse(s.end_utc) <= now ? "past" : "upcoming") : "cancelled",
      manageUrl: s.status === "confirmed" && Date.parse(s.end_utc) > now ? await manageUrl(env, s.id) : null,
    }))),
  };
}

export async function bookWithCredit(env: Env, id: unknown, token: unknown, startRaw: unknown, focusRaw: unknown,
  ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const pkg = await loadManagedPackage(env, id, token);
  if (pkg.status !== "active") throw new BookingError(409, "This bundle isn't active.");
  if (pkg.credits_total - pkg.credits_used <= 0) throw new BookingError(409, "There are no sessions left in this bundle.");
  const expiresAt = pkg.expires_at ? Date.parse(pkg.expires_at) : 0;
  const start = Date.parse(String(startRaw ?? ""));
  if (!Number.isFinite(start)) throw new BookingError(400, "Please pick a time.");
  if (expiresAt <= ctx.now || start >= expiresAt) {
    throw new BookingError(409, "Bundle sessions need to take place before the bundle's use-by date.");
  }
  const service = sessionService();
  if (!(await isStillOpen(env, service, start, ctx.now))) throw new BookingError(409, "Sorry, that time was just taken. Please pick another.");

  const intake = pkg.intake_json ? JSON.parse(pkg.intake_json) : {};
  const focus = typeof focusRaw === "string"
    ? focusRaw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ").trim().slice(0, 2000) : "";
  const bookingId = crypto.randomUUID();
  const end = start + service.durationMinutes * MIN;
  try {
    await env.DB.batch([
      // Only written if the bundle is still active at this very moment; if it
      // isn't, the claims below are refused and nothing is booked.
      env.DB.prepare(
        `INSERT INTO bookings (id, customer_id, service_id, start_utc, end_utc, status, amount_cents, package_id,
           ics_uid, intake_json, client_time_zone, confirmed_at, client_name, client_pronouns)
         SELECT ?1, ?2, ?3, ?4, ?5, 'confirmed', 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12
         WHERE EXISTS (SELECT 1 FROM packages WHERE id = ?6 AND status = 'active')`,
      ).bind(bookingId, pkg.customer_id, service.id, iso(start), iso(end), pkg.id, `${bookingId}@averywhitted.com`,
        JSON.stringify({ ...intake, notes: focus || undefined }), pkg.client_time_zone, iso(ctx.now), pkg.name, pkg.pronouns),
      ...blocksFor(start, service.durationMinutes, (await scheduling(env)).bufferMinutes).map((blk) =>
        env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, bookingId)),
      env.DB.prepare("UPDATE packages SET credits_used = credits_used + 1, updated_at = ?1 WHERE id = ?2 AND status = 'active'").bind(iso(ctx.now), pkg.id),
      env.DB.prepare("INSERT INTO credit_ledger (package_id, booking_id, delta, reason) VALUES (?1, ?2, -1, 'booked')").bind(pkg.id, bookingId),
    ]);
  } catch (err) {
    const msg = (err as Error).message;
    if (UNIQUE_CLAIM.test(msg)) throw new BookingError(409, "Sorry, that time was just taken. Please pick another.");
    if (/CHECK constraint failed/i.test(msg)) throw new BookingError(409, "There are no sessions left in this bundle.");
    if (INACTIVE_CLAIM.test(msg)) throw new BookingError(409, "This bundle isn't active.");
    throw err;
  }
  ctx.waitUntil(afterConfirm(env, bookingId));
  return { ok: true, bookingId, manageUrl: await manageUrl(env, bookingId) };
}

/* ── "Sessions expiring" reminder, a week before the use-by date ── */

export async function sendExpiryNotices(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM packages
     WHERE status = 'active' AND expiry_notice_sent_at IS NULL AND credits_used < credits_total
       AND expires_at > ?1 AND expires_at <= ?2 LIMIT 20`,
  ).bind(iso(now), iso(now + RULES.packageExpiryNoticeDays * DAY)).all<{ id: string }>();
  let sent = 0;
  for (const { id } of rows.results) {
    const pkg = await loadPackage(env, "id", id);
    if (!pkg) continue;
    if (await sendEmail(env, "bundle_expiring", null, T.bundleExpiring(bundleView(pkg), await packageUrl(env, id)))) {
      await env.DB.prepare("UPDATE packages SET expiry_notice_sent_at = ?1 WHERE id = ?2").bind(iso(now), id).run();
      sent++;
    }
  }
  return sent;
}

/* ── What the confirmation page may show after buying a bundle ── */

export async function packagePublicStatus(env: Env, sessionId: string) {
  const pkg = await loadPackage(env, "stripe_checkout_session_id", sessionId);
  if (!pkg) return null;
  return {
    type: "package",
    status: pkg.status === "active" ? "confirmed" : pkg.status === "pending" ? "processing" : "cancelled",
    bundleName: bundleName(findService(pkg.service_id)!),
    credits: pkg.credits_total,
    expiresAt: pkg.expires_at,
    timeZone: pkg.client_time_zone || RULES.timeZone,
    firstName: pkg.name.trim().split(/\s+/)[0],
    packageUrl: pkg.status === "active" ? await packageUrl(env, pkg.id) : null,
  };
}

// Bundle emails that failed get another try (like booking confirmations).
export async function retryPackageEmails(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM packages WHERE status = 'active' AND updated_at <= ?1
       AND (confirmation_sent_at IS NULL OR admin_email_sent_at IS NULL) LIMIT 10`,
  ).bind(iso(now - 2 * MIN)).all<{ id: string }>();
  for (const { id } of rows.results) await afterPackage(env, id);
  return rows.results.length;
}

/* ── Cancelling a whole bundle ──
   Policy (change here if it changes, and in policies.html): sessions already
   used are charged at the full single-session price (the bundle discount
   only applies to a finished bundle), and the rest of what was paid is
   refunded. A session counts as used if it already happened or is less
   than 24 hours away (it can't be cancelled online by then).
   Booked sessions 24+ hours away are cancelled along with the bundle.
   Expired bundles can't be cancelled; their unused sessions have lapsed. */

const CUTOFF = 24 * 60 * MIN;

async function cancelQuote(env: Env, pkg: PackageRow, now: number) {
  const booked = await env.DB.prepare(
    "SELECT id, start_utc FROM bookings WHERE package_id = ?1 AND status = 'confirmed' ORDER BY start_utc",
  ).bind(pkg.id).all<{ id: string; start_utc: string }>();
  const cancellable = booked.results.filter((b) => Date.parse(b.start_utc) - now >= CUTOFF);
  const kept = booked.results.filter((b) => Date.parse(b.start_utc) - now < CUTOFF && Date.parse(b.start_utc) > now);
  const used = pkg.credits_used - cancellable.length;       // happened, or too close to cancel
  const paidSessions = findService(pkg.service_id)?.credits ?? pkg.credits_total;
  // Extra sessions Avery added for free are never refunded or charged for.
  const charged = Math.min(used, paidSessions) * sessionService().priceCents;
  // Anything already refunded by hand comes off what's still owed.
  const refundCents = Math.max(0, pkg.amount_cents - (pkg.refunded_cents ?? 0) - charged);
  const expired = !!pkg.expires_at && Date.parse(pkg.expires_at) <= now;
  return {
    canCancel: pkg.status === "active" && !expired,
    used,
    refundCents,
    cancellable,
    kept,
  };
}

export async function cancelPackage(env: Env, id: unknown, token: unknown, ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const pkg = await loadManagedPackage(env, id, token);
  if (pkg.status === "cancelled") throw new BookingError(409, "This bundle is already cancelled.");
  const q = await cancelQuote(env, pkg, ctx.now);
  if (!q.canCancel) throw new BookingError(409, "This bundle's use-by date has passed, so it can't be cancelled online. Please email info@averywhitted.com.");
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE packages SET status = 'cancelled', cancel_reason = 'client_cancelled', cancelled_at = ?1, refund_due_cents = ?2,
           credits_used = credits_used - ?3, updated_at = ?1 WHERE id = ?4 AND status = 'active'`,
      ).bind(iso(ctx.now), q.refundCents, q.cancellable.length, pkg.id),
      // Ledger entries are written once per booking, so a second cancellation
      // arriving at the same moment is rolled back entirely.
      ...q.cancellable.flatMap((b) => [
        env.DB.prepare("INSERT INTO credit_ledger (package_id, booking_id, delta, reason) VALUES (?1, ?2, 1, 'bundle_cancelled')").bind(pkg.id, b.id),
        env.DB.prepare(
          `UPDATE bookings SET status = 'cancelled', cancel_reason = 'bundle_cancelled', cancelled_at = ?1,
             ics_sequence = ics_sequence + 1, updated_at = ?1 WHERE id = ?2 AND status = 'confirmed'`,
        ).bind(iso(ctx.now), b.id),
        env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(b.id),
      ]),
      env.DB.prepare(
        `INSERT INTO credit_ledger (package_id, delta, reason, note) SELECT ?1, 0, 'bundle_cancelled', ?2
         WHERE EXISTS (SELECT 1 FROM packages WHERE id = ?1 AND status = 'cancelled' AND cancelled_at = ?3)`,
      ).bind(pkg.id, `refund due ${(q.refundCents / 100).toFixed(2)}`, iso(ctx.now)),
    ]);
  } catch (err) {
    if (ONCE_ONLY.test((err as Error).message)) throw new BookingError(409, "This bundle is already cancelled.");
    throw err;
  }
  if (!res[0].meta.changes) throw new BookingError(409, "This bundle is already cancelled.");
  ctx.waitUntil(afterPackageCancel(env, pkg.id, q));
  return { ok: true, refundCents: q.refundCents };
}

// A student's bundle cancellation is refunded automatically: exactly the
// refund worked out when it was cancelled, once. Stripe's idempotency key
// makes a retry the same refund, and retries stop after an hour (well inside
// the key's 24-hour life); after that Avery is alerted to do it by hand.
export async function issuePackageRefund(env: Env, id: string, now: number): Promise<boolean> {
  const pkg = await loadPackage(env, "id", id);
  if (!pkg || pkg.status !== "cancelled" || pkg.cancel_reason !== "client_cancelled") return false;
  if (pkg.refunded_at) return true;
  const due = pkg.refund_due_cents ?? 0;
  if (due <= 0 || !pkg.stripe_payment_intent_id) return false;
  try {
    await stripe.refundPayment(env, pkg.stripe_payment_intent_id, pkg.id, due, `bundle-refund-${pkg.id}`);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    console.error("bundle refund failed:", msg);
    await env.DB.prepare("UPDATE packages SET refund_error = ?1, refund_attempts = refund_attempts + 1 WHERE id = ?2").bind(msg, pkg.id).run();
    return false;
  }
  await env.DB.prepare(
    "UPDATE packages SET refunded_at = ?1, refunded_cents = refunded_cents + ?2, refund_error = NULL WHERE id = ?3 AND refunded_at IS NULL",
  ).bind(iso(now), due, pkg.id).run();
  return true;
}

// Cron: retries bundle refunds that didn't go through (for up to an hour).
export async function retryPackageRefunds(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM packages WHERE status = 'cancelled' AND cancel_reason = 'client_cancelled' AND refunded_at IS NULL
       AND refund_due_cents > 0 AND refund_attempts BETWEEN 1 AND 11 AND cancelled_at <= ?1 LIMIT 20`,
  ).bind(iso(now - 2 * 60000)).all<{ id: string }>();
  let done = 0;
  for (const { id } of rows.results) if (await issuePackageRefund(env, id, now)) done++;
  return done;
}

async function afterPackageCancel(env: Env, id: string, q: Awaited<ReturnType<typeof cancelQuote>>): Promise<void> {
  if (q.refundCents > 0) await issuePackageRefund(env, id, Date.now());
  // Remove each cancelled session from the Coaching calendar and Zoom.
  for (const b of q.cancellable) await afterCancelShared(env, b.id, { notifyClient: false, notifyAvery: false });
  const pkg = await loadPackage(env, "id", id);
  if (!pkg) return;
  const v: T.BundleCancelView = {
    ...bundleView(pkg), used: q.used, refundCents: q.refundCents,
    cancelledSessions: q.cancellable.map((b) => Date.parse(b.start_utc)),
    keptSessions: q.kept.map((b) => Date.parse(b.start_utc)),
  };
  await sendEmail(env, "bundle_cancelled", null, T.bundleCancelled(v));
  await sendEmail(env, "admin_bundle_cancelled", null, {
    ...T.adminBundleCancelled(v, stripePaymentUrl(env, pkg.stripe_payment_intent_id), !!pkg.refunded_at), to: env.ADMIN_EMAIL,
  });
}

export async function packageCancelQuote(env: Env, pkg: PackageRow, now: number) {
  const q = await cancelQuote(env, pkg, now);
  return { canCancel: q.canCancel, used: q.used, refundCents: q.refundCents, sessionPriceCents: sessionService().priceCents, paidCents: pkg.amount_cents, cancelSessions: q.cancellable.map((b) => b.start_utc), keptSessions: q.kept.map((b) => b.start_utc) };
}

/* ── "Finish buying your bundle" (same rules as single-session reminders) ── */

export async function sendBundleReminders(env: Env, now: number): Promise<number> {
  if (!(await scheduling(env)).remindersEnabled) return 0;
  const rows = await env.DB.prepare(
    `SELECT p.id, p.service_id FROM packages p
     WHERE p.status = 'cancelled' AND p.cancel_reason = 'checkout_expired' AND p.reminder_sent_at IS NULL
       AND p.updated_at >= ?1
       AND NOT EXISTS (SELECT 1 FROM packages o WHERE o.customer_id = p.customer_id AND o.id <> p.id
                         AND o.created_at >= p.created_at AND o.status IN ('pending', 'active'))
       AND NOT EXISTS (SELECT 1 FROM packages r WHERE r.customer_id = p.customer_id AND r.reminder_sent_at >= ?2)
       AND NOT EXISTS (SELECT 1 FROM bookings r WHERE r.customer_id = p.customer_id AND r.reminder_sent_at >= ?2)
     LIMIT 20`,
  ).bind(iso(now - DAY), iso(now - 7 * DAY)).all<{ id: string; service_id: string }>();
  let sent = 0;
  for (const r of rows.results) {
    const pkg = await loadPackage(env, "id", r.id);
    if (!pkg) continue;
    if (await sendEmail(env, "bundle_checkout_reminder", null, T.bundleCheckoutReminder(bundleView(pkg), `${env.SITE_URL}/book/?service=${r.service_id}`))) {
      await env.DB.prepare("UPDATE packages SET reminder_sent_at = ?1 WHERE id = ?2").bind(iso(now), r.id).run();
      sent++;
    }
  }
  return sent;
}

/* ── Avery cancels a bundle (e.g. the client asked) ──
   Every upcoming session from it is cancelled, even inside 24 hours, and
   Avery chooses the refund: the policy amount, all of it, none, or her own. */

async function upcomingFromBundle(env: Env, pkgId: string, now: number) {
  return (await env.DB.prepare(
    "SELECT id, start_utc FROM bookings WHERE package_id = ?1 AND status = 'confirmed' AND start_utc > ?2 ORDER BY start_utc",
  ).bind(pkgId, iso(now)).all<{ id: string; start_utc: string }>()).results;
}

export async function adminPackageCancelPreview(env: Env, id: string, now: number) {
  const pkg = await loadPackage(env, "id", id);
  if (!pkg || pkg.status !== "active") throw new BookingError(404, "Bundle not found.");
  const q = await cancelQuote(env, pkg, now);
  const upcoming = await upcomingFromBundle(env, pkg.id, now);
  return {
    name: pkg.name, pronouns: pkg.pronouns, bundleName: bundleName(findService(pkg.service_id)!), paidCents: pkg.amount_cents,
    leftCents: pkg.amount_cents - (pkg.refunded_cents ?? 0),
    canRefund: !!pkg.stripe_payment_intent_id && pkg.amount_cents - (pkg.refunded_cents ?? 0) > 0,
    policyRefundCents: q.refundCents, used: pkg.credits_used - upcoming.length,
    upcoming: upcoming.map((b) => b.start_utc),
  };
}

export async function adminCancelPackage(env: Env, id: string, opts: { refundCents: number; notifyClient: boolean },
  ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const pkg = await loadPackage(env, "id", id);
  if (!pkg || pkg.status !== "active") throw new BookingError(409, "This bundle isn't active.");
  const refund = Math.round(opts.refundCents);
  const left = pkg.amount_cents - (pkg.refunded_cents ?? 0);
  if (!Number.isInteger(refund) || refund < 0 || refund > left) {
    throw new BookingError(400, `The refund has to be between $0 and what's left of their payment ($${(left / 100).toFixed(2)}).`);
  }
  if (refund > 0 && !pkg.stripe_payment_intent_id) throw new BookingError(400, "There's no Stripe payment to refund for this bundle.");
  const now = ctx.now;
  const upcoming = await upcomingFromBundle(env, pkg.id, now);
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE packages SET status = 'cancelled', cancel_reason = 'avery_cancelled', cancelled_at = ?1, refund_due_cents = ?2,
           credits_used = credits_used - ?3, updated_at = ?1 WHERE id = ?4 AND status = 'active'`,
      ).bind(iso(now), refund, upcoming.length, pkg.id),
      ...upcoming.flatMap((b) => [
        env.DB.prepare("INSERT INTO credit_ledger (package_id, booking_id, delta, reason) VALUES (?1, ?2, 1, 'bundle_cancelled')").bind(pkg.id, b.id),
        env.DB.prepare(
          `UPDATE bookings SET status = 'cancelled', cancel_reason = 'bundle_cancelled', cancelled_at = ?1,
             ics_sequence = ics_sequence + 1, updated_at = ?1 WHERE id = ?2 AND status = 'confirmed'`,
        ).bind(iso(now), b.id),
        env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(b.id),
      ]),
      env.DB.prepare(
        `INSERT INTO credit_ledger (package_id, delta, reason, note) SELECT ?1, 0, 'avery_cancelled', ?2
         WHERE EXISTS (SELECT 1 FROM packages WHERE id = ?1 AND status = 'cancelled' AND cancelled_at = ?3)`,
      ).bind(pkg.id, `cancelled by Avery, refund ${(refund / 100).toFixed(2)}`, iso(now)),
    ]);
  } catch (err) {
    if (ONCE_ONLY.test((err as Error).message)) throw new BookingError(409, "This bundle is already cancelled.");
    throw err;
  }
  if (!res[0].meta.changes) throw new BookingError(409, "This bundle is already cancelled.");

  let refunded = refund === 0;
  if (refund > 0) {
    try {
      await stripe.refundPayment(env, pkg.stripe_payment_intent_id!, pkg.id, refund, `refund-${pkg.stripe_payment_intent_id}-${pkg.refunded_cents ?? 0}-${refund}`);
      await env.DB.prepare("UPDATE packages SET refunded_at = ?1, refund_error = NULL WHERE id = ?2").bind(iso(now), pkg.id).run();
      refunded = true;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      console.error("bundle refund failed:", msg);
      await env.DB.prepare("UPDATE packages SET refund_error = ?1 WHERE id = ?2").bind(msg, pkg.id).run();
    }
  }
  ctx.waitUntil((async () => {
    for (const b of upcoming) await afterCancelShared(env, b.id, { notifyClient: false, notifyAvery: false });
    if (!opts.notifyClient) return;
    const fresh = (await loadPackage(env, "id", pkg.id))!;
    await sendEmail(env, "bundle_cancelled", null, T.bundleCancelled({
      ...bundleView(fresh), byAvery: true, used: pkg.credits_used - upcoming.length, refundCents: refund,
      cancelledSessions: upcoming.map((b) => Date.parse(b.start_utc)), keptSessions: [],
    }));
  })());
  return { ok: true, refunded, message: refunded ? "Bundle cancelled." : "Bundle cancelled, but Stripe didn't accept the refund. Refund it in Stripe." };
}
