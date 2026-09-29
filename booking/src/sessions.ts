// Sessions Avery books for students from the admin page, and students paying
// for them from the link in their invite.
//
//   One student   a normal booking (created_by 'admin') at Avery's price. The
//                 student can reschedule or cancel it like any other booking.
//   2+ students   a group session: one row in `groups` holds the time, the
//                 Zoom meeting, and the calendar event; each student has their
//                 own booking row (group_id set) with their own price, invite,
//                 and payment link. Students can cancel their own spot; only
//                 Avery can move the session.
//
// Payment: the invite links to the manage page, which starts a Stripe
// checkout for what's owed. With a pay-by deadline, anyone still unpaid when
// it passes is released automatically (cron). Students can instead use a
// credit from a bundle they already bought.

import type { Env } from "./env";
import { findService, type Service } from "./services";
import { RULES } from "./settings";
import { blocksFor } from "./availability";
import { iso, zonedDate, zonedToUtc } from "./time";
import * as stripe from "./stripe";
import { sendEmail } from "./email";
import * as T from "./templates";
import { calendarFor } from "./calendar";
import { scheduling } from "./config";
import { createMeeting, deleteMeeting, updateMeeting } from "./zoom";
import { buildIcs } from "./ics";
import { manageUrl, validManageToken } from "./manage";
import {
  BookingError, CLIENT_COLUMNS, UNIQUE_CLAIM, afterConfirm, afterReschedule, clean, clientIcs, dueCents, issueRefund,
  loadBooking, payUrl, refreshCalendarEvent, removeCancelled, serviceLabel, view, type BookingRow,
} from "./bookings";

const AVERY_TZ = RULES.timeZone;
const MIN = 60000;
const DAY = 24 * 60 * MIN;

export type PayByChoice = "none" | "after24" | "after48" | "before24";

type Student = { name: string; email: string; pronouns: string; priceCents: number; packageId: string | null };

/* ── Reading what Avery submitted ── */

function parseWhen(b: Record<string, unknown>, now: number): { service: Service; start: number; end: number } {
  const service = findService(String(b.serviceId ?? ""));
  if (!service || service.kind === "bundle") throw new BookingError(400, "Pick a session length.");
  const dm = String(b.date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(b.time ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!dm || !tm || +tm[2] % 15) throw new BookingError(400, "Pick a date and a start time.");
  const start = zonedToUtc(+dm[1], +dm[2], +dm[3], +tm[1], +tm[2], AVERY_TZ);
  if (start < now + 5 * MIN) throw new BookingError(400, "That time has already passed.");
  if (start > now + 366 * DAY) throw new BookingError(400, "Pick a time within the next year.");
  return { service, start, end: start + service.durationMinutes * MIN };
}

function parseStudents(b: Record<string, unknown>, service: Service): Student[] {
  const raw = Array.isArray(b.students) ? b.students : [];
  if (!raw.length) throw new BookingError(400, "Add at least one student.");
  if (raw.length > RULES.maxGroupSize) throw new BookingError(400, `A session can have up to ${RULES.maxGroupSize} students.`);
  const students = raw.map((r) => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const name = clean(x.name, 120);
    const email = clean(x.email, 200).toLowerCase();
    if (!name) throw new BookingError(400, "Every student needs a name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BookingError(400, `Please check the email address for ${name}.`);
    const packageId = typeof x.packageId === "string" && x.packageId ? x.packageId : null;
    let priceCents = service.priceCents;
    if (x.priceCents !== undefined && x.priceCents !== null && x.priceCents !== "") {
      priceCents = Number(x.priceCents);
      if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 500000) throw new BookingError(400, `The price for ${name} doesn't look right.`);
    }
    return { name, email, pronouns: clean(x.pronouns, 40), priceCents: packageId ? 0 : priceCents, packageId };
  });
  if (new Set(students.map((s) => s.email)).size !== students.length) throw new BookingError(400, "The same student is listed twice.");
  return students;
}

function parsePayBy(b: Record<string, unknown>, start: number, now: number, anyoneOwes: boolean): number | null {
  const choice = String(b.payBy ?? "none") as PayByChoice;
  if (!["none", "after24", "after48", "before24"].includes(choice)) throw new BookingError(400, "Pick a payment deadline.");
  if (choice === "none" || !anyoneOwes) return null;
  const at = Math.min(start, choice === "after24" ? now + DAY : choice === "after48" ? now + 2 * DAY : start - DAY);
  if (at < now + 60 * MIN) {
    throw new BookingError(400, "That payment deadline would pass within the hour. Pick a later one, or no deadline.");
  }
  return at;
}

// A bundle credit can only be used by its owner, for a 1-hour session, before the use-by date.
async function checkBundles(env: Env, students: Student[], service: Service, start: number, now: number) {
  for (const s of students.filter((x) => x.packageId)) {
    const p = await env.DB.prepare(
      `SELECT p.status, p.credits_total, p.credits_used, p.expires_at, c.email FROM packages p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?1`,
    ).bind(s.packageId).first<{ status: string; credits_total: number; credits_used: number; expires_at: string | null; email: string }>();
    if (!p || p.status !== "active" || p.email.toLowerCase() !== s.email) throw new BookingError(400, `That bundle doesn't belong to ${s.name}.`);
    if (service.id !== RULES.packageSessionService) throw new BookingError(400, "Bundle credits are for 1 hour sessions.");
    if (p.credits_used >= p.credits_total) throw new BookingError(409, `${s.name}'s bundle has no sessions left.`);
    const expires = p.expires_at ? Date.parse(p.expires_at) : 0;
    if (expires <= now || start >= expires) throw new BookingError(409, `This session is after ${s.name}'s bundle use-by date.`);
  }
}

async function upsertCustomer(env: Env, s: Student): Promise<string> {
  const row = await env.DB.prepare(
    `INSERT INTO customers (id, name, email, pronouns) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, pronouns = COALESCE(excluded.pronouns, customers.pronouns)
     RETURNING id`,
  ).bind(crypto.randomUUID(), s.name, s.email, s.pronouns || null).first<{ id: string }>();
  return row!.id;
}

function mapWriteError(err: unknown): never {
  const msg = (err as Error).message;
  if (UNIQUE_CLAIM.test(msg)) throw new BookingError(409, "That time overlaps another booking.");
  if (/CHECK constraint failed/i.test(msg)) throw new BookingError(409, "A bundle in this booking has no sessions left.");
  throw err;
}

// Days switched off in Settings can't be booked, even from the admin page.
async function isDayOff(env: Env, start: number): Promise<boolean> {
  const [y, m, d] = zonedDate(start, AVERY_TZ);
  return !(await scheduling(env)).workDays.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}
const DAY_OFF = "That's one of your days off (Settings, Working days). Turn the day back on there to book it.";

/* ── Checking a time before booking it ── */

export async function adminCheckTime(env: Env, body: unknown, now: number) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const { service, start, end } = parseWhen(b, now);
  const cfg = await scheduling(env);
  const buffer = cfg.bufferMinutes * MIN;
  const ignoreBookingId = typeof b.movingBookingId === "string" ? b.movingBookingId : "";
  const ignoreGroupId = typeof b.movingGroupId === "string" ? b.movingGroupId : "";
  const ignoreUid = ignoreBookingId
    ? (await env.DB.prepare("SELECT ics_uid FROM bookings WHERE id = ?1").bind(ignoreBookingId).first<{ ics_uid: string }>())?.ics_uid
    : ignoreGroupId ? (await env.DB.prepare("SELECT ics_uid FROM groups WHERE id = ?1").bind(ignoreGroupId).first<{ ics_uid: string }>())?.ics_uid : undefined;
  let calendarClash: { start: string; end: string }[] | null = null;
  try {
    calendarClash = (await calendarFor(env, cfg).getBusy(start - buffer, end + buffer))
      .filter((e) => e.start < end + buffer && e.end > start - buffer && e.uid !== ignoreUid)
      .map((e) => ({ start: iso(e.start), end: iso(e.end) }));
  } catch { /* calendar unreachable: no warning either way */ }
  // Times kept for someone's repeating sessions (Avery can still book over them).
  const reserved = await (await import("./series")).reservedBlocks(env, start, end);
  const reservedFor = [...new Set(blocksFor(start, service.durationMinutes, 0).map((blk) => reserved.get(blk)).filter(Boolean))] as string[];
  const taken = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM slot_claims sc LEFT JOIN bookings b ON b.id = sc.booking_id LEFT JOIN groups g ON g.id = sc.group_id
     WHERE sc.slot_start IN (${blocksFor(start, service.durationMinutes, 0).map((x) => `'${x}'`).join(",")})
       AND (?1 = '' OR sc.booking_id IS NULL OR sc.booking_id <> ?1) AND (?2 = '' OR sc.group_id IS NULL OR sc.group_id <> ?2)
       AND (b.status = 'confirmed' OR (b.status = 'held' AND b.hold_expires_at > ?3) OR g.status = 'active')`,
  ).bind(ignoreBookingId, ignoreGroupId, iso(now)).first<{ n: number }>();
  const [h, mi] = String(b.time).split(":").map(Number);
  const endMinutes = h * 60 + mi + service.durationMinutes;
  return {
    start: iso(start),
    end: iso(end),
    overlapsBooking: (taken?.n ?? 0) > 0,
    reservedFor,
    calendarClash,
    outsideHours: h < cfg.dayStartHour || endMinutes > cfg.dayEndHour * 60,
    dayOff: await isDayOff(env, start),
    withinNotice: start - now < cfg.minNoticeHours * 60 * MIN,
  };
}

/* ── Booking students ── */

export async function adminCreateSession(env: Env, body: unknown, ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const now = ctx.now;
  const { service, start, end } = parseWhen(b, now);
  if (await isDayOff(env, start)) throw new BookingError(400, DAY_OFF);
  const students = parseStudents(b, service);
  const anyoneOwes = students.some((s) => !s.packageId && s.priceCents > 0);
  const payBy = parsePayBy(b, start, now, anyoneOwes);
  const message = clean(b.message, 1000, true) || null;
  await checkBundles(env, students, service, start, now);
  const { parseRepeat, seriesStatement } = await import("./series");
  const repeat = parseRepeat(b.repeat, service);
  if (repeat && students.length > 1) throw new BookingError(400, "Repeating is for one student at a time.");
  if (repeat && students[0].packageId) throw new BookingError(400, "Repeating sessions are paid each time, so they can't use a bundle credit.");

  const customerIds: string[] = [];
  for (const s of students) customerIds.push(await upsertCustomer(env, s));

  const seat = (s: Student, customerId: string, id: string, groupId: string | null) => env.DB.prepare(
    `INSERT INTO bookings (id, customer_id, service_id, start_utc, end_utc, status, amount_cents, price_cents, pay_by, created_by,
       package_id, group_id, ics_uid, client_time_zone, confirmed_at, client_name, client_pronouns, invite_message, admin_email_sent_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'confirmed', 0, ?6, ?7, 'admin', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?12)`,
  ).bind(id, customerId, service.id, iso(start), iso(end), s.priceCents, !s.packageId && s.priceCents > 0 && payBy ? iso(payBy) : null,
    s.packageId, groupId, `${id}@averywhitted.com`, AVERY_TZ, iso(now), s.name, s.pronouns || null, message);
  const useCredit = (s: Student, id: string) => s.packageId ? [
    env.DB.prepare("INSERT INTO credit_ledger (package_id, booking_id, delta, reason) VALUES (?1, ?2, -1, 'booked')").bind(s.packageId, id),
    env.DB.prepare("UPDATE packages SET credits_used = credits_used + 1, updated_at = ?1 WHERE id = ?2 AND status = 'active'").bind(iso(now), s.packageId),
  ] : [];
  // Sessions Avery books claim just their own time (no buffer), so she can
  // put them back to back; they still can't overlap another booking.
  const blocks = blocksFor(start, service.durationMinutes, 0);

  if (students.length === 1) {
    const id = crypto.randomUUID();
    // The repeat schedule is saved together with the booking, so if the time
    // turns out to be taken, neither is kept.
    const series = repeat ? seriesStatement(env, {
      customerId: customerIds[0], serviceId: service.id, startedBy: "admin", repeat, firstStart: start, priceCents: students[0].priceCents,
      payByRule: String(b.payBy ?? "none"), name: students[0].name, pronouns: students[0].pronouns || null, timeZone: AVERY_TZ, message, active: true,
    }) : null;
    try {
      await env.DB.batch([
        ...(series ? [series.statement] : []),
        seat(students[0], customerIds[0], id, null),
        ...(series ? [env.DB.prepare("UPDATE bookings SET series_id = ?1 WHERE id = ?2").bind(series.id, id)] : []),
        ...blocks.map((blk) => env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, id)),
        ...useCredit(students[0], id),
      ]);
    } catch (err) { mapWriteError(err); }
    ctx.waitUntil(afterConfirm(env, id));
    return { ok: true, bookingId: id };
  }

  const groupId = crypto.randomUUID();
  const ids = students.map(() => crypto.randomUUID());
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO groups (id, service_id, start_utc, end_utc, status, ics_uid) VALUES (?1, ?2, ?3, ?4, 'active', ?5)",
      ).bind(groupId, service.id, iso(start), iso(end), `${groupId}@averywhitted.com`),
      ...blocks.map((blk) => env.DB.prepare("INSERT INTO slot_claims (slot_start, group_id) VALUES (?1, ?2)").bind(blk, groupId)),
      ...students.flatMap((s, i) => [seat(s, customerIds[i], ids[i], groupId), ...useCredit(s, ids[i])]),
    ]);
  } catch (err) { mapWriteError(err); }
  ctx.waitUntil((async () => {
    await setUpGroup(env, groupId);
    for (const id of ids) await afterConfirm(env, id);
  })());
  return { ok: true, groupId, bookingIds: ids };
}

/* ── Group sessions: Zoom, calendar, keeping them in step ── */

type GroupRow = {
  id: string; service_id: string; start_utc: string; end_utc: string; status: string; ics_uid: string; ics_sequence: number;
  calendar_event_url: string | null; zoom_meeting_id: string | null; zoom_join_url: string | null; previous_start_utc: string | null;
  updated_at: string;
};

const loadGroup = (env: Env, id: string) => env.DB.prepare("SELECT * FROM groups WHERE id = ?1").bind(id).first<GroupRow>();

async function groupSeats(env: Env, groupId: string): Promise<BookingRow[]> {
  const rows = await env.DB.prepare(
    `SELECT b.*, ${CLIENT_COLUMNS("b")} FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.group_id = ?1 AND b.status = 'confirmed' ORDER BY b.rowid`,
  ).bind(groupId).all<BookingRow>();
  return rows.results;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

// The group's event on Avery's calendar: everyone's name and whether they've paid.
function groupEventIcs(g: GroupRow, seats: BookingRow[]): string {
  const service = findService(g.service_id)!;
  const lines = seats.map((s) => {
    const due = dueCents(s);
    const pay = s.package_id ? "bundle credit" : s.paid_at ? `paid ${money(s.amount_cents)}` : due ? `${money(due)} due` : "free";
    return `${s.name}${s.pronouns ? ` (${s.pronouns})` : ""}, ${s.email}: ${pay}`;
  });
  return buildIcs({
    uid: g.ics_uid, sequence: g.ics_sequence, start: Date.parse(g.start_utc), end: Date.parse(g.end_utc),
    summary: `Group coaching: ${seats.map((s) => s.name.split(/\s+/)[0]).join(", ")} (${serviceLabel(service).replace(/ session$/, "")})`,
    description: [...(g.zoom_join_url ? [`Zoom: ${g.zoom_join_url}`, ""] : []), ...lines].join("\n"),
    location: g.zoom_join_url ?? "Zoom",
  });
}

// Creates the group's Zoom meeting and calendar event if they're missing,
// and gives every student the Zoom link. Safe to run again.
export async function setUpGroup(env: Env, groupId: string): Promise<void> {
  let g = await loadGroup(env, groupId);
  if (!g || g.status !== "active") return;
  const seats = await groupSeats(env, groupId);
  if (!g.zoom_join_url) {
    const service = findService(g.service_id)!;
    const meeting = await createMeeting(env, {
      topic: `Group coaching: ${seats.map((s) => s.name.split(/\s+/)[0]).join(", ")} + Avery Whitted`,
      start: Date.parse(g.start_utc), durationMinutes: service.durationMinutes,
    });
    const url = meeting?.joinUrl ?? env.ZOOM_FALLBACK_URL ?? null;
    if (url) {
      await env.DB.prepare("UPDATE groups SET zoom_meeting_id = ?1, zoom_join_url = ?2 WHERE id = ?3").bind(meeting?.id ?? null, url, g.id).run();
      g = { ...g, zoom_meeting_id: meeting?.id ?? null, zoom_join_url: url };
    }
  }
  if (g.zoom_join_url) {
    await env.DB.prepare("UPDATE bookings SET zoom_join_url = ?1 WHERE group_id = ?2 AND (zoom_join_url IS NULL OR zoom_join_url <> ?1)")
      .bind(g.zoom_join_url, g.id).run();
  }
  try {
    const url = await calendarFor(env, await scheduling(env)).putEvent(g.ics_uid, groupEventIcs(g, seats), g.calendar_event_url);
    if (url !== g.calendar_event_url) await env.DB.prepare("UPDATE groups SET calendar_event_url = ?1 WHERE id = ?2").bind(url, g.id).run();
  } catch (err) { console.error("group calendar write failed:", (err as Error).message); }
}

// After a student leaves: cancel the group if nobody's left, otherwise update the calendar event.
export async function refreshGroup(env: Env, groupId: string, now = Date.now()): Promise<"cancelled" | "active" | "gone"> {
  const g = await loadGroup(env, groupId);
  if (!g || g.status !== "active") return "gone";
  const seats = await groupSeats(env, groupId);
  if (seats.length) {
    await setUpGroup(env, groupId);
    return "active";
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE groups SET status = 'cancelled', cancelled_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'").bind(iso(now), groupId),
    env.DB.prepare("DELETE FROM slot_claims WHERE group_id = ?1").bind(groupId),
  ]);
  await removeGroupExtras(env, groupId);
  return "cancelled";
}

// Deletes a cancelled group's calendar event and Zoom meeting (retried by cron if either fails).
async function removeGroupExtras(env: Env, groupId: string): Promise<void> {
  const g = await loadGroup(env, groupId);
  if (!g || g.status !== "cancelled") return;
  const errors: string[] = [];
  if (g.calendar_event_url) {
    try {
      await calendarFor(env).deleteEvent(g.calendar_event_url);
      await env.DB.prepare("UPDATE groups SET calendar_event_url = NULL WHERE id = ?1").bind(g.id).run();
    } catch (err) { console.error("group calendar delete failed:", (err as Error).message); errors.push((err as Error).message); }
  }
  if (g.zoom_meeting_id) {
    try {
      await deleteMeeting(env, g.zoom_meeting_id);
      await env.DB.prepare("UPDATE groups SET zoom_meeting_id = NULL WHERE id = ?1").bind(g.id).run();
    } catch (err) { console.error("group zoom delete failed:", (err as Error).message); errors.push((err as Error).message); }
  }
  await env.DB.prepare("UPDATE groups SET cleanup_error = ?1 WHERE id = ?2").bind(errors.join("; ").slice(0, 300) || null, g.id).run();
}

// Cron: finish setting up active groups and cleaning up cancelled ones.
export async function maintainGroups(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, status FROM groups WHERE updated_at <= ?1 AND end_utc > ?2 AND (
       (status = 'active' AND (calendar_event_url IS NULL OR zoom_join_url IS NULL))
       OR (status = 'cancelled' AND (calendar_event_url IS NOT NULL OR zoom_meeting_id IS NOT NULL))) LIMIT 10`,
  ).bind(iso(now - 2 * MIN), iso(now)).all<{ id: string; status: string }>();
  for (const r of rows.results) {
    if (r.status === "active") await setUpGroup(env, r.id);
    else await removeGroupExtras(env, r.id);
  }
  return rows.results.length;
}

/* ── Avery: cancel or move ── */

// Cancels the whole group: every student's spot (refunding anyone who paid, if
// Avery chose that; bundle credits go back), then the group itself.
export async function adminCancelGroup(env: Env, groupId: string, opts: { notifyClient: boolean; refund: boolean },
  ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const g = await loadGroup(env, groupId);
  if (!g || g.status !== "active") throw new BookingError(409, "This group session isn't active.");
  const { adminCancelBooking } = await import("./admin");
  for (const s of await groupSeats(env, groupId)) {
    try {
      await adminCancelBooking(env, s.id, { notifyClient: opts.notifyClient, returnCredit: true, refund: opts.refund }, ctx);
    } catch (err) {
      if (!(err instanceof BookingError && err.status === 409)) throw err; // already cancelled: fine
    }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE groups SET status = 'cancelled', cancelled_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'").bind(iso(ctx.now), groupId),
    env.DB.prepare("DELETE FROM slot_claims WHERE group_id = ?1").bind(groupId),
  ]);
  ctx.waitUntil(removeGroupExtras(env, groupId));
  return { ok: true };
}

// Moves a session Avery chooses (any booking, or a whole group) to a new time.
export async function adminMove(env: Env, target: { bookingId?: string; groupId?: string }, body: unknown,
  ctx: { now: number; waitUntil: (p: Promise<unknown>) => void }) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const now = ctx.now;
  if (target.bookingId) {
    const row = await loadBooking(env, "id", target.bookingId);
    if (!row || row.status !== "confirmed") throw new BookingError(409, "Only confirmed sessions can be moved.");
    if (row.group_id) return adminMove(env, { groupId: row.group_id }, body, ctx);
    const { service, start, end } = parseWhen({ ...b, serviceId: row.service_id }, now);
    if (start === Date.parse(row.start_utc)) throw new BookingError(400, "That's already the session time.");
    if (await isDayOff(env, start)) throw new BookingError(400, DAY_OFF);
    const buffer = row.created_by === "admin" ? 0 : (await scheduling(env)).bufferMinutes;
    let res;
    try {
      res = await env.DB.batch([
        env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(row.id),
        ...blocksFor(start, service.durationMinutes, buffer).map((blk) =>
          env.DB.prepare("INSERT INTO slot_claims (slot_start, booking_id) VALUES (?1, ?2)").bind(blk, row.id)),
        env.DB.prepare(
          `UPDATE bookings SET previous_start_utc = start_utc, start_utc = ?1, end_utc = ?2, ics_sequence = ics_sequence + 1,
             session_reminder_sent_at = NULL, pay_by = CASE WHEN pay_by > ?1 THEN ?1 ELSE pay_by END, updated_at = ?3
           WHERE id = ?4 AND status = 'confirmed'`,
        ).bind(iso(start), iso(end), iso(now), row.id),
      ]);
    } catch (err) { mapWriteError(err); }
    if (!res!.at(-1)!.meta.changes) throw new BookingError(409, "Only confirmed sessions can be moved.");
    // A held repeat goes out as a fresh invite at its new time; anything else as a reschedule.
    ctx.waitUntil(row.series_conflict
      ? (async () => { await (await import("./series")).releaseHeld(env, row.id, Date.now()); })()
      : afterReschedule(env, row.id, { notifyAvery: false }));
    return { ok: true, start: iso(start) };
  }

  const g = await loadGroup(env, target.groupId ?? "");
  if (!g || g.status !== "active") throw new BookingError(409, "This group session isn't active.");
  const { service, start, end } = parseWhen({ ...b, serviceId: g.service_id }, now);
  if (start === Date.parse(g.start_utc)) throw new BookingError(400, "That's already the session time.");
  if (await isDayOff(env, start)) throw new BookingError(400, DAY_OFF);
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare("DELETE FROM slot_claims WHERE group_id = ?1").bind(g.id),
      ...blocksFor(start, service.durationMinutes, 0).map((blk) =>
        env.DB.prepare("INSERT INTO slot_claims (slot_start, group_id) VALUES (?1, ?2)").bind(blk, g.id)),
      env.DB.prepare(
        `UPDATE groups SET previous_start_utc = start_utc, start_utc = ?1, end_utc = ?2, ics_sequence = ics_sequence + 1, updated_at = ?3
         WHERE id = ?4 AND status = 'active'`,
      ).bind(iso(start), iso(end), iso(now), g.id),
      env.DB.prepare(
        `UPDATE bookings SET previous_start_utc = start_utc, start_utc = ?1, end_utc = ?2, ics_sequence = ics_sequence + 1,
           session_reminder_sent_at = NULL, pay_by = CASE WHEN pay_by > ?1 THEN ?1 ELSE pay_by END, updated_at = ?3
         WHERE group_id = ?4 AND status = 'confirmed'`,
      ).bind(iso(start), iso(end), iso(now), g.id),
    ]);
  } catch (err) { mapWriteError(err); }
  if (!res![res!.length - 2].meta.changes) throw new BookingError(409, "This group session isn't active.");
  ctx.waitUntil(afterGroupMove(env, g.id, Date.parse(g.start_utc)));
  return { ok: true, start: iso(start) };
}

async function afterGroupMove(env: Env, groupId: string, previous: number): Promise<void> {
  const g = await loadGroup(env, groupId);
  if (!g || g.status !== "active") return;
  if (g.zoom_meeting_id) {
    try { await updateMeeting(env, g.zoom_meeting_id, { start: Date.parse(g.start_utc), durationMinutes: findService(g.service_id)!.durationMinutes }); }
    catch (err) { console.error("group zoom update failed:", (err as Error).message); }
  }
  await setUpGroup(env, groupId);
  for (const s of await groupSeats(env, groupId)) {
    const v = view(s);
    await sendEmail(env, "client_rescheduled", s.id, T.clientRescheduled(v, previous, clientIcs(env, s, v, "REQUEST"), await manageUrl(env, s.id)));
  }
}

// Sends a student their invite again (with the payment link if they still owe).
export async function adminResendInvite(env: Env, bookingId: string) {
  const row = await loadBooking(env, "id", bookingId);
  if (!row || row.status !== "confirmed") throw new BookingError(409, "Only confirmed sessions can be re-sent.");
  if (row.series_conflict) throw new BookingError(409, "This session is waiting for you to keep or move it. Keeping it sends the invite.");
  const v = view(row);
  const manage = await manageUrl(env, row.id);
  const ics = clientIcs(env, row, v, "REQUEST");
  const email = row.created_by === "admin" || row.created_by === "series" ? T.adminInvite(v, ics, manage, v.dueCents ? payUrl(manage) : null) : T.clientConfirmation(v, ics, manage);
  if (!(await sendEmail(env, "invite_resent", row.id, email))) throw new BookingError(502, "The email couldn't be sent. Please try again.");
  return { ok: true };
}

// Everyone Avery has worked with, most recent first: their usable bundles
// (for the booking form) and a summary for the Students list.
export async function adminStudents(env: Env, now: number) {
  const t = iso(now);
  const people = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.pronouns,
       (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.start_utc > ?1) AS upcoming,
       (SELECT MIN(b.start_utc) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.start_utc > ?1) AS next_start,
       (SELECT MAX(b.start_utc) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.start_utc <= ?1) AS last_start,
       (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.start_utc <= ?1) AS past,
       (SELECT COALESCE(SUM(b.price_cents), 0) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.price_cents IS NOT NULL
          AND b.paid_at IS NULL AND b.package_id IS NULL AND b.price_cents > 0) AS owed_cents,
       (SELECT MAX(b.created_at) FROM bookings b WHERE b.customer_id = c.id AND b.status IN ('confirmed', 'cancelled')) AS last_booked,
       (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.attendance = 'no_show') AS no_shows
     FROM customers c
     WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.status IN ('confirmed', 'cancelled'))
        OR EXISTS (SELECT 1 FROM packages p WHERE p.customer_id = c.id AND p.status IN ('active', 'cancelled') AND p.cancel_reason IS NOT 'checkout_expired')
     ORDER BY COALESCE(next_start, '9999'), last_booked DESC LIMIT 1000`,
  ).bind(t).all<Record<string, any>>();
  const bundles = await env.DB.prepare(
    `SELECT id, customer_id, service_id, credits_total, credits_used, expires_at FROM packages
     WHERE status = 'active' AND credits_used < credits_total AND expires_at > ?1`,
  ).bind(t).all<{ id: string; customer_id: string; service_id: string; credits_total: number; credits_used: number; expires_at: string }>();
  return people.results.map((p) => ({
    id: p.id, name: p.name, email: p.email, pronouns: p.pronouns,
    upcoming: p.upcoming, nextStart: p.next_start, lastStart: p.last_start, pastSessions: p.past, owedCents: p.owed_cents, noShows: p.no_shows,
    bundles: bundles.results.filter((x) => x.customer_id === p.id).map((x) => ({
      id: x.id, remaining: x.credits_total - x.credits_used, total: x.credits_total, expiresAt: x.expires_at,
    })),
  }));
}

// One student's full history, for the Students detail view.
export async function adminStudentDetail(env: Env, customerId: string, now: number) {
  const c = await env.DB.prepare("SELECT id, name, email, pronouns, notes, created_at FROM customers WHERE id = ?1").bind(customerId)
    .first<{ id: string; name: string; email: string; pronouns: string | null; notes: string | null; created_at: string }>();
  if (!c) throw new BookingError(404, "Student not found.");
  const bookings = await env.DB.prepare(
    `SELECT b.*, ${CLIENT_COLUMNS("b")} FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.customer_id = ?1 AND b.status IN ('confirmed', 'cancelled') ORDER BY b.start_utc DESC LIMIT 300`,
  ).bind(customerId).all<BookingRow>();
  const packages = await env.DB.prepare(
    `SELECT * FROM packages WHERE customer_id = ?1 AND status IN ('active', 'cancelled') AND cancel_reason IS NOT 'checkout_expired'
     ORDER BY created_at DESC`,
  ).bind(customerId).all<Record<string, any>>();
  return {
    id: c.id, name: c.name, email: c.email, pronouns: c.pronouns, notes: c.notes, since: c.created_at,
    sessions: bookings.results.map((b) => {
      const service = findService(b.service_id)!;
      return {
        id: b.id, service: serviceLabel(service), serviceId: b.service_id, start: b.start_utc, end: b.end_utc,
        status: b.status === "confirmed" ? (Date.parse(b.end_utc) <= now ? "past" : "upcoming") : "cancelled",
        cancelReason: b.cancel_reason, group: !!b.group_id, groupId: b.group_id, byAvery: b.created_by === "admin",
        paid: b.package_id ? "bundle" : b.amount_cents, dueCents: dueCents(b), payBy: b.pay_by, refunded: !!b.refunded_at,
        refundedCents: b.refunded_cents ?? 0, noShow: b.attendance === "no_show", remindersSent: b.payment_reminders_sent,
        lastReminderAt: b.last_payment_reminder_at, nextReminderAt: nextAutoReminder(b, now),
        intake: b.intake_json ? JSON.parse(b.intake_json) : null, message: b.invite_message, seriesId: b.series_id,
        held: b.series_conflict,
      };
    }),
    paymentRequests: await (await import("./requests")).openRequests(env, customerId),
    series: (await env.DB.prepare(
      "SELECT id, service_id, every_weeks, sessions_left, last_start, price_cents, started_by FROM series WHERE customer_id = ?1 AND status IN ('pending', 'active')",
    ).bind(customerId).all<Record<string, any>>()).results.map((x) => ({
      id: x.id, service: serviceLabel(findService(x.service_id)!), everyWeeks: x.every_weeks, sessionsLeft: x.sessions_left,
      lastStart: x.last_start, priceCents: x.price_cents, startedBy: x.started_by,
    })),
    bundles: packages.results.map((p) => ({
      id: p.id, bundle: `${findService(p.service_id)?.credits ?? p.credits_total} session bundle`, status: p.status,
      expired: !!p.expires_at && Date.parse(p.expires_at) <= now, creditsTotal: p.credits_total, creditsUsed: p.credits_used,
      remaining: p.credits_total - p.credits_used, expiresAt: p.expires_at, paidCents: p.amount_cents, cancelReason: p.cancel_reason,
      refundDueCents: p.refund_due_cents, refunded: !!p.refunded_at, refundedCents: p.refunded_cents ?? 0, refundError: p.refund_error, createdAt: p.created_at,
    })),
  };
}

/* ── Avery sends a payment reminder now ── */

// One session. Not twice within 10 minutes (so a double click doesn't send two).
export async function adminRemind(env: Env, bookingId: string, now: number) {
  const row = await loadBooking(env, "id", bookingId);
  if (!row || !dueCents(row)) throw new BookingError(409, "Nothing is owed on this session.");
  if (row.series_conflict) throw new BookingError(409, "This session is waiting for you to keep or move it; the student hasn't been told about it yet.");
  const last = row.last_payment_reminder_at ? Date.parse(row.last_payment_reminder_at) : 0;
  if (last > now - REMINDER_GAP) {
    const fmt = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: RULES.timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(ms);
    throw new BookingError(429, `A reminder went out ${fmt(last)}. You can send another after ${fmt(last + REMINDER_GAP)}.`);
  }
  const ok = await sendEmail(env, "payment_reminder_manual", row.id, T.paymentReminder(view(row), payUrl(await manageUrl(env, row.id)), await manageUrl(env, row.id)));
  if (!ok) throw new BookingError(502, "The reminder couldn't be sent. Please try again.");
  await recordReminder(env, row.id, now);
  return { ok: true, sent: 1 };
}

// Reminders (automatic or Avery's) are at least 12 hours apart.
export const REMINDER_GAP = 12 * 60 * MIN;
const recordReminder = (env: Env, id: string, now: number) => env.DB.prepare(
  "UPDATE bookings SET payment_reminders_sent = payment_reminders_sent + 1, last_payment_reminder_at = ?1 WHERE id = ?2",
).bind(iso(now), id).run();

// When the one automatic reminder is due (null if it's been sent or isn't needed).
export function nextAutoReminder(row: Pick<BookingRow, "created_by" | "package_id" | "paid_at" | "price_cents" | "status" | "payment_reminder_sent_at" | "pay_by" | "start_utc" | "created_at" | "last_payment_reminder_at">, now: number): string | null {
  if (!dueCents(row) || row.payment_reminder_sent_at) return null;
  const start = Date.parse(row.start_utc);
  let at = row.pay_by ? Date.parse(row.pay_by) - 24 * 60 * MIN : start - 2 * 24 * 60 * MIN;
  at = Math.max(at, Date.parse(row.created_at) + 6 * 60 * MIN, row.last_payment_reminder_at ? Date.parse(row.last_payment_reminder_at) + REMINDER_GAP : 0, now);
  const latest = row.pay_by ? Date.parse(row.pay_by) - 30 * MIN : start - 2 * 60 * MIN;
  return at < latest ? iso(at) : null;
}

// Everything one student owes: a reminder per unpaid session.
export async function adminRemindStudent(env: Env, customerId: string, now: number) {
  const rows = await env.DB.prepare(
    `SELECT id FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND price_cents IS NOT NULL AND paid_at IS NULL
       AND package_id IS NULL AND price_cents > 0 AND end_utc > ?2 AND series_conflict IS NULL ORDER BY start_utc`,
  ).bind(customerId, iso(now)).all<{ id: string }>();
  if (!rows.results.length) throw new BookingError(409, "They don't owe anything right now.");
  let sent = 0;
  for (const { id } of rows.results) {
    try { await adminRemind(env, id, now); sent++; } catch (err) { if (!(err instanceof BookingError && err.status === 429)) throw err; }
  }
  if (!sent) throw new BookingError(429, "Reminders went out in the last few minutes.");
  return { ok: true, sent };
}

/* ── Students paying ── */

// From the payment link: returns a Stripe checkout page for what's owed.
export async function startPayment(env: Env, bookingId: unknown, token: unknown, now: number) {
  const notFound = new BookingError(404, "We couldn't find that booking. Please use the link in your email.");
  if (!(await validManageToken(env, bookingId, token))) throw notFound;
  const row = await loadBooking(env, "id", bookingId as string);
  if (!row) throw notFound;
  if (row.paid_at) throw new BookingError(409, "This session is already paid. Thank you!");
  const due = dueCents(row);
  if (!due) throw new BookingError(409, row.status === "cancelled" ? "This session has been cancelled." : "There's nothing to pay for this session.");
  if (row.pay_by && Date.parse(row.pay_by) <= now) throw new BookingError(409, "The payment deadline has passed. Please reply to your invite email.");
  // No deadline: it can still be paid after the session has happened.

  // Reuse a checkout that's still open, so two clicks don't make two payments.
  if (row.stripe_checkout_session_id) {
    try {
      const s = await stripe.getCheckoutSession(env, row.stripe_checkout_session_id);
      if (s.status === "open" && s.url && (s.expires_at ?? 0) * 1000 > now + 10 * MIN) return { checkoutUrl: s.url };
      if (s.status === "complete" && stripe.isPaid(s)) {
        await recordPayment(env, s, now);
        throw new BookingError(409, "This session is already paid. Thank you!");
      }
    } catch (err) {
      if (err instanceof BookingError) throw err;
      console.warn("startPayment: couldn't check the last checkout:", (err as Error).message);
    }
  }

  const service = findService(row.service_id)!;
  const manage = await manageUrl(env, row.id);
  const length = service.durationMinutes === 60 ? "1 hour" : `${service.durationMinutes} minutes`;
  const when = new Intl.DateTimeFormat("en-US", { timeZone: row.client_time_zone || AVERY_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(Date.parse(row.start_utc));
  let session: stripe.CheckoutSession;
  try {
    session = await stripe.createCheckoutSession(env, {
      bookingId: row.id,
      kind: "payment",
      idempotencyKey: `pay-${row.id}-${now}`,
      email: row.email,
      productName: `${row.group_id ? "Group coaching" : "Private coaching"}, ${length}`,
      description: `${when} on Zoom`,
      amountCents: due,
      expiresAt: now + 60 * MIN,
      successUrl: `${manage}&paid=1`,
      cancelUrl: manage,
    });
  } catch (err) {
    console.error("startPayment: Stripe checkout failed:", (err as Error).message);
    throw new BookingError(502, "Payment couldn't be started. Please try again in a moment.");
  }
  await env.DB.prepare("UPDATE bookings SET stripe_checkout_session_id = ?1, updated_at = ?2 WHERE id = ?3").bind(session.id, iso(now), row.id).run();
  return { checkoutUrl: session.url! };
}

// Stripe says a payment for a booked session went through.
export async function recordPayment(env: Env, s: stripe.CheckoutSession, now: number, promoCode?: string | null): Promise<void> {
  const row = await loadBooking(env, "id", s.metadata?.booking_id ?? "");
  if (!row) { console.error("recordPayment: no booking for checkout session"); return; }
  const paid = s.amount_total ?? 0;
  const pi = s.payment_intent;

  // Already paid (a second checkout was also completed): refund the extra one.
  if (row.paid_at) {
    if (pi && pi !== row.stripe_payment_intent_id) {
      try {
        await stripe.refundPayment(env, pi, row.id);
      } catch (err) {
        console.error("recordPayment: duplicate refund failed:", (err as Error).message);
        await sendEmail(env, "attention_alert", row.id, {
          ...T.attentionAlert([`${row.name} paid twice for the same session, and refunding the second payment (${money(paid)}) didn't work. Please refund it in Stripe.`]),
          to: env.ADMIN_EMAIL,
        });
      }
    }
    return;
  }

  if (row.status === "confirmed") {
    const res = await env.DB.prepare(
      `UPDATE bookings SET paid_at = ?1, amount_cents = ?2, stripe_payment_intent_id = ?3, promo_code = COALESCE(?4, promo_code),
         ics_sequence = ics_sequence + 1, updated_at = ?1
       WHERE id = ?5 AND status = 'confirmed' AND paid_at IS NULL`,
    ).bind(iso(now), paid, pi, promoCode ?? null, row.id).run();
    if (!res.meta.changes) return;
    const fresh = (await loadBooking(env, "id", row.id))!;
    if (fresh.series_id) await (await import("./series")).seriesPaid(env, fresh.series_id);
    const v = view(fresh);
    // Now they've paid, the receipt carries the Zoom link and an updated calendar invite.
    await sendEmail(env, "payment_received", row.id, T.paymentReceived(v, await manageUrl(env, row.id), clientIcs(env, fresh, v, "REQUEST")));
    await sendEmail(env, "admin_payment_received", row.id, { ...T.adminPaymentReceived(v), to: env.ADMIN_EMAIL });
    if (row.group_id) await setUpGroup(env, row.group_id);
    else await refreshCalendarEvent(env, row.id);
    return;
  }

  // The session was cancelled (or released) before this payment arrived: refund it in full.
  const res = await env.DB.prepare(
    `UPDATE bookings SET paid_at = ?1, amount_cents = ?2, stripe_payment_intent_id = ?3,
       refund_requested_at = CASE WHEN ?3 IS NOT NULL AND ?2 > 0 THEN ?1 END, updated_at = ?1
     WHERE id = ?4 AND status = 'cancelled' AND paid_at IS NULL`,
  ).bind(iso(now), paid, pi, row.id).run();
  if (!res.meta.changes || !pi || paid <= 0) return;
  const refunded = await issueRefund(env, row.id, now);
  const v = { ...view(row), amountCents: paid };
  await sendEmail(env, "paid_after_cancel", row.id, T.paidAfterCancel(v));
  await sendEmail(env, "admin_paid_after_cancel", row.id, {
    ...T.adminNotification(v, {
      zoomMissing: false, calendarFailed: false, title: "Auto-refunded",
      notice: `${row.name} paid ${money(paid)} after this session had been cancelled. ${refunded ? "They were refunded in full automatically." : "The automatic refund hasn't gone through yet. It will keep retrying, and you'll get an alert if it still doesn't go through."}`,
    }),
    to: env.ADMIN_EMAIL,
    subject: `Auto-refunded: ${row.name} paid after their session was cancelled`,
  });
}

/* ── Deadlines and reminders (cron) ── */

// Anyone still unpaid when their pay-by deadline passes is released.
export async function releaseUnpaid(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM bookings WHERE status = 'confirmed' AND price_cents IS NOT NULL AND paid_at IS NULL AND package_id IS NULL
       AND price_cents > 0 AND pay_by IS NOT NULL AND pay_by <= ?1 AND series_conflict IS NULL LIMIT 20`,
  ).bind(iso(now)).all<{ id: string }>();
  let released = 0;
  for (const { id } of rows.results) {
    try {
      const row = (await loadBooking(env, "id", id))!;
      // Paid at the last moment but Stripe's notice hasn't arrived: record it instead.
      if (row.stripe_checkout_session_id) {
        const s = await stripe.expireCheckoutSession(env, row.stripe_checkout_session_id);
        if (s.status === "complete" && stripe.isPaid(s) && s.metadata?.purpose === "payment") {
          await recordPayment(env, s, now);
          continue;
        }
      }
      const res = await env.DB.batch([
        env.DB.prepare(
          `UPDATE bookings SET status = 'cancelled', cancel_reason = 'unpaid', cancelled_at = ?1, ics_sequence = ics_sequence + 1, updated_at = ?1
           WHERE id = ?2 AND status = 'confirmed' AND paid_at IS NULL`,
        ).bind(iso(now), id),
        env.DB.prepare("DELETE FROM slot_claims WHERE booking_id = ?1").bind(id),
      ]);
      if (!res[0].meta.changes) continue;
      const after = (await loadBooking(env, "id", id))!;
      let groupContinues = false;
      if (after.group_id) groupContinues = (await refreshGroup(env, after.group_id, now)) === "active";
      await removeCancelled(env, after);
      if (after.series_id) await (await import("./series")).seriesMissedPayment(env, after.series_id, now);
      const v = view(after);
      await sendEmail(env, "unpaid_released", id, T.unpaidReleased({ ...v, dueCents: after.price_cents ?? 0 }, clientIcs(env, after, v, "CANCEL")));
      await sendEmail(env, "admin_unpaid_released", id, { ...T.adminUnpaidReleased({ ...v, dueCents: after.price_cents ?? 0 }, groupContinues), to: env.ADMIN_EMAIL });
      released++;
    } catch (err) {
      console.error("releaseUnpaid:", (err as Error).message);
    }
  }
  return released;
}

// One "payment due" reminder: a day before the deadline, or two days before
// the session when there's no deadline. Never in the first 6 hours after the invite.
export async function sendPaymentReminders(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM bookings WHERE status = 'confirmed' AND price_cents IS NOT NULL AND paid_at IS NULL AND package_id IS NULL
       AND price_cents > 0 AND payment_reminder_sent_at IS NULL AND created_at <= ?1 AND start_utc > ?2 AND series_conflict IS NULL
       AND (last_payment_reminder_at IS NULL OR last_payment_reminder_at <= ?7)
       AND ((pay_by IS NOT NULL AND pay_by <= ?3 AND pay_by > ?4) OR (pay_by IS NULL AND start_utc <= ?5 AND start_utc > ?6))
     LIMIT 20`,
  ).bind(iso(now - 6 * 60 * MIN), iso(now), iso(now + DAY), iso(now + 30 * MIN), iso(now + 2 * DAY), iso(now + 2 * 60 * MIN), iso(now - REMINDER_GAP)).all<{ id: string }>();
  let sent = 0;
  for (const { id } of rows.results) {
    const row = await loadBooking(env, "id", id);
    if (!row || !dueCents(row)) continue;
    if (await sendEmail(env, "payment_reminder", id, T.paymentReminder(view(row), payUrl(await manageUrl(env, id)), await manageUrl(env, id)))) {
      await env.DB.prepare("UPDATE bookings SET payment_reminder_sent_at = ?1 WHERE id = ?2").bind(iso(now), id).run();
      await recordReminder(env, id, now);
      sent++;
    }
  }
  return sent;
}
