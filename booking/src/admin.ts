// Avery's admin view: book.averywhitted.com/admin
//
// Locked twice:
//  1. Cloudflare Access sits in front of /admin and /api/admin and only lets
//     Avery's email through (set up in the Cloudflare dashboard).
//  2. This code also checks the signed pass Access attaches to each request
//     (the Cf-Access-Jwt-Assertion header) and refuses anything without a
//     valid one, so a mistake in the Access setup can't expose data.
// Until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, admin is switched off.

import type { Env } from "./env";
import { findService } from "./services";
import { RULES, CALENDARS } from "./settings";
import { iso } from "./time";
import { BookingError, loadBooking, serviceLabel } from "./bookings";
import { afterCancelShared } from "./bookings";

const MIN = 60000;
const DAY = 24 * 60 * MIN;

/* ── Verifying Cloudflare Access's signed pass ── */

type Jwk = JsonWebKey & { kid: string };
let certCache: { at: number; keys: Jwk[] } | null = null;

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function accessKeys(env: Env): Promise<Jwk[]> {
  if (certCache && Date.now() - certCache.at < 60 * MIN) return certCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed (${res.status})`);
  const keys = ((await res.json()) as { keys: Jwk[] }).keys;
  certCache = { at: Date.now(), keys };
  return keys;
}

export function resetAccessCache() { certCache = null; }

// Returns the signed-in email, or throws.
export async function requireAdmin(env: Env, req: Request): Promise<string> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new BookingError(403, "Admin isn't set up yet.");
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new BookingError(403, "Not signed in.");
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new BookingError(403, "Not signed in.");
  let header: { kid?: string; alg?: string }, payload: { aud?: string | string[]; exp?: number; iss?: string; email?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch { throw new BookingError(403, "Not signed in."); }
  if (header.alg !== "RS256") throw new BookingError(403, "Not signed in.");
  const jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) throw new BookingError(403, "Not signed in.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!ok || !auds.includes(env.ACCESS_AUD) || !payload.exp || payload.exp * 1000 < Date.now()
    || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) {
    throw new BookingError(403, "Not signed in.");
  }
  const allowed = (env.ADMIN_ALLOWED_EMAILS ?? env.ADMIN_EMAIL).split(",").map((e) => e.trim().toLowerCase());
  if (!payload.email || !allowed.includes(payload.email.toLowerCase())) throw new BookingError(403, "This account isn't allowed here.");
  return payload.email;
}

/* ── Overview ── */

export async function adminOverview(env: Env, now: number) {
  const bookings = await env.DB.prepare(
    `SELECT b.id, b.service_id, b.start_utc, b.end_utc, b.status, b.cancel_reason, b.amount_cents, b.promo_code,
            b.package_id, b.zoom_join_url, b.calendar_event_url IS NOT NULL AS in_calendar,
            b.client_email_sent_at IS NOT NULL AS emailed, b.stripe_payment_intent_id, b.refunded_at, b.intake_json,
            c.name, c.email, c.pronouns
     FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.status IN ('confirmed', 'cancelled') AND b.start_utc >= ?1 AND b.start_utc <= ?2
     ORDER BY b.start_utc`,
  ).bind(iso(now - 30 * DAY), iso(now + 120 * DAY)).all<Record<string, any>>();

  const packages = await env.DB.prepare(
    `SELECT p.id, p.service_id, p.status, p.credits_total, p.credits_used, p.expires_at, p.amount_cents, p.promo_code,
            p.created_at, c.name, c.email
     FROM packages p JOIN customers c ON c.id = p.customer_id
     WHERE p.status = 'active' AND (p.expires_at >= ?1 OR p.credits_used < p.credits_total)
     ORDER BY p.expires_at`,
  ).bind(iso(now - 60 * DAY)).all<Record<string, any>>();

  const failedEmails = await env.DB.prepare(
    `SELECT e.kind, e.error, e.created_at, e.booking_id FROM email_log e
     WHERE e.status = 'failed' AND e.created_at >= ?1 ORDER BY e.created_at DESC LIMIT 30`,
  ).bind(iso(now - 14 * DAY)).all<Record<string, any>>();

  const holds = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE status = 'held' AND hold_expires_at > ?1",
  ).bind(iso(now)).first<{ n: number }>();

  const stripeTest = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "");
  const stripeUrl = (pi: string | null) => (pi ? `https://dashboard.stripe.com/${stripeTest ? "test/" : ""}payments/${pi}` : null);

  return {
    now: iso(now),
    mode: stripeTest ? "test" : "live",
    bookings: bookings.results.map((b) => ({
      id: b.id,
      service: serviceLabel(findService(b.service_id)!),
      start: b.start_utc,
      end: b.end_utc,
      status: b.status,
      cancelReason: b.cancel_reason,
      past: Date.parse(b.end_utc) <= now,
      paid: b.package_id ? "bundle" : b.amount_cents,
      promoCode: b.promo_code,
      zoomUrl: b.zoom_join_url,
      inCalendar: !!b.in_calendar,
      emailed: !!b.emailed,
      refunded: !!b.refunded_at,
      stripeUrl: stripeUrl(b.stripe_payment_intent_id),
      packageId: b.package_id,
      name: b.name,
      email: b.email,
      pronouns: b.pronouns,
      intake: b.intake_json ? JSON.parse(b.intake_json) : null,
    })),
    packages: packages.results.map((p) => ({
      id: p.id,
      bundle: `${findService(p.service_id)?.credits ?? p.credits_total} session bundle`,
      creditsTotal: p.credits_total,
      creditsUsed: p.credits_used,
      remaining: p.credits_total - p.credits_used,
      expiresAt: p.expires_at,
      expired: !!p.expires_at && Date.parse(p.expires_at) <= now,
      amountCents: p.amount_cents,
      promoCode: p.promo_code,
      name: p.name,
      email: p.email,
    })),
    problems: {
      failedEmails: failedEmails.results.map((e) => ({ kind: e.kind, error: e.error, at: e.created_at })),
      stuck: bookings.results.filter((b) => b.status === "confirmed" && Date.parse(b.end_utc) > now && (!b.in_calendar || !b.emailed))
        .map((b) => ({ id: b.id, name: b.name, start: b.start_utc, inCalendar: !!b.in_calendar, emailed: !!b.emailed })),
      activeHolds: holds?.n ?? 0,
    },
    rules: {
      timeZone: RULES.timeZone,
      hours: `${RULES.dayStartHour}:00 to ${RULES.dayEndHour}:00`,
      bufferMinutes: RULES.bufferMinutes,
      minNoticeHours: RULES.minNoticeHours,
      slotStepMinutes: RULES.slotStepMinutes,
      blockingCalendars: CALENDARS.busy,
      bookingCalendar: CALENDARS.booking,
      bundleValidDays: RULES.packageValidDays,
      remindersEnabled: env.REMINDERS_ENABLED === "1",
    },
  };
}

/* ── Actions ── */

// Avery cancels on a client's behalf, at any time (no 24-hour limit).
export async function adminCancelBooking(env: Env, id: string, opts: { notifyClient: boolean; returnCredit: boolean; note?: string },
  ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const row = await loadBooking(env, "id", id);
  if (!row) throw new BookingError(404, "Booking not found.");
  if (row.status !== "confirmed") throw new BookingError(409, "Only confirmed bookings can be cancelled.");
  const giveBack = !!row.package_id && opts.returnCredit;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET status = 'cancelled', cancel_reason = 'avery_cancelled', cancelled_at = ?1,
         ics_sequence = ics_sequence + 1, updated_at = ?1 WHERE id = ?2 AND status = 'confirmed'`,
    ).bind(iso(ctx.now), id),
    env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(id),
    ...(giveBack ? [
      env.DB.prepare("UPDATE packages SET credits_used = credits_used - 1, updated_at = ?1 WHERE id = ?2").bind(iso(ctx.now), row.package_id),
      env.DB.prepare("INSERT INTO credit_ledger (package_id, booking_id, delta, reason, note) VALUES (?1, ?2, 1, 'avery_cancelled', ?3)")
        .bind(row.package_id, id, opts.note?.slice(0, 300) ?? null),
    ] : []),
  ]);
  ctx.waitUntil(afterCancelShared(env, id, { notifyClient: opts.notifyClient, notifyAvery: false }));
  return { ok: true };
}

export async function adminAdjustCredits(env: Env, packageId: string, delta: number, note: string, now: number) {
  if (delta !== 1 && delta !== -1) throw new BookingError(400, "Credits change one at a time.");
  const pkg = await env.DB.prepare("SELECT credits_total, credits_used, status FROM packages WHERE id = ?1").bind(packageId)
    .first<{ credits_total: number; credits_used: number; status: string }>();
  if (!pkg || pkg.status !== "active") throw new BookingError(404, "Bundle not found.");
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE packages SET credits_total = credits_total + ?1, updated_at = ?2 WHERE id = ?3").bind(delta, iso(now), packageId),
      env.DB.prepare("INSERT INTO credit_ledger (package_id, delta, reason, note) VALUES (?1, ?2, ?3, ?4)")
        .bind(packageId, delta, delta > 0 ? "avery_added" : "avery_removed", note.slice(0, 300) || null),
    ]);
  } catch (err) {
    if (/CHECK constraint failed/i.test((err as Error).message)) throw new BookingError(409, "They've already booked every remaining session, so there's no unused credit to remove.");
    throw err;
  }
  return { ok: true };
}

export async function adminExtendPackage(env: Env, packageId: string, days: number, now: number) {
  if (![7, 14, 30].includes(days)) throw new BookingError(400, "Extend by 7, 14, or 30 days.");
  const pkg = await env.DB.prepare("SELECT expires_at, status FROM packages WHERE id = ?1").bind(packageId).first<{ expires_at: string | null; status: string }>();
  if (!pkg || pkg.status !== "active") throw new BookingError(404, "Bundle not found.");
  // Extending an expired bundle counts from today.
  const from = Math.max(pkg.expires_at ? Date.parse(pkg.expires_at) : now, now);
  await env.DB.batch([
    env.DB.prepare("UPDATE packages SET expires_at = ?1, expiry_notice_sent_at = NULL, updated_at = ?2 WHERE id = ?3").bind(iso(from + days * DAY), iso(now), packageId),
    env.DB.prepare("INSERT INTO credit_ledger (package_id, delta, reason, note) VALUES (?1, 0, 'avery_extended', ?2)").bind(packageId, `+${days} days`),
  ]);
  return { ok: true, expiresAt: iso(from + days * DAY) };
}
