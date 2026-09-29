// Repeating sessions: every 1 to 4 weeks, until stopped or for a set number
// of sessions. Single sessions only (not intro chats, bundles, or groups).
//
// The first session is booked the normal way. Once a session has ended, the
// next one is booked automatically at the same weekday and time (Avery's
// time zone), with an invite and a link to pay. Two unpaid sessions in a row
// stop the series. Either person can stop it at any time; sessions already
// booked stay booked.
//
// Reserved: an active series' future times are blocked for everyone else
// booking on the site (Avery is warned, and can book over one if she chooses).
// If a future week clashes with Avery's own calendar or a day off, that
// session is booked but held: the student isn't told until Avery keeps it or
// moves it. If she hasn't decided 2 days before, it goes ahead as usual.
// Only if the time was taken outright (Avery booked over it) is the week skipped.

import type { Env } from "./env";
import { findService, type Service } from "./services";
import { RULES } from "./settings";
import { blocksFor } from "./availability";
import { iso, zonedDate, zonedToUtc } from "./time";
import { sendEmail } from "./email";
import * as T from "./templates";
import { scheduling } from "./config";
import { validManageToken } from "./manage";
import { calendarFor } from "./calendar";
import { BookingError, UNIQUE_CLAIM, afterConfirm, claimedBlocks, loadBooking, serviceLabel } from "./bookings";

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const AVERY_TZ = RULES.timeZone;

export type Repeat = { everyWeeks: number; total: number | null };
export type SeriesRow = {
  id: string; customer_id: string; service_id: string; started_by: "admin" | "client"; every_weeks: number;
  sessions_left: number | null; last_start: string; price_cents: number; pay_by_rule: string; status: string;
  stopped_reason: string | null; misses: number; client_name: string | null; client_pronouns: string | null;
  client_time_zone: string | null; message: string | null; created_at: string;
};

// { everyWeeks: 1-4, total: null (until stopped) or 2-52 sessions including the first }
export function parseRepeat(raw: unknown, service: Service): Repeat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const every = Number(r.everyWeeks);
  if (!every) return null;
  if (service.kind !== "single") throw new BookingError(400, "Only regular sessions can repeat (not intro chats or bundles).");
  if (![1, 2, 3, 4].includes(every)) throw new BookingError(400, "Sessions can repeat every 1, 2, 3, or 4 weeks.");
  const total = r.total === null || r.total === undefined || r.total === "" ? null : Number(r.total);
  if (total !== null && (!Number.isInteger(total) || total < 2 || total > 52)) throw new BookingError(400, "Pick between 2 and 52 sessions.");
  return { everyWeeks: every, total };
}

export const repeatText = (every: number) => (every === 1 ? "every week" : `every ${every} weeks`);

type SeriesInput = {
  customerId: string; serviceId: string; startedBy: "admin" | "client"; repeat: Repeat; firstStart: number;
  priceCents: number; payByRule: string; name: string; pronouns: string | null; timeZone: string; message: string | null;
  active: boolean;
};

export async function createSeries(env: Env, p: SeriesInput): Promise<string> {
  const { id, statement } = seriesStatement(env, p);
  await statement.run();
  return id;
}

// The insert on its own, to run in the same batch as the first booking.
export function seriesStatement(env: Env, p: SeriesInput): { id: string; statement: D1PreparedStatement } {
  const id = crypto.randomUUID();
  const statement = env.DB.prepare(
    `INSERT INTO series (id, customer_id, service_id, started_by, every_weeks, sessions_left, last_start, price_cents, pay_by_rule, status,
       client_name, client_pronouns, client_time_zone, message)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  ).bind(id, p.customerId, p.serviceId, p.startedBy, p.repeat.everyWeeks, p.repeat.total === null ? null : p.repeat.total - 1,
    iso(p.firstStart), p.priceCents, p.payByRule, p.active ? "active" : "pending", p.name, p.pronouns, p.timeZone, p.message);
  return { id, statement };
}

// A student's series starts once their first session is paid for.
export async function activateSeries(env: Env, seriesId: string) {
  await env.DB.prepare("UPDATE series SET status = 'active', updated_at = ?1 WHERE id = ?2 AND status = 'pending'").bind(iso(Date.now()), seriesId).run();
}

// The same weekday and wall-clock time, n weeks later (daylight saving safe).
export function sameTimeWeeksLater(ms: number, weeks: number): number {
  const [y, m, d] = zonedDate(ms, AVERY_TZ);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: AVERY_TZ, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(ms).split(":").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + weeks * 7));
  return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hm[0], hm[1], AVERY_TZ);
}

async function isDayOff(env: Env, start: number): Promise<boolean> {
  const [y, m, d] = zonedDate(start, AVERY_TZ);
  return !(await scheduling(env)).workDays.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}

/* ── Reserved times ── */

// The 15-minute blocks held by active series between two times: every future
// occurrence after the latest one booked (up to the set number of sessions).
// `ignoreSeriesId` leaves one series out (used when booking its own next session).
export async function reservedBlocks(env: Env, from: number, to: number, ignoreSeriesId = ""): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(
    "SELECT id, service_id, started_by, every_weeks, sessions_left, last_start, client_name FROM series WHERE status = 'active' AND id <> ?1",
  ).bind(ignoreSeriesId).all<Pick<SeriesRow, "id" | "service_id" | "started_by" | "every_weeks" | "sessions_left" | "last_start" | "client_name">>();
  const out = new Map<string, string>(); // block -> whose series
  if (!rows.results.length) return out;
  const cfg = await scheduling(env);
  for (const s of rows.results) {
    const service = findService(s.service_id);
    if (!service) continue;
    const buffer = s.started_by === "client" ? cfg.bufferMinutes : 0;
    let t = sameTimeWeeksLater(Date.parse(s.last_start), s.every_weeks);
    for (let n = 0; n < 120 && t < to && (s.sessions_left === null || n < s.sessions_left); n++) {
      if (t + (service.durationMinutes + buffer) * MIN > from) {
        for (const blk of blocksFor(t, service.durationMinutes, buffer)) out.set(blk, s.client_name ?? "a student");
      }
      t = sameTimeWeeksLater(t, s.every_weeks);
    }
  }
  return out;
}

// Payment deadline for a session booked automatically: the series' rule, but
// never less than 12 hours to pay. Too close for that: just "before the session".
export function seriesPayBy(rule: string, start: number, now: number): number | null {
  const at = rule === "before24" ? start - DAY
    : rule === "after24" ? Math.min(start, now + DAY)
    : rule === "after48" ? Math.min(start, now + 2 * DAY)
    : null;
  if (at === null) return null;
  const floor = now + 12 * 60 * MIN;
  if (at >= floor) return at;
  return floor < start ? floor : null;
}

/* ── Cron: book the next session in each series ── */

export async function bookNextSessions(env: Env, now: number): Promise<number> {
  const due = await env.DB.prepare("SELECT * FROM series WHERE status = 'active' AND last_start < ?1 LIMIT 20").bind(iso(now)).all<SeriesRow>();
  let booked = 0;
  for (const s of due.results) {
    try {
      const service = findService(s.service_id)!;
      const last = Date.parse(s.last_start);
      if (now < last + service.durationMinutes * MIN) continue; // the previous one hasn't ended yet
      if (s.sessions_left !== null && s.sessions_left <= 0) {
        await env.DB.prepare("UPDATE series SET status = 'ended', updated_at = ?1 WHERE id = ?2").bind(iso(now), s.id).run();
        continue;
      }
      let next = sameTimeWeeksLater(last, s.every_weeks);
      // After an outage, catch up to the next time that's still ahead.
      while (next < now + 2 * 60 * MIN) next = sameTimeWeeksLater(next, s.every_weeks);
      // Claim this step first, so two cron runs can't book the same session twice.
      const claim = await env.DB.prepare(
        `UPDATE series SET last_start = ?1, sessions_left = CASE WHEN sessions_left IS NULL THEN NULL ELSE sessions_left - 1 END, updated_at = ?2
         WHERE id = ?3 AND last_start = ?4 AND status = 'active'`,
      ).bind(iso(next), iso(now), s.id, s.last_start).run();
      if (!claim.meta.changes) continue;
      let result: Outcome;
      try {
        result = await bookOne(env, s, service, next, now);
      } catch (err) {
        // Nothing was booked: undo the claim so the next run tries this week again.
        const made = await env.DB.prepare("SELECT 1 AS x FROM bookings WHERE series_id = ?1 AND start_utc = ?2").bind(s.id, iso(next)).first();
        if (!made) {
          await env.DB.prepare(
            `UPDATE series SET last_start = ?1, sessions_left = CASE WHEN sessions_left IS NULL THEN NULL ELSE sessions_left + 1 END
             WHERE id = ?2 AND last_start = ?3`,
          ).bind(s.last_start, s.id, iso(next)).run();
        }
        throw err;
      }
      if (result === "booked" || result === "held") booked++;
      else {
        // A skipped week doesn't count toward a set number of sessions.
        await env.DB.prepare("UPDATE series SET sessions_left = sessions_left + 1 WHERE id = ?1 AND sessions_left IS NOT NULL").bind(s.id).run();
        await skipped(env, s, next, result);
      }
      const after = await env.DB.prepare("SELECT sessions_left FROM series WHERE id = ?1").bind(s.id).first<{ sessions_left: number | null }>();
      if (after?.sessions_left === 0) await env.DB.prepare("UPDATE series SET status = 'ended' WHERE id = ?1 AND status = 'active'").bind(s.id).run();
    } catch (err) {
      console.error("series:", (err as Error).message);
    }
  }
  return booked;
}

type Outcome = "booked" | "held" | "taken";
type Clash = "calendar" | "day_off";

async function bookOne(env: Env, s: SeriesRow, service: Service, start: number, now: number): Promise<Outcome> {
  const end = start + service.durationMinutes * MIN;
  // Taken outright by another booking (only possible if Avery booked over the reservation).
  const blocks = blocksFor(start, service.durationMinutes, 0);
  const taken = await claimedBlocks(env, start - 60 * MIN, end + 60 * MIN, now, "", s.id);
  if (blocks.some((b) => taken.has(b))) return "taken";
  // A clash with Avery's own calendar or a day off: book it, but hold it for her.
  let clash: Clash | null = (await isDayOff(env, start)) ? "day_off" : null;
  const cfg = await scheduling(env);
  const buffer = s.started_by === "client" ? cfg.bufferMinutes : 0;
  if (!clash) {
    try {
      const busy = await calendarFor(env, cfg).getBusy(start - buffer * MIN, end + buffer * MIN);
      if (busy.some((e) => e.start < end + buffer * MIN && e.end > start - buffer * MIN)) clash = "calendar";
    } catch { /* calendar unreachable: book as usual (Avery is alerted about iCloud separately) */ }
  }
  const id = crypto.randomUUID();
  const payBy = s.price_cents > 0 ? seriesPayBy(s.pay_by_rule, start, now) : null;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bookings (id, customer_id, service_id, start_utc, end_utc, status, amount_cents, price_cents, pay_by, created_by,
           series_id, ics_uid, client_time_zone, confirmed_at, client_name, client_pronouns, invite_message, admin_email_sent_at,
           series_conflict, series_conflict_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'confirmed', 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      ).bind(id, s.customer_id, s.service_id, iso(start), iso(end), s.price_cents, payBy ? iso(payBy) : null,
        "series", s.id, `${id}@averywhitted.com`, s.client_time_zone || AVERY_TZ, iso(now),
        s.client_name, s.client_pronouns, s.message, iso(now), clash, clash ? iso(now) : null),
      ...blocksFor(start, service.durationMinutes, buffer).map((blk) =>
        env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, id)),
    ]);
  } catch (err) {
    if (UNIQUE_CLAIM.test((err as Error).message)) return "taken";
    throw err;
  }
  if (clash) {
    await tellAveryAboutClash(env, id, clash, false);
    return "held";
  }
  await afterConfirm(env, id);
  return "booked";
}

async function tellAveryAboutClash(env: Env, bookingId: string, clash: Clash, wentAhead: boolean) {
  const row = await loadBooking(env, "id", bookingId);
  if (!row) return;
  await sendEmail(env, wentAhead ? "admin_series_clash_sent" : "admin_series_clash", row.id, {
    ...T.adminSeriesClash({ name: row.name, serviceName: serviceLabel(findService(row.service_id)!), when: Date.parse(row.start_utc), clash, wentAhead }),
    to: env.ADMIN_EMAIL,
  });
}

/* ── Held sessions: Avery keeps or moves them ── */

// Sends the held session to the student as a normal invite (after Avery
// keeps it, moves it, or 2 days before if she hasn't decided).
export async function releaseHeld(env: Env, bookingId: string, now: number): Promise<boolean> {
  const row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "confirmed" || !row.series_conflict) return false;
  const s = row.series_id ? await env.DB.prepare("SELECT pay_by_rule FROM series WHERE id = ?1").bind(row.series_id).first<{ pay_by_rule: string }>() : null;
  const start = Date.parse(row.start_utc);
  const payBy = (row.price_cents ?? 0) > 0 && !row.paid_at ? seriesPayBy(s?.pay_by_rule ?? "none", start, now) : null;
  const res = await env.DB.prepare(
    "UPDATE bookings SET series_conflict = NULL, pay_by = ?1, confirmed_at = ?2, updated_at = ?2 WHERE id = ?3 AND series_conflict IS NOT NULL AND status = 'confirmed'",
  ).bind(payBy ? iso(payBy) : null, iso(now), row.id).run();
  if (!res.meta.changes) return false;
  await afterConfirm(env, row.id);
  return true;
}

export async function adminKeepHeld(env: Env, bookingId: string, now: number) {
  if (!(await releaseHeld(env, bookingId, now))) throw new BookingError(409, "This session isn't waiting for you anymore.");
  return { ok: true };
}

// Cron: anything still held 2 days before goes ahead at the usual time.
export async function releaseUndecided(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id, series_conflict FROM bookings WHERE status = 'confirmed' AND series_conflict IS NOT NULL AND start_utc <= ?1 AND start_utc > ?2 LIMIT 20",
  ).bind(iso(now + 2 * DAY), iso(now)).all<{ id: string; series_conflict: Clash }>();
  let n = 0;
  for (const r of rows.results) {
    if (await releaseHeld(env, r.id, now)) {
      await tellAveryAboutClash(env, r.id, r.series_conflict, true);
      n++;
    }
  }
  return n;
}

async function skipped(env: Env, s: SeriesRow, when: number, why: "taken") {
  const service = findService(s.service_id)!;
  const c = await env.DB.prepare("SELECT email FROM customers WHERE id = ?1").bind(s.customer_id).first<{ email: string }>();
  if (!c) return;
  const next = sameTimeWeeksLater(when, s.every_weeks);
  const info = {
    name: s.client_name ?? "", email: c.email, timeZone: s.client_time_zone || AVERY_TZ, serviceName: serviceLabel(service),
    when, next, reason: why, everyWeeks: s.every_weeks, bookUrl: `${env.SITE_URL}/book/?service=${s.service_id}`,
    continues: true, // skipped weeks don't use up a session, so there's always a next one
  };
  await sendEmail(env, "series_skipped", null, T.seriesSkipped(info));
  await sendEmail(env, "admin_series_skipped", null, { ...T.adminSeriesSkipped(info), to: env.ADMIN_EMAIL });
}

/* ── Stopping ── */

export async function stopSeries(env: Env, id: string, by: "client" | "admin" | "unpaid", now: number, notify = true) {
  const res = await env.DB.prepare(
    "UPDATE series SET status = 'stopped', stopped_reason = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('pending', 'active')",
  ).bind(by, iso(now), id).run();
  if (!res.meta.changes) throw new BookingError(409, "These sessions aren't repeating anymore.");
  if (!notify) return { ok: true };
  const s = (await env.DB.prepare("SELECT * FROM series WHERE id = ?1").bind(id).first<SeriesRow>())!;
  const c = await env.DB.prepare("SELECT email FROM customers WHERE id = ?1").bind(s.customer_id).first<{ email: string }>();
  const info = { name: s.client_name ?? "", email: c?.email ?? "", everyWeeks: s.every_weeks, by, bookUrl: `${env.SITE_URL}/book/?service=${s.service_id}` };
  if (c) await sendEmail(env, "series_stopped", null, T.seriesStopped(info));
  if (by !== "admin") await sendEmail(env, "admin_series_stopped", null, { ...T.adminSeriesStopped(info), to: env.ADMIN_EMAIL });
  return { ok: true };
}

// From the student's manage page (any session in the series).
export async function studentStopSeries(env: Env, bookingId: unknown, token: unknown, now: number) {
  if (!(await validManageToken(env, bookingId, token))) throw new BookingError(404, "We couldn't find that booking. Please use the link in your email.");
  const row = await loadBooking(env, "id", bookingId as string);
  if (!row?.series_id) throw new BookingError(409, "This session doesn't repeat.");
  return stopSeries(env, row.series_id, "client", now);
}

// A series session was released unpaid: two in a row stops the series.
export async function seriesMissedPayment(env: Env, seriesId: string, now: number) {
  await env.DB.prepare("UPDATE series SET misses = misses + 1 WHERE id = ?1").bind(seriesId).run();
  const s = await env.DB.prepare("SELECT misses, status FROM series WHERE id = ?1").bind(seriesId).first<{ misses: number; status: string }>();
  if (s && s.misses >= 2 && s.status === "active") await stopSeries(env, seriesId, "unpaid", now);
}
export async function seriesPaid(env: Env, seriesId: string) {
  await env.DB.prepare("UPDATE series SET misses = 0 WHERE id = ?1").bind(seriesId).run();
}

// A student's first session never got paid (the hold ran out): drop the series.
export async function dropAbandonedSeries(env: Env, now: number) {
  await env.DB.prepare(
    `UPDATE series SET status = 'stopped', stopped_reason = 'first_unpaid', updated_at = ?1
     WHERE status = 'pending' AND created_at < ?2
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.series_id = series.id AND b.status IN ('held', 'confirmed'))`,
  ).bind(iso(now), iso(now - DAY)).run();
}

// What the manage page and admin show about a series.
export async function seriesSummary(env: Env, seriesId: string | null) {
  if (!seriesId) return null;
  const s = await env.DB.prepare("SELECT * FROM series WHERE id = ?1").bind(seriesId).first<SeriesRow>();
  if (!s) return null;
  return { id: s.id, everyWeeks: s.every_weeks, status: s.status, sessionsLeft: s.sessions_left, startedBy: s.started_by, priceCents: s.price_cents };
}

