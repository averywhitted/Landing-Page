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
import { RULES } from "./settings";
import { iso } from "./time";
import { BookingError, CLIENT_COLUMNS, ONCE_ONLY, afterCancelShared, dueCents, issueRefund, loadBooking, serviceLabel } from "./bookings";
import { SettingsError, defaults, loadScheduling, resetScheduling, saveScheduling, validate } from "./config";
import { calendarFor } from "./calendar";
import { nextAutoReminder } from "./sessions";
import { scheduling } from "./config";
import { sendEmail } from "./email";
import * as T from "./templates";

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

const stripeUrlFor = (env: Env) => {
  const test = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "");
  return (pi: string | null) => (pi ? `https://dashboard.stripe.com/${test ? "test/" : ""}payments/${pi}` : null);
};

// Sessions between two times, as the admin page shows them.
async function sessionsBetween(env: Env, from: number, to: number, now: number) {
  const bookings = await env.DB.prepare(
    `SELECT b.id, b.service_id, b.start_utc, b.end_utc, b.status, b.cancel_reason, b.amount_cents, b.promo_code,
            b.package_id, COALESCE(g.zoom_join_url, b.zoom_join_url) AS zoom_join_url,
            COALESCE(g.calendar_event_url, b.calendar_event_url) IS NOT NULL AS in_calendar, b.calendar_event_url IS NOT NULL AS own_calendar,
            b.group_id, b.created_by, b.price_cents, b.paid_at, b.pay_by, b.invite_message,
            b.client_email_sent_at IS NOT NULL AS emailed, b.stripe_payment_intent_id, b.refunded_at, b.intake_json,
            b.refund_requested_at, b.refund_error, b.cleanup_error, b.refunded_cents, b.attendance, b.payment_reminders_sent,
            b.last_payment_reminder_at, b.payment_reminder_sent_at, b.created_at, b.series_id,
            (SELECT every_weeks FROM series s WHERE s.id = b.series_id AND s.status IN ('pending', 'active')) AS series_every, b.zoom_meeting_id IS NOT NULL AS zoom_left, c.id AS customer_id,
            ${CLIENT_COLUMNS("b")}
     FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN groups g ON g.id = b.group_id
     WHERE b.status IN ('confirmed', 'cancelled') AND b.start_utc >= ?1 AND b.start_utc <= ?2
     ORDER BY b.start_utc`,
  ).bind(iso(from), iso(to)).all<Record<string, any>>();
  const stripeUrl = stripeUrlFor(env);
  return {
    rows: bookings.results,
    list: bookings.results.map((b) => ({
      id: b.id,
      service: serviceLabel(findService(b.service_id)!),
      serviceId: b.service_id,
      start: b.start_utc,
      end: b.end_utc,
      status: b.status,
      cancelReason: b.cancel_reason,
      past: Date.parse(b.end_utc) <= now,
      paid: b.package_id ? "bundle" : b.amount_cents,
      groupId: b.group_id,
      byAvery: b.created_by === "admin",
      priceCents: b.price_cents,
      dueCents: dueCents(b as any),
      payBy: b.pay_by,
      remindersSent: b.payment_reminders_sent,
      lastReminderAt: b.last_payment_reminder_at,
      nextReminderAt: nextAutoReminder(b as any, now),
      refundedCents: b.refunded_cents,
      noShow: b.attendance === "no_show",
      studentNotes: b.student_notes,
      seriesId: b.series_id,
      repeatEvery: b.series_every,
      unpaidReleased: b.cancel_reason === "unpaid",
      promoCode: b.promo_code,
      zoomUrl: b.zoom_join_url,
      inCalendar: !!b.in_calendar,
      emailed: !!b.emailed,
      refunded: !!b.refunded_at,
      // Paid single session, cancelled, not refunded: "auto" is being retried, "choice" is Avery's call.
      refundOwed: b.status === "cancelled" && !b.refunded_at && !b.package_id && b.amount_cents > 0 && b.stripe_payment_intent_id
        && ["client_cancelled", "slot_taken_after_payment", "avery_cancelled"].includes(b.cancel_reason)
        ? (b.refund_requested_at ? "auto" : "choice") : null,
      // An automatic refund only counts as stuck after 15 minutes (it's usually done within seconds).
      refundStuck: !!b.refund_requested_at && !b.refunded_at && Date.parse(b.refund_requested_at) < now - 15 * 60000,
      refundError: b.refund_error,
      stripeUrl: stripeUrl(b.stripe_payment_intent_id),
      packageId: b.package_id,
      customerId: b.customer_id,
      name: b.name,
      email: b.email,
      pronouns: b.pronouns,
      intake: b.intake_json ? JSON.parse(b.intake_json) : null,
    })),
  };
}

export async function adminOverview(env: Env, now: number) {
  const { rows, list } = await sessionsBetween(env, now - 30 * DAY, now + 120 * DAY, now);
  const bookings = { results: rows };

  const packages = await env.DB.prepare(
    `SELECT p.id, p.service_id, p.status, p.credits_total, p.credits_used, p.expires_at, p.amount_cents, p.promo_code,
            p.created_at, p.refund_due_cents, p.refunded_at, p.refunded_cents, p.cancelled_at, p.stripe_payment_intent_id, p.refund_error, p.cancel_reason,
            c.id AS customer_id, ${CLIENT_COLUMNS("p")}
     FROM packages p JOIN customers c ON c.id = p.customer_id
     WHERE (p.status = 'active' AND (p.expires_at >= ?1 OR p.credits_used < p.credits_total))
        OR (p.status = 'cancelled' AND p.cancel_reason IN ('client_cancelled', 'avery_cancelled') AND p.cancelled_at >= ?2)
     ORDER BY p.status, p.expires_at`,
  ).bind(iso(now - 60 * DAY), iso(now - 30 * DAY)).all<Record<string, any>>();

  const failedEmails = await env.DB.prepare(
    `SELECT e.kind, e.error, e.created_at, e.booking_id FROM email_log e
     WHERE e.status = 'failed' AND e.created_at >= ?1 ORDER BY e.created_at DESC LIMIT 30`,
  ).bind(iso(now - 14 * DAY)).all<Record<string, any>>();

  const holds = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE status = 'held' AND hold_expires_at > ?1",
  ).bind(iso(now)).first<{ n: number }>();

  const stripeTest = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "");
  const stripeUrl = stripeUrlFor(env);

  return {
    now: iso(now),
    mode: stripeTest ? "test" : "live",
    bookings: list,
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
      pronouns: p.pronouns,
      email: p.email,
      cancelled: p.status === "cancelled",
      refundDueCents: p.refund_due_cents,
      refunded: !!p.refunded_at,
      refundedCents: p.refunded_cents,
      stripeUrl: stripeUrl(p.stripe_payment_intent_id),
      refundError: p.refund_error,
      cancelledByAvery: p.cancel_reason === "avery_cancelled",
      cancelledAt: p.cancelled_at,
      customerId: p.customer_id,
    })),
    problems: {
      failedEmails: failedEmails.results.map((e) => ({ kind: e.kind, error: e.error, at: e.created_at })),
      stuck: bookings.results.filter((b) => b.status === "confirmed" && Date.parse(b.end_utc) > now && (!b.in_calendar || !b.emailed))
        .map((b) => ({ id: b.id, name: b.name, pronouns: b.pronouns, start: b.start_utc, inCalendar: !!b.in_calendar, emailed: !!b.emailed })),
      // Cancelled but still on the Coaching calendar (removal keeps retrying).
      leftOnCalendar: bookings.results.filter((b) => b.status === "cancelled" && b.own_calendar && Date.parse(b.end_utc) > now)
        .map((b) => ({ id: b.id, name: b.name, pronouns: b.pronouns, start: b.start_utc, error: b.cleanup_error })),
      // Cancelled sessions whose Zoom meeting couldn't be deleted (keeps retrying).
      zoomLeft: bookings.results.filter((b) => b.status === "cancelled" && b.zoom_left && Date.parse(b.end_utc) > now)
        .map((b) => ({ id: b.id, name: b.name, pronouns: b.pronouns, start: b.start_utc, error: b.cleanup_error })),
      activeHolds: holds?.n ?? 0,
      refundRequests: await (await import("./refunds")).openRefundRequests(env),
      icloud: await (await import("./extras")).calendarHealth(env),
    },
    backups: { on: !!env.BACKUPS, last: await (await import("./extras")).lastBackup(env) },
  };
}

/* ── Calendar view: sessions and blocked time ── */

export async function adminCalendar(env: Env, fromRaw: unknown, toRaw: unknown, now: number) {
  const from = Date.parse(String(fromRaw ?? ""));
  const to = Date.parse(String(toRaw ?? ""));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 45 * DAY) {
    throw new BookingError(400, "Pick a range of up to 45 days.");
  }
  const { list } = await sessionsBetween(env, from - DAY, to, now);
  // Busy time on the calendars that block booking. Only times are sent, never
  // titles, and Avery's own coaching sessions are left out (they show as sessions).
  let busy: { start: string; end: string }[] | null = null;
  try {
    const own = new Set((await env.DB.prepare(
      `SELECT ics_uid FROM bookings WHERE start_utc < ?2 AND end_utc > ?1
       UNION SELECT ics_uid FROM groups WHERE start_utc < ?2 AND end_utc > ?1`,
    ).bind(iso(from - DAY), iso(to + DAY)).all<{ ics_uid: string }>()).results.map((r) => r.ics_uid));
    const events = (await calendarFor(env, await scheduling(env)).getBusy(from, to))
      .filter((e) => !e.uid || !own.has(e.uid)).sort((a, b) => a.start - b.start);
    // Merge overlaps so each blocked stretch shows once.
    const merged: { start: number; end: number }[] = [];
    for (const e of events) {
      const last = merged.at(-1);
      if (last && e.start <= last.end) last.end = Math.max(last.end, e.end);
      else merged.push({ start: e.start, end: e.end });
    }
    busy = merged.map((e) => ({ start: iso(e.start), end: iso(e.end) }));
  } catch (err) {
    console.error("admin calendar: busy lookup failed:", (err as Error).message);
  }
  const cfg = await scheduling(env);
  return { bookings: list, busy, rules: { workDays: cfg.workDays, dayStartHour: cfg.dayStartHour, dayEndHour: cfg.dayEndHour } };
}

/* ── Editable settings ── */

export async function adminGetSettings(env: Env) {
  const loaded = await loadScheduling(env);
  let calendars: string[] | null = null;
  try { calendars = await calendarFor(env).listNames(); } catch (err) { console.error("settings: calendar list failed:", (err as Error).message); }
  return { ...loaded, defaults: defaults(env), timeZone: RULES.timeZone, calendars };
}

export async function adminSaveSettings(env: Env, input: unknown, by: string) {
  let values;
  try { values = validate(input); } catch (err) {
    if (err instanceof SettingsError) throw new BookingError(400, err.message);
    throw err;
  }
  // Make sure every chosen calendar really exists in iCloud before saving.
  let names: string[];
  try { names = await calendarFor(env).listNames(); } catch {
    throw new BookingError(503, "Couldn't reach iCloud to check your calendars. Please try again in a moment.");
  }
  const missing = values.busyCalendars.filter((n) => !names.includes(n));
  if (missing.length) throw new BookingError(400, `These calendars weren't found in iCloud: ${missing.join(", ")}.`);
  await saveScheduling(env, values, by);
  return adminGetSettings(env);
}

export async function adminResetSettings(env: Env) {
  await resetScheduling(env);
  return adminGetSettings(env);
}

/* ── Actions ── */

// Avery cancels on a client's behalf, at any time (no 24-hour limit).
export async function adminCancelBooking(env: Env, id: string, opts: { notifyClient: boolean; returnCredit: boolean; refund?: boolean; note?: string },
  ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const row = await loadBooking(env, "id", id);
  if (!row) throw new BookingError(404, "Booking not found.");
  if (row.status !== "confirmed") throw new BookingError(409, "Only confirmed bookings can be cancelled.");
  const giveBack = !!row.package_id && opts.returnCredit;
  const refund = !!opts.refund && !row.package_id && row.amount_cents > 0 && !!row.stripe_payment_intent_id;
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE bookings SET status = 'cancelled', cancel_reason = 'avery_cancelled', cancelled_at = ?1, refund_requested_at = ?3,
           ics_sequence = ics_sequence + 1, updated_at = ?1 WHERE id = ?2 AND status = 'confirmed'`,
      ).bind(iso(ctx.now), id, refund ? iso(ctx.now) : null),
      env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(id),
      // Written once per booking only, so a double click can't return two credits.
      ...(giveBack ? [
        env.DB.prepare("INSERT INTO credit_ledger (package_id, booking_id, delta, reason, note) VALUES (?1, ?2, 1, 'avery_cancelled', ?3)")
          .bind(row.package_id, id, opts.note?.slice(0, 300) ?? null),
        env.DB.prepare("UPDATE packages SET credits_used = credits_used - 1, updated_at = ?1 WHERE id = ?2").bind(iso(ctx.now), row.package_id),
      ] : []),
    ]);
  } catch (err) {
    if (ONCE_ONLY.test((err as Error).message)) throw new BookingError(409, "This session is already cancelled.");
    throw err;
  }
  if (!res[0].meta.changes) throw new BookingError(409, "This session is already cancelled.");
  ctx.waitUntil((async () => {
    if (refund) await issueRefund(env, id, ctx.now);
    await afterCancelShared(env, id, { notifyClient: opts.notifyClient, notifyAvery: false });
  })());
  return { ok: true };
}

// Refunds a session cancelled from the admin page earlier (the client chose a refund).
export async function adminRefundBooking(env: Env, id: string, ctx: { now: number }) {
  const row = await loadBooking(env, "id", id);
  if (!row) throw new BookingError(404, "Booking not found.");
  if (row.status !== "cancelled") throw new BookingError(409, "Only cancelled sessions can be refunded here.");
  if (row.refunded_at) throw new BookingError(409, "This session is already refunded.");
  if (row.package_id || row.amount_cents <= 0 || !row.stripe_payment_intent_id) throw new BookingError(409, "There's no payment to refund for this session.");
  await env.DB.prepare("UPDATE bookings SET refund_requested_at = COALESCE(refund_requested_at, ?1) WHERE id = ?2 AND status = 'cancelled'")
    .bind(iso(ctx.now), id).run();
  const ok = await issueRefund(env, id, ctx.now);
  return { ok, message: ok ? "Refunded." : "Stripe didn't accept the refund yet. It will keep retrying." };
}

export async function adminAdjustCredits(env: Env, packageId: string, delta: number, note: string, now: number,
  notify?: { message: string }) {
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
  if (notify) await tellStudentAboutBundle(env, packageId, delta > 0 ? "added" : "removed", notify.message);
  return { ok: true };
}

// Emails the student that Avery changed their bundle, with her note.
async function tellStudentAboutBundle(env: Env, packageId: string, change: "added" | "removed" | "extended", message: string) {
  const { loadPackage, bundleView } = await import("./packages");
  const { packageUrl } = await import("./manage");
  const pkg = await loadPackage(env, "id", packageId);
  if (!pkg) return;
  const sent = await sendEmail(env, "bundle_updated", null,
    T.bundleUpdated(bundleView(pkg), change, message.slice(0, 1000), await packageUrl(env, packageId)));
  if (!sent) throw new BookingError(502, "The change was saved, but the email to the student couldn't be sent.");
}

export async function adminExtendPackage(env: Env, packageId: string, days: number, now: number, notify?: { message: string }) {
  if (![7, 14, 30].includes(days)) throw new BookingError(400, "Extend by 7, 14, or 30 days.");
  const pkg = await env.DB.prepare("SELECT expires_at, status FROM packages WHERE id = ?1").bind(packageId).first<{ expires_at: string | null; status: string }>();
  if (!pkg || pkg.status !== "active") throw new BookingError(404, "Bundle not found.");
  // Extending an expired bundle counts from today.
  const from = Math.max(pkg.expires_at ? Date.parse(pkg.expires_at) : now, now);
  await env.DB.batch([
    env.DB.prepare("UPDATE packages SET expires_at = ?1, expiry_notice_sent_at = NULL, updated_at = ?2 WHERE id = ?3").bind(iso(from + days * DAY), iso(now), packageId),
    env.DB.prepare("INSERT INTO credit_ledger (package_id, delta, reason, note) VALUES (?1, 0, 'avery_extended', ?2)").bind(packageId, `+${days} days`),
  ]);
  if (notify) await tellStudentAboutBundle(env, packageId, "extended", notify.message);
  return { ok: true, expiresAt: iso(from + days * DAY) };
}
