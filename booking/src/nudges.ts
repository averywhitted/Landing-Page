// "Been a while" emails: Avery sends (or schedules) one from a student's list
// entry or profile. Four written templates plus one Avery writes herself.
//
// Guard rails: warnings (upcoming session, emailed recently, or seen recently)
// have to be confirmed; a student marked "don't email" can't be sent to at all;
// and a scheduled email is checked again when it's due, so someone who booked
// in the meantime doesn't get a "we miss you" message.

import type { Env } from "./env";
import { iso, zonedToUtc } from "./time";
import { RULES } from "./settings";
import { BookingError, clean } from "./bookings";
import { packageUrl, unsubscribeUrl, validUnsubscribeToken } from "./manage";
import { sendEmail } from "./email";
import * as T from "./templates";

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const QUIET_DAYS = 60;
const REPEAT_DAYS = 30;
const MAX_TRIES = 3;

const KINDS = Object.keys(T.NUDGE_LABELS) as T.NudgeKind[];
const dayText = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: RULES.timeZone, weekday: "short", month: "short", day: "numeric" }).format(ms);

type Student = { id: string; name: string; email: string; no_email: number; created_at: string; email_paused_until: string | null; email_paused_at: string | null };

async function loadStudent(env: Env, id: string): Promise<Student> {
  const s = await env.DB.prepare("SELECT id, name, email, no_email, created_at, email_paused_until, email_paused_at FROM customers WHERE id = ?1").bind(id).first<Student>();
  if (!s) throw new BookingError(404, "Student not found.");
  return s;
}

// Their live bundle sessions: how many, when the first batch runs out, and where to book them.
async function creditsFor(env: Env, customerId: string, now: number) {
  const rows = (await env.DB.prepare(
    `SELECT id, credits_total - credits_used AS left, expires_at FROM packages
     WHERE customer_id = ?1 AND status = 'active' AND credits_used < credits_total AND expires_at > ?2 ORDER BY expires_at`,
  ).bind(customerId, iso(now)).all<{ id: string; left: number; expires_at: string }>()).results;
  if (!rows.length) return null;
  return { n: rows.reduce((n, r) => n + r.left, 0), until: Date.parse(rows[0].expires_at), packageId: rows[0].id, several: rows.length > 1 };
}

async function facts(env: Env, s: Student, now: number) {
  const t = iso(now);
  const one = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
  const upcoming = await one<{ n: number; next: string | null }>(
    "SELECT COUNT(*) AS n, MIN(start_utc) AS next FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND end_utc > ?2", s.id, t);
  const last = await one<{ at: string | null }>("SELECT MAX(start_utc) AS at FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND start_utc <= ?2", s.id, t);
  const sent = await one<{ at: string | null }>("SELECT MAX(sent_at) AS at FROM nudge_emails WHERE customer_id = ?1 AND status = 'sent'", s.id);
  const waiting = await one<{ at: string | null }>("SELECT MIN(send_at) AS at FROM nudge_emails WHERE customer_id = ?1 AND status IN ('scheduled', 'sending')", s.id);
  const since = Date.parse(last?.at ?? s.created_at);
  return {
    upcoming: upcoming?.n ?? 0, nextStart: upcoming?.next ? Date.parse(upcoming.next) : null,
    days: Math.max(0, Math.floor((now - since) / DAY)), lastSent: sent?.at ? Date.parse(sent.at) : null, waiting: waiting?.at ? Date.parse(waiting.at) : null,
  };
}

function warningsFor(f: Awaited<ReturnType<typeof facts>>, first: string, now: number): string[] {
  const out: string[] = [];
  if (f.upcoming) out.push(`${first} has a session coming up on ${dayText(f.nextStart!)}.`);
  else if (f.days < QUIET_DAYS) out.push(`Their last session was only ${f.days} day${f.days === 1 ? "" : "s"} ago.`);
  if (f.waiting) out.push(`An email to ${first} is already scheduled for ${dayText(f.waiting)}.`);
  if (f.lastSent && now - f.lastSent < REPEAT_DAYS * DAY) out.push(`You emailed ${first} on ${dayText(f.lastSent)}.`);
  return out;
}

const firstOf = (name: string) => name.trim().split(/\s+/)[0] || "them";

/* ── Pauses: the student's own choice from the link in each email ── */

// "Stop all check-in emails" is stored as a pause that never ends.
export const FOREVER = "9999-12-31T00:00:00Z";

// The pause in effect at `at`: null if none (or it has run out).
export function pauseAt(s: Pick<Student, "email_paused_until">, at: number): { forever: boolean; until: string } | null {
  if (!s.email_paused_until || Date.parse(s.email_paused_until) <= at) return null;
  return { forever: s.email_paused_until >= FOREVER, until: s.email_paused_until };
}

// Why Avery can't email this student at `at`, or null if she can.
export function blockedReason(s: Student, at: number): string | null {
  const first = firstOf(s.name);
  if (s.no_email) return `${first} is marked "don't email". Untick that on their profile first.`;
  const p = pauseAt(s, at);
  if (!p) return null;
  return p.forever ? `${first} unsubscribed from check-in emails.` : `${first} paused check-in emails until ${dayText(Date.parse(p.until))}.`;
}

/* ── The dialog: what can be sent, what to warn about, what's suggested ── */

export async function adminNudgeInfo(env: Env, customerId: string, now: number) {
  const s = await loadStudent(env, customerId);
  const f = await facts(env, s, now);
  const credits = await creditsFor(env, s.id, now);
  return {
    name: s.name, email: s.email, noEmail: !!s.no_email, blocked: blockedReason(s, now), days: f.days, upcoming: f.upcoming,
    warnings: warningsFor(f, firstOf(s.name), now),
    credits: credits ? { n: credits.n, until: new Date(credits.until).toISOString() } : null,
    // Credits are the strongest reason to write; after that, the longer they've been away the softer the ask.
    suggested: credits ? "credits" : f.days >= 120 ? "intro" : "checkin",
    templates: KINDS.filter((k) => k !== "credits" || credits).map((kind) => ({ kind, label: T.NUDGE_LABELS[kind] })),
  };
}

/* ── Building the email ── */

// What Avery approved: the template it started from (which decides the button) and the exact subject and words.
type Draft = { kind: T.NudgeKind; subject: string; body: string };

function readKind(raw: Record<string, unknown>): T.NudgeKind {
  const kind = raw.template as T.NudgeKind;
  if (!KINDS.includes(kind)) throw new BookingError(400, "Pick an email to send.");
  return kind;
}

function readDraft(raw: Record<string, unknown>): Draft {
  const kind = readKind(raw);
  const subject = clean(raw.subject, 150);
  const body = clean(raw.body, 5000, true);
  if (!subject) throw new BookingError(400, "Please write a subject.");
  if (!body) throw new BookingError(400, "Please write the email.");
  return { kind, subject, body };
}

async function creditsInfo(env: Env, s: Student, now: number): Promise<T.NudgeCredits | undefined> {
  const c = await creditsFor(env, s.id, now);
  return c ? { n: c.n, until: c.until, several: c.several, url: await packageUrl(env, c.packageId) } : undefined;
}

async function build(env: Env, s: Student, d: Draft, now: number) {
  const credits = d.kind === "credits" ? await creditsInfo(env, s, now) : undefined;
  if (d.kind === "credits" && !credits) throw new BookingError(409, `${firstOf(s.name)} doesn't have any unused bundle sessions.`);
  return T.studentNudge({
    kind: d.kind, name: s.name, email: s.email, bookUrl: `${env.SITE_URL}/book/`, introUrl: `${env.SITE_URL}/book/?service=intro-15`,
    credits, subject: d.subject, body: d.body, unsubscribeUrl: await unsubscribeUrl(env, s.id),
  });
}

// The starting text for a template, filled in for this student. It's put in editable boxes.
export async function adminNudgeDraft(env: Env, customerId: string, raw: Record<string, unknown>, now: number) {
  const s = await loadStudent(env, customerId);
  const kind = readKind(raw);
  const credits = kind === "credits" ? await creditsInfo(env, s, now) : undefined;
  if (kind === "credits" && !credits) throw new BookingError(409, `${firstOf(s.name)} doesn't have any unused bundle sessions.`);
  return T.nudgeDraft(kind, s.name, credits);
}

/* ── Send now, or schedule ── */

export async function adminSendNudge(env: Env, customerId: string, raw: Record<string, unknown>, now: number) {
  const s = await loadStudent(env, customerId);
  const d = readDraft(raw);
  let sendAt = now;
  const scheduled = typeof raw.sendDate === "string" || typeof raw.sendTime === "string";
  if (scheduled) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw.sendDate ?? ""));
    const time = /^(\d{2}):(\d{2})$/.exec(String(raw.sendTime ?? ""));
    if (!date || !time) throw new BookingError(400, "Pick a date and time to send.");
    sendAt = zonedToUtc(+date[1], +date[2], +date[3], +time[1], +time[2], RULES.timeZone);
    if (!(sendAt > now + MIN)) throw new BookingError(400, "Pick a time in the future.");
    if (sendAt > now + 366 * DAY) throw new BookingError(400, "That's more than a year away.");
  }
  // A scheduled email is checked again when it goes out, so their pause has to be over by then.
  const blocked = blockedReason(s, sendAt);
  if (blocked) throw new BookingError(409, scheduled && !s.no_email && !pauseAt(s, sendAt)?.forever ? `${blocked} Pick a later date.` : blocked);
  const warnings = warningsFor(await facts(env, s, now), firstOf(s.name), now);
  if (warnings.length && raw.force !== true) throw new BookingError(409, `${warnings.join(" ")} Send anyway?`);
  const email = await build(env, s, d, now);

  const id = crypto.randomUUID();
  const insert = (status: string, sentAt: number | null) => env.DB.prepare(
    `INSERT INTO nudge_emails (id, customer_id, template, subject, body, send_at, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(id, s.id, d.kind, d.subject, d.body, iso(sendAt), status, sentAt ? iso(sentAt) : null).run();
  if (scheduled) {
    await insert("scheduled", null);
    return { ok: true, scheduled: true, sendAt: iso(sendAt), message: `Scheduled for ${new Intl.DateTimeFormat("en-US", { timeZone: RULES.timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(sendAt)}.` };
  }
  if (!(await sendEmail(env, "student_nudge", null, email))) throw new BookingError(502, "The email couldn't be sent. Please try again.");
  await insert("sent", now);
  return { ok: true, scheduled: false, message: `Email sent to ${firstOf(s.name)}.` };
}

export async function adminCancelNudge(env: Env, nudgeId: string) {
  const r = await env.DB.prepare("UPDATE nudge_emails SET status = 'cancelled' WHERE id = ?1 AND status = 'scheduled'").bind(nudgeId).run();
  if (!r.meta.changes) throw new BookingError(409, "That email has already gone out or been cancelled.");
  return { ok: true };
}

export async function adminSetNoEmail(env: Env, customerId: string, value: unknown) {
  const s = await loadStudent(env, customerId);
  const on = value === true;
  await env.DB.batch([
    env.DB.prepare("UPDATE customers SET no_email = ?1 WHERE id = ?2").bind(on ? 1 : 0, s.id),
    // Turning it on also cancels what's waiting to go out.
    ...(on ? [env.DB.prepare("UPDATE nudge_emails SET status = 'cancelled' WHERE customer_id = ?1 AND status = 'scheduled'").bind(s.id)] : []),
  ]);
  return { ok: true, noEmail: on };
}

// Avery turns check-in emails back on after the student paused or unsubscribed (they asked her to, say).
export async function adminResubscribe(env: Env, customerId: string) {
  const s = await loadStudent(env, customerId);
  await env.DB.prepare("UPDATE customers SET email_paused_until = NULL, email_paused_at = NULL WHERE id = ?1").bind(s.id).run();
  return { ok: true };
}

/* ── The student's side: the page the link at the bottom of each email opens ── */

const CHOICES: Record<string, number> = { "30": 30, "60": 60, all: Infinity };

async function studentForLink(env: Env, c: unknown, t: unknown): Promise<Student> {
  const bad = new BookingError(404, "This link doesn't look right. Please use the link in your email, or reply to it and I'll take care of it.");
  if (!(await validUnsubscribeToken(env, c, t))) throw bad;
  return await loadStudent(env, c as string).catch(() => { throw bad; });
}

// What the page needs: their first name and what's already in effect.
const publicState = (s: Student, now: number) => {
  const p = s.no_email ? { forever: true, until: FOREVER } : pauseAt(s, now);
  return { firstName: firstOf(s.name), paused: !!p, forever: !!p?.forever, until: p && !p.forever ? p.until : null };
};

export async function unsubscribeView(env: Env, c: unknown, t: unknown, now: number) {
  return publicState(await studentForLink(env, c, t), now);
}

// A pause never gets shorter: choosing 30 days after choosing "all" leaves "all" in place.
export async function unsubscribeApply(env: Env, c: unknown, t: unknown, choice: unknown, now: number) {
  const s = await studentForLink(env, c, t);
  const days = typeof choice === "string" ? CHOICES[choice] : undefined;
  if (days === undefined) throw new BookingError(400, "Please choose one of the options.");
  const chosen = days === Infinity ? FOREVER : iso(now + days * DAY);
  const current = pauseAt(s, now)?.until ?? "";
  const until = chosen > current ? chosen : current;
  await env.DB.batch([
    env.DB.prepare("UPDATE customers SET email_paused_until = ?1, email_paused_at = ?2 WHERE id = ?3").bind(until, iso(now), s.id),
    // Anything already scheduled to go out during the pause is called off.
    env.DB.prepare("UPDATE nudge_emails SET status = 'cancelled', note = 'They paused or unsubscribed.' WHERE customer_id = ?1 AND status = 'scheduled' AND send_at < ?2").bind(s.id, until),
  ]);
  return publicState({ ...s, email_paused_until: until }, now);
}

// The last few for a student's profile.
export async function nudgeHistory(env: Env, customerId: string) {
  const rows = (await env.DB.prepare(
    "SELECT id, template, subject, send_at, status, note, sent_at FROM nudge_emails WHERE customer_id = ?1 ORDER BY send_at DESC LIMIT 10",
  ).bind(customerId).all<{ id: string; template: T.NudgeKind; subject: string | null; send_at: string; status: string; note: string | null; sent_at: string | null }>()).results;
  return rows.map((r) => ({
    id: r.id, label: T.NUDGE_LABELS[r.template], subject: r.subject,
    sendAt: r.send_at, status: r.status === "sending" ? "scheduled" : r.status, note: r.note, sentAt: r.status === "sent" ? r.sent_at : null,
  }));
}

/* ── Cron: send what's due ── */

export async function sendScheduledNudges(env: Env, now: number): Promise<number> {
  // A send that never finished (the worker stopped mid-way): don't guess, flag it.
  await env.DB.prepare(
    "UPDATE nudge_emails SET status = 'failed', note = 'Interrupted. Check your sent mail before sending again.' WHERE status = 'sending' AND sent_at < ?1",
  ).bind(iso(now - 30 * MIN)).run();

  const due = (await env.DB.prepare("SELECT id FROM nudge_emails WHERE status = 'scheduled' AND send_at <= ?1 ORDER BY send_at LIMIT 20").bind(iso(now)).all<{ id: string }>()).results;
  let sent = 0;
  for (const { id } of due) {
    // sent_at holds the time of the attempt while it's 'sending'.
    const claim = await env.DB.prepare("UPDATE nudge_emails SET status = 'sending', sent_at = ?1, attempts = attempts + 1 WHERE id = ?2 AND status = 'scheduled'").bind(iso(now), id).run();
    if (!claim.meta.changes) continue;
    const settle = (status: string, note: string | null, sentAt: number | null = null) =>
      env.DB.prepare("UPDATE nudge_emails SET status = ?1, note = ?2, sent_at = ?3 WHERE id = ?4").bind(status, note, sentAt ? iso(sentAt) : null, id).run();
    try {
      const n = (await env.DB.prepare("SELECT customer_id, template, subject, body, created_at FROM nudge_emails WHERE id = ?1").bind(id)
        .first<{ customer_id: string; template: T.NudgeKind; subject: string; body: string; created_at: string }>())!;
      const s = await loadStudent(env, n.customer_id);
      const f = await facts(env, s, now);
      const booked = await env.DB.prepare("SELECT 1 AS x FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND created_at > ?2 LIMIT 1").bind(s.id, n.created_at).first();
      const blocked = blockedReason(s, now);
      if (blocked) { await settle("skipped", s.no_email ? "Marked \"don't email\"." : "They paused or unsubscribed."); continue; }
      if (f.upcoming || booked) { await settle("skipped", "They have a session booked."); continue; }
      let email;
      try { email = await build(env, s, { kind: n.template, subject: n.subject, body: n.body }, now); }
      catch (err) { if (err instanceof BookingError) { await settle("skipped", err.message); continue; } throw err; }
      if (await sendEmail(env, "student_nudge", null, email)) { await settle("sent", null, now); sent++; continue; }
      throw new Error("The email couldn't be sent.");
    } catch (err) {
      const tries = (await env.DB.prepare("SELECT attempts FROM nudge_emails WHERE id = ?1").bind(id).first<{ attempts: number }>())?.attempts ?? MAX_TRIES;
      if (tries < MAX_TRIES) await env.DB.prepare("UPDATE nudge_emails SET status = 'scheduled', sent_at = NULL, send_at = ?1 WHERE id = ?2").bind(iso(now + 15 * MIN), id).run();
      else await env.DB.prepare("UPDATE nudge_emails SET status = 'failed', note = ?1, sent_at = NULL WHERE id = ?2").bind((err as Error).message.slice(0, 200), id).run();
    }
  }
  return sent;
}
