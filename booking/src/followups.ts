// "Time to follow up": a week (Settings, followUpDays) after a student's last
// session, if they have nothing else booked, Avery is prompted to get in touch.
//
// They show in Needs attention until they book, she emails them (a check-in
// email sent or scheduled after that session), she dismisses them, or 60 days
// pass (from then on they're "quiet" and the check-in button takes over).
// Students who unsubscribed or are marked "don't email" are left out.
// Optionally she also gets one email a day, from 9am, listing the new ones.

import type { Env } from "./env";
import { iso } from "./time";
import { RULES } from "./settings";
import { scheduling } from "./config";
import { BookingError } from "./bookings";
import { findService } from "./services";
import { sendEmail } from "./email";
import * as T from "./templates";

const DAY = 86400000;
const QUIET_DAYS = 60;
const DIGEST_HOUR = 9;

export type FollowUp = {
  id: string; name: string; pronouns: string | null; email: string;
  lastStart: string; service: string; days: number; credits: number; emailedFor: string | null;
};

// Everyone due a follow-up now. afterDays 0 means the prompt is switched off.
export async function followUpsDue(env: Env, now: number, afterDays?: number): Promise<FollowUp[]> {
  const days = afterDays ?? (await scheduling(env)).followUpDays;
  if (!days) return [];
  const t = iso(now);
  const rows = (await env.DB.prepare(
    `SELECT c.id, c.name, c.pronouns, c.email, c.followup_done_for, c.followup_emailed_for, x.start_utc AS last_start, x.end_utc AS last_end, x.service_id,
       (SELECT MAX(n.sent_at) FROM nudge_emails n WHERE n.customer_id = c.id AND n.status = 'sent') AS last_nudge,
       (SELECT COUNT(*) FROM nudge_emails n WHERE n.customer_id = c.id AND n.status IN ('scheduled', 'sending')) AS nudge_waiting,
       (SELECT COALESCE(SUM(p.credits_total - p.credits_used), 0) FROM packages p
         WHERE p.customer_id = c.id AND p.status = 'active' AND p.credits_used < p.credits_total AND p.expires_at > ?1) AS credits
     FROM customers c
     JOIN bookings x ON x.id = (SELECT b.id FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.end_utc <= ?1 ORDER BY b.start_utc DESC LIMIT 1)
     WHERE c.no_email = 0 AND (c.email_paused_until IS NULL OR c.email_paused_until <= ?1)
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.end_utc > ?1)
       AND x.end_utc <= ?2 AND x.end_utc > ?3
     ORDER BY x.end_utc`,
  ).bind(t, iso(now - days * DAY), iso(now - QUIET_DAYS * DAY)).all<Record<string, any>>()).results;
  return rows
    .filter((r) => r.followup_done_for !== r.last_start && !r.nudge_waiting && !(r.last_nudge && r.last_nudge >= r.last_end))
    .map((r) => ({
      id: r.id, name: r.name, pronouns: r.pronouns, email: r.email,
      lastStart: r.last_start, service: findService(r.service_id)?.name ?? "Session",
      days: Math.floor((now - Date.parse(r.last_start)) / DAY), credits: r.credits, emailedFor: r.followup_emailed_for,
    }));
}

// Avery dismissed the prompt. It comes back only after their next session.
export async function dismissFollowUp(env: Env, customerId: string, now: number) {
  const last = await env.DB.prepare(
    "SELECT start_utc FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND end_utc <= ?2 ORDER BY start_utc DESC LIMIT 1",
  ).bind(customerId, iso(now)).first<{ start_utc: string }>();
  if (!last) throw new BookingError(404, "They haven't had a session yet.");
  await env.DB.prepare("UPDATE customers SET followup_done_for = ?1 WHERE id = ?2").bind(last.start_utc, customerId).run();
  return { ok: true };
}

// Undo for a dismiss: they're listed again (if they still qualify).
export async function restoreFollowUp(env: Env, customerId: string) {
  await env.DB.prepare("UPDATE customers SET followup_done_for = NULL WHERE id = ?1").bind(customerId).run();
  return { ok: true };
}

const etHourAndDate = (ms: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: RULES.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(ms).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
};

// Cron: at most one email a day, from 9am, listing students who weren't in an earlier one for this session.
export async function sendFollowUpDigest(env: Env, now: number): Promise<number> {
  const s = await scheduling(env);
  if (!s.followUpDays || !s.followUpEmail) return 0;
  const today = etHourAndDate(now);
  if (today.hour < DIGEST_HOUR) return 0;
  const last = await env.DB.prepare("SELECT last_sent_at FROM alerts_sent WHERE kind = 'followups'").first<{ last_sent_at: string }>();
  if (last && etHourAndDate(Date.parse(last.last_sent_at)).date === today.date) return 0;
  const fresh = (await followUpsDue(env, now, s.followUpDays)).filter((f) => f.emailedFor !== f.lastStart);
  if (!fresh.length) return 0;
  const email = T.adminFollowUps(fresh.map((f) => ({ name: f.name, lastStart: Date.parse(f.lastStart), service: f.service, days: f.days, credits: f.credits })), s.followUpDays);
  if (!(await sendEmail(env, "follow_up_digest", null, { ...email, to: env.ADMIN_EMAIL }))) return 0;
  await env.DB.batch([
    ...fresh.map((f) => env.DB.prepare("UPDATE customers SET followup_emailed_for = ?1 WHERE id = ?2").bind(f.lastStart, f.id)),
    env.DB.prepare("INSERT INTO alerts_sent (kind, last_sent_at) VALUES ('followups', ?1) ON CONFLICT(kind) DO UPDATE SET last_sent_at = excluded.last_sent_at").bind(iso(now)),
  ]);
  return fresh.length;
}
