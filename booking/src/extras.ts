// Admin extras: private notes, attendance, the CSV export, the iCloud health
// check, and backups.

import type { Env } from "./env";
import { findService } from "./services";
import { RULES } from "./settings";
import { iso, zonedToUtc } from "./time";
import { sendEmail } from "./email";
import * as T from "./templates";
import { calendarFor } from "./calendar";
import { scheduling } from "./config";
import { logEvent } from "./events";
import { BookingError, CLIENT_COLUMNS, clean, refreshCalendarEvent, serviceLabel } from "./bookings";

const MIN = 60000;
const DAY = 24 * 60 * MIN;

/* ── Private notes about a student ── */

export async function adminSaveNotes(env: Env, customerId: string, notesRaw: unknown, now: number) {
  const notes = clean(notesRaw, 5000, true) || null;
  const res = await env.DB.prepare("UPDATE customers SET notes = ?1 WHERE id = ?2").bind(notes, customerId).run();
  if (!res.meta.changes) throw new BookingError(404, "Student not found.");
  // Upcoming sessions' calendar events include the notes, so refresh them.
  const upcoming = await env.DB.prepare(
    "SELECT id FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND start_utc > ?2 AND group_id IS NULL LIMIT 20",
  ).bind(customerId, iso(now)).all<{ id: string }>();
  for (const { id } of upcoming.results) await refreshCalendarEvent(env, id);
  return { ok: true, notes };
}

/* ── Attendance ── */

export async function adminSetAttendance(env: Env, bookingId: string, noShow: boolean, now: number) {
  const res = await env.DB.prepare(
    "UPDATE bookings SET attendance = ?1 WHERE id = ?2 AND status = 'confirmed' AND start_utc <= ?3",
  ).bind(noShow ? "no_show" : null, bookingId, iso(now)).run();
  if (!res.meta.changes) throw new BookingError(409, "Only sessions that have started can be marked.");
  return { ok: true };
}

/* ── CSV export (for taxes and records) ── */

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything; neutralise spreadsheet formulas in typed-in text.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
const dollars = (c: number) => (c / 100).toFixed(2);

const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: RULES.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const timeOf = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: RULES.timeZone, hour: "numeric", minute: "2-digit" }).format(ms);

type Rec = Record<string, any>;

function exportCsv(sessions: Rec[], requests: Rec[], bundles: Rec[]): string {
  const rows: unknown[][] = [["Type", "Date", "Time (Eastern)", "Student", "Email", "What", "Status", "Booked by", "Price", "Paid", "Refunded", "Net", "Paid with", "Promo code", "Attendance"]];
  for (const b of sessions) {
    const start = Date.parse(b.start_utc);
    const paid = b.package_id ? 0 : b.amount_cents;
    const refunded = b.refunded_cents ?? 0;
    const method = b.package_id ? "Bundle credit" : paid > 0 ? "Card" : b.price_cents !== null && b.price_cents > 0 && !b.paid_at ? "Unpaid" : "Free";
    rows.push([
      b.group_id ? "Group session" : "Session", dayOf(start), timeOf(start), b.name, b.email, serviceLabel(findService(b.service_id)!),
      b.status === "confirmed" ? (start < Date.now() ? "Happened" : "Upcoming") : `Cancelled (${String(b.cancel_reason ?? "").replace(/_/g, " ")})`,
      b.created_by === "admin" ? "Avery" : b.created_by === "series" ? "Repeat (automatic)" : "Student", b.price_cents !== null && b.price_cents !== undefined ? dollars(b.price_cents) : dollars(paid),
      dollars(paid), dollars(refunded), dollars(paid - refunded), method, b.promo_code ?? "", b.attendance === "no_show" ? "No-show" : "",
    ]);
  }
  for (const r of requests) {
    const at = Date.parse(r.paid_at);
    rows.push([
      "Payment request", dayOf(at), timeOf(at), r.name, r.email, serviceLabel(findService(r.service_id)!), "Paid", "Avery",
      dollars(r.amount_cents), dollars(r.paid_cents ?? 0), "0.00", dollars(r.paid_cents ?? 0), "Card", "", "",
    ]);
  }
  for (const p of bundles) {
    const at = Date.parse(p.created_at);
    rows.push([
      "Bundle purchase", dayOf(at), timeOf(at), p.name, p.email, `${findService(p.service_id)?.credits ?? p.credits_total} session bundle`,
      p.status === "cancelled" ? "Cancelled" : "Active", "Student", dollars(findService(p.service_id)?.priceCents ?? p.amount_cents),
      dollars(p.amount_cents), dollars(p.refunded_cents ?? 0), dollars(p.amount_cents - (p.refunded_cents ?? 0)), "Card", p.promo_code ?? "", "",
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const SESSION_SQL = `SELECT b.*, ${CLIENT_COLUMNS("b")} FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.status IN ('confirmed', 'cancelled')`;
const BUNDLE_SQL = `SELECT p.*, ${CLIENT_COLUMNS("p")} FROM packages p JOIN customers c ON c.id = p.customer_id WHERE p.status IN ('active', 'cancelled') AND p.stripe_payment_intent_id IS NOT NULL`;
const REQUEST_SQL = `SELECT r.*, b.service_id, ${CLIENT_COLUMNS("b")} FROM payment_requests r JOIN bookings b ON b.id = r.booking_id JOIN customers c ON c.id = r.customer_id WHERE r.status = 'paid'`;

export async function adminExport(env: Env, fromRaw: unknown, toRaw: unknown) {
  const d = (v: unknown) => String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const f = d(fromRaw), t = d(toRaw);
  if (!f || !t) throw new BookingError(400, "Pick a start and end date.");
  const from = zonedToUtc(+f[1], +f[2], +f[3], 0, 0, RULES.timeZone);
  const to = zonedToUtc(+t[1], +t[2], +t[3], 0, 0, RULES.timeZone) + DAY;
  if (to <= from || to - from > 800 * DAY) throw new BookingError(400, "Pick a range of up to about two years.");
  const sessions = await env.DB.prepare(`${SESSION_SQL} AND b.start_utc >= ?1 AND b.start_utc < ?2 ORDER BY b.start_utc`).bind(iso(from), iso(to)).all<Rec>();
  const bundles = await env.DB.prepare(`${BUNDLE_SQL} AND p.created_at >= ?1 AND p.created_at < ?2 ORDER BY p.created_at`).bind(iso(from), iso(to)).all<Rec>();
  const requests = await env.DB.prepare(`${REQUEST_SQL} AND r.paid_at >= ?1 AND r.paid_at < ?2 ORDER BY r.paid_at`).bind(iso(from), iso(to)).all<Rec>();
  return exportCsv(sessions.results, requests.results, bundles.results);
}

// Everything on record for one student, all dates.
export async function adminExportStudent(env: Env, customerId: string) {
  const c = await env.DB.prepare("SELECT name FROM customers WHERE id = ?1").bind(customerId).first<{ name: string }>();
  if (!c) throw new BookingError(404, "Student not found.");
  const sessions = await env.DB.prepare(`${SESSION_SQL} AND b.customer_id = ?1 ORDER BY b.start_utc`).bind(customerId).all<Rec>();
  const bundles = await env.DB.prepare(`${BUNDLE_SQL} AND p.customer_id = ?1 ORDER BY p.created_at`).bind(customerId).all<Rec>();
  const requests = await env.DB.prepare(`${REQUEST_SQL} AND r.customer_id = ?1 ORDER BY r.paid_at`).bind(customerId).all<Rec>();
  return { name: c.name, csv: exportCsv(sessions.results, requests.results, bundles.results) };
}

/* ── Is iCloud reachable? ── */

// Every 5 minutes: can we read the calendars? If not for 15 minutes, email
// Avery (at most every 6 hours), and again once it's working.
export async function checkCalendarHealth(env: Env, now: number): Promise<string> {
  const h = await env.DB.prepare("SELECT * FROM health WHERE key = 'icloud'")
    .first<{ failing_since: string | null; alerted_at: string | null }>();
  try {
    await calendarFor(env, await scheduling(env)).getBusy(now, now + DAY);
    await env.DB.prepare(
      `INSERT INTO health (key, last_ok) VALUES ('icloud', ?1)
       ON CONFLICT(key) DO UPDATE SET last_ok = ?1, failing_since = NULL, last_error = NULL, alerted_at = NULL`,
    ).bind(iso(now)).run();
    if (h?.failing_since) await logEvent(env, "icloud", "ok", "Calendar connection is back");
    if (h?.alerted_at) await sendEmail(env, "icloud_recovered", null, { ...T.icloudStatus(true, ""), to: env.ADMIN_EMAIL });
    return "ok";
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    await env.DB.prepare(
      `INSERT INTO health (key, failing_since, last_error) VALUES ('icloud', ?1, ?2)
       ON CONFLICT(key) DO UPDATE SET failing_since = COALESCE(failing_since, ?1), last_error = ?2`,
    ).bind(iso(now), msg).run();
    if (!h?.failing_since) await logEvent(env, "icloud", "error", `Can't read the calendar: ${msg}`);
    const since = h?.failing_since ? Date.parse(h.failing_since) : now;
    const alertedRecently = h?.alerted_at && Date.parse(h.alerted_at) > now - 6 * 60 * MIN;
    if (since <= now - 15 * MIN && !alertedRecently) {
      if (await sendEmail(env, "icloud_down", null, { ...T.icloudStatus(false, msg), to: env.ADMIN_EMAIL })) {
        await env.DB.prepare("UPDATE health SET alerted_at = ?1 WHERE key = 'icloud'").bind(iso(now)).run();
      }
    }
    return "failing";
  }
}

export async function calendarHealth(env: Env) {
  const h = await env.DB.prepare("SELECT failing_since, last_error FROM health WHERE key = 'icloud'")
    .first<{ failing_since: string | null; last_error: string | null }>();
  return h?.failing_since ? { failingSince: h.failing_since, error: h.last_error } : null;
}

/* ── Backups ── */

// Not included: stored_secrets (the encrypted iCloud password stays out of every copy).
const BACKUP_TABLES = ["customers", "customer_aliases", "duplicate_ignores", "series", "bookings", "groups", "packages", "credit_ledger", "slot_claims", "refund_requests", "payment_requests", "settings", "alerts_sent"];

export async function backupJson(env: Env, now: number): Promise<string> {
  const out: Record<string, unknown> = { made: iso(now), tables: {} };
  for (const t of BACKUP_TABLES) {
    (out.tables as Record<string, unknown>)[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  }
  return JSON.stringify(out);
}

// Nightly: a compressed copy in the private backups bucket, keeping 30 days.
export async function nightlyBackup(env: Env, now: number, force = false): Promise<string | null> {
  if (!env.BACKUPS) return null;
  const h = await env.DB.prepare("SELECT last_ok FROM health WHERE key = 'backup'").first<{ last_ok: string | null }>();
  if (!force && h?.last_ok && Date.parse(h.last_ok) > now - 23 * 60 * MIN) return null;
  const body = new Blob([await backupJson(env, now)]).stream().pipeThrough(new CompressionStream("gzip"));
  const key = `backups/${iso(now).slice(0, 10)}.json.gz`;
  await env.BACKUPS.put(key, await new Response(body).arrayBuffer(), { httpMetadata: { contentType: "application/gzip" } });
  const listed = await env.BACKUPS.list({ prefix: "backups/" });
  const cutoff = `backups/${iso(now - 30 * DAY).slice(0, 10)}`;
  for (const o of listed.objects) if (o.key < cutoff) await env.BACKUPS.delete(o.key);
  await env.DB.prepare(
    "INSERT INTO health (key, last_ok) VALUES ('backup', ?1) ON CONFLICT(key) DO UPDATE SET last_ok = ?1",
  ).bind(iso(now)).run();
  await logEvent(env, "backups", "ok", `Saved tonight's backup (${key.replace("backups/", "")})`);
  return key;
}

export async function lastBackup(env: Env) {
  return (await env.DB.prepare("SELECT last_ok FROM health WHERE key = 'backup'").first<{ last_ok: string | null }>())?.last_ok ?? null;
}

/* ── Clearing test data (before going live) ── */

// Only while the Stripe key is a test key. Removes every test session's
// calendar event and Zoom meeting, then empties everything except Settings.
export async function clearTestData(env: Env, confirm: unknown) {
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "")) throw new BookingError(403, "This only works in test mode.");
  if (confirm !== "CLEAR") throw new BookingError(400, 'Type CLEAR to confirm.');
  const { deleteMeeting } = await import("./zoom");
  const cal = calendarFor(env);
  const leftovers = [
    ...(await env.DB.prepare("SELECT calendar_event_url AS cal, zoom_meeting_id AS zoom FROM bookings WHERE calendar_event_url IS NOT NULL OR zoom_meeting_id IS NOT NULL").all<{ cal: string | null; zoom: string | null }>()).results,
    ...(await env.DB.prepare("SELECT calendar_event_url AS cal, zoom_meeting_id AS zoom FROM groups WHERE calendar_event_url IS NOT NULL OR zoom_meeting_id IS NOT NULL").all<{ cal: string | null; zoom: string | null }>()).results,
  ];
  let problems = 0;
  for (const l of leftovers) {
    if (l.cal) await cal.deleteEvent(l.cal).catch(() => { problems++; });
    if (l.zoom) await deleteMeeting(env, l.zoom).catch(() => { problems++; });
  }
  const tables = ["slot_claims", "credit_ledger", "refund_requests", "payment_requests", "bookings", "groups", "series", "packages", "customer_aliases", "duplicate_ignores", "customers", "email_log", "processed_webhooks", "alerts_sent"];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  return {
    ok: true,
    message: problems
      ? `Test data cleared. ${problems} calendar event or Zoom meeting${problems === 1 ? "" : "s"} couldn't be removed; delete ${problems === 1 ? "it" : "them"} by hand.`
      : "Test data cleared, including test calendar events and Zoom meetings.",
  };
}
