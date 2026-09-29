// Editing and deleting a student from the admin's Students section.
//
// Deleting removes the student and their records from THIS booking database
// only. Nothing is deleted at Stripe, Resend, Zoom or on the iCloud calendar.
// It's refused while anything is still live (upcoming sessions, money owed or
// on its way back, a usable bundle, open requests), so a delete can never
// strand a payment or leave a session on the calendar with no owner.

import type { Env } from "./env";
import { iso } from "./time";
import { BookingError, clean, refreshCalendarEvent } from "./bookings";

const MIN = 60000;

/* ── Edit ── */

export async function adminEditStudent(env: Env, customerId: string, raw: Record<string, unknown>, now: number) {
  const name = clean(raw.name, 100);
  const email = clean(raw.email, 200).toLowerCase();
  const pronouns = clean(raw.pronouns, 40);
  if (!name) throw new BookingError(400, "Please enter a name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BookingError(400, "Please check the email address.");

  const current = await env.DB.prepare("SELECT id, email FROM customers WHERE id = ?1").bind(customerId).first<{ id: string; email: string }>();
  if (!current) throw new BookingError(404, "Student not found.");
  const clash = await env.DB.prepare("SELECT id, name FROM customers WHERE email = ?1 AND id <> ?2").bind(email, customerId).first<{ id: string; name: string }>();
  if (clash) throw new BookingError(409, `${clash.name} already has that email address. Two students can't share one.`);
  const aliasClash = await env.DB.prepare("SELECT c.name FROM customer_aliases a JOIN customers c ON c.id = a.customer_id WHERE a.email = ?1 AND a.customer_id <> ?2").bind(email, customerId).first<{ name: string }>();
  if (aliasClash) throw new BookingError(409, `${aliasClash.name} used to have that email address. Two students can't share one.`);

  // The name and pronouns are also copied onto each booking and bundle (so a later
  // booking can't rename old ones); update those copies so the change shows everywhere.
  await env.DB.batch([
    env.DB.prepare("UPDATE customers SET name = ?1, email = ?2, pronouns = ?3 WHERE id = ?4").bind(name, email, pronouns || null, customerId),
    env.DB.prepare("UPDATE bookings SET client_name = ?1, client_pronouns = ?2 WHERE customer_id = ?3").bind(name, pronouns || null, customerId),
    env.DB.prepare("UPDATE packages SET client_name = ?1, client_pronouns = ?2 WHERE customer_id = ?3").bind(name, pronouns || null, customerId),
    env.DB.prepare("UPDATE series SET client_name = ?1, client_pronouns = ?2 WHERE customer_id = ?3").bind(name, pronouns || null, customerId),
    // The old address keeps pointing at this student, so booking with it later doesn't create a duplicate.
    env.DB.prepare("DELETE FROM customer_aliases WHERE email = ?1").bind(email),
    ...(current.email.toLowerCase() !== email
      ? [env.DB.prepare("INSERT OR IGNORE INTO customer_aliases (email, customer_id) VALUES (?1, ?2)").bind(current.email, customerId)]
      : []),
  ]);

  // Upcoming calendar events carry the student's name.
  const upcoming = await env.DB.prepare(
    "SELECT id FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND start_utc > ?2 AND group_id IS NULL LIMIT 20",
  ).bind(customerId, iso(now)).all<{ id: string }>();
  for (const { id } of upcoming.results) await refreshCalendarEvent(env, id);

  return { ok: true, emailChanged: current.email.toLowerCase() !== email };
}

/* ── Delete ── */

type Count = { n: number };
const count = async (env: Env, sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<Count>())?.n ?? 0;

// What's in the way, and what would be removed.
export async function adminDeletePreview(env: Env, customerId: string, now: number) {
  const c = await env.DB.prepare("SELECT id, name FROM customers WHERE id = ?1").bind(customerId).first<{ id: string; name: string }>();
  if (!c) throw new BookingError(404, "Student not found.");
  const t = iso(now);

  const upcoming = await count(env, "SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND end_utc > ?2", customerId, t);
  const holds = await count(env, "SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?1 AND status = 'held' AND hold_expires_at > ?2", customerId, t);
  const owed = await count(env, `SELECT COALESCE(SUM(price_cents), 0) AS n FROM bookings WHERE customer_id = ?1 AND status = 'confirmed'
    AND price_cents IS NOT NULL AND price_cents > 0 AND paid_at IS NULL AND package_id IS NULL`, customerId);
  const requests = await count(env, "SELECT COUNT(*) AS n FROM payment_requests WHERE customer_id = ?1 AND status = 'open'", customerId);
  const refundAsks = await count(env, "SELECT COUNT(*) AS n FROM refund_requests WHERE customer_id = ?1 AND status = 'open'", customerId);
  const refundsOut = await count(env, `SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?1 AND refund_requested_at IS NOT NULL AND refunded_at IS NULL`, customerId)
    + await count(env, `SELECT COUNT(*) AS n FROM packages WHERE customer_id = ?1 AND status = 'cancelled' AND COALESCE(refund_due_cents, 0) > 0 AND refunded_at IS NULL`, customerId);
  const bundles = await count(env, `SELECT COUNT(*) AS n FROM packages WHERE customer_id = ?1 AND status = 'active' AND credits_used < credits_total AND expires_at > ?2`, customerId, t);
  const pendingBundles = await count(env, `SELECT COUNT(*) AS n FROM packages WHERE customer_id = ?1 AND status = 'pending' AND created_at > ?2`, customerId, iso(now - 2 * 60 * MIN));
  const repeating = await count(env, "SELECT COUNT(*) AS n FROM series WHERE customer_id = ?1 AND status IN ('pending', 'active')", customerId);

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const blockers: string[] = [];
  if (upcoming) blockers.push(`${plural(upcoming, "upcoming session")}. Cancel ${upcoming === 1 ? "it" : "them"} first.`);
  if (holds) blockers.push("A booking is in the middle of checkout. Try again in half an hour.");
  if (pendingBundles) blockers.push("A bundle purchase is in the middle of checkout. Try again in a couple of hours.");
  if (owed) blockers.push(`They owe $${(owed / 100).toFixed(2)} for sessions. Collect it or cancel those sessions first.`);
  if (requests) blockers.push(`${plural(requests, "open payment request")}. Withdraw ${requests === 1 ? "it" : "them"} first.`);
  if (refundAsks) blockers.push(`${plural(refundAsks, "refund request")} waiting for your answer.`);
  if (refundsOut) blockers.push(`${plural(refundsOut, "refund")} still on the way to them. Wait until ${refundsOut === 1 ? "it has" : "they have"} gone through.`);
  if (bundles) blockers.push(`${plural(bundles, "bundle")} with unused sessions. Cancel ${bundles === 1 ? "it" : "them"} (with a refund if that's right) or use the sessions up.`);
  if (repeating) blockers.push("A repeating booking is still running. Stop it first.");

  const sessions = await count(env, "SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?1", customerId);
  const cancelled = await count(env, "SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?1 AND status = 'cancelled'", customerId);
  const paid = await count(env, "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM bookings WHERE customer_id = ?1 AND package_id IS NULL", customerId)
    + await count(env, "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM packages WHERE customer_id = ?1 AND stripe_payment_intent_id IS NOT NULL", customerId)
    + await count(env, "SELECT COALESCE(SUM(paid_cents), 0) AS n FROM payment_requests WHERE customer_id = ?1 AND status = 'paid'", customerId);
  const bundleCount = await count(env, "SELECT COUNT(*) AS n FROM packages WHERE customer_id = ?1 AND status IN ('active', 'cancelled')", customerId);
  const requestsTotal = await count(env, "SELECT COUNT(*) AS n FROM payment_requests WHERE customer_id = ?1", customerId);

  return {
    id: c.id, name: c.name, blockers,
    removes: { sessions, cancelledSessions: cancelled, bundles: bundleCount, paymentRequests: requestsTotal, paidCents: paid },
  };
}

export async function adminDeleteStudent(env: Env, customerId: string, confirm: unknown, now: number) {
  const preview = await adminDeletePreview(env, customerId, now);
  if (preview.blockers.length) throw new BookingError(409, `This student can't be deleted yet: ${preview.blockers[0]}`);
  if (confirm !== "DELETE") throw new BookingError(400, "Type DELETE to confirm.");

  const mine = "(SELECT id FROM bookings WHERE customer_id = ?1)";
  const myPackages = "(SELECT id FROM packages WHERE customer_id = ?1)";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM slot_claims WHERE booking_id IN ${mine}`).bind(customerId),
    env.DB.prepare(`DELETE FROM email_log WHERE booking_id IN ${mine}`).bind(customerId),
    env.DB.prepare(`DELETE FROM credit_ledger WHERE package_id IN ${myPackages} OR booking_id IN ${mine}`).bind(customerId),
    env.DB.prepare("DELETE FROM payment_requests WHERE customer_id = ?1").bind(customerId),
    env.DB.prepare("DELETE FROM refund_requests WHERE customer_id = ?1").bind(customerId),
    env.DB.prepare("DELETE FROM bookings WHERE customer_id = ?1").bind(customerId),
    env.DB.prepare("DELETE FROM packages WHERE customer_id = ?1").bind(customerId),
    env.DB.prepare("DELETE FROM series WHERE customer_id = ?1").bind(customerId),
    env.DB.prepare("DELETE FROM customer_aliases WHERE customer_id = ?1").bind(customerId),
    env.DB.prepare("DELETE FROM duplicate_ignores WHERE a_id = ?1 OR b_id = ?1").bind(customerId),
    env.DB.prepare("DELETE FROM customers WHERE id = ?1").bind(customerId),
  ]);
  // Groups whose every seat is gone.
  await env.DB.prepare("DELETE FROM groups WHERE id NOT IN (SELECT group_id FROM bookings WHERE group_id IS NOT NULL)").run();
  return { ok: true, name: preview.name };
}

/* ── Duplicates: find, merge, or mark "not the same person" ── */

// "Jamie Q. Rivera" and "jamie rivera" -> "jamie rivera" (first and last word only, no accents or punctuation).
const nameKey = (name: string) => {
  const words = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  return words.length ? `${words[0]} ${words.length > 1 ? words[words.length - 1] : ""}`.trim() : "";
};
// jamie.r+coaching@gmail.com and jamier@gmail.com are the same inbox at Gmail.
const emailKey = (email: string) => {
  const [local, domain] = email.toLowerCase().split("@");
  if (!domain) return email.toLowerCase();
  const base = local.split("+")[0];
  return /^(gmail|googlemail)\.com$/.test(domain) ? `${base.replace(/\./g, "")}@gmail.com` : `${base}@${domain}`;
};

type Person = { id: string; name: string; email: string; pronouns: string | null; created_at: string; sessions: number; upcoming: number; bundles: number; paid: number };

const pairKey = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

export async function adminDuplicates(env: Env, now: number) {
  const people = (await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.pronouns, c.created_at,
       (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status IN ('confirmed', 'cancelled')) AS sessions,
       (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.end_utc > ?1) AS upcoming,
       (SELECT COUNT(*) FROM packages p WHERE p.customer_id = c.id AND p.status = 'active') AS bundles,
       (SELECT COALESCE(SUM(b.amount_cents), 0) FROM bookings b WHERE b.customer_id = c.id AND b.package_id IS NULL)
         + (SELECT COALESCE(SUM(p.amount_cents), 0) FROM packages p WHERE p.customer_id = c.id AND p.stripe_payment_intent_id IS NOT NULL) AS paid
     FROM customers c
     WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.status IN ('confirmed', 'cancelled'))
        OR EXISTS (SELECT 1 FROM packages p WHERE p.customer_id = c.id AND p.status IN ('active', 'cancelled') AND p.cancel_reason IS NOT 'checkout_expired')`,
  ).bind(iso(now)).all<Person>()).results;
  const ignored = new Set((await env.DB.prepare("SELECT a_id, b_id FROM duplicate_ignores").all<{ a_id: string; b_id: string }>()).results.map((r) => `${r.a_id}|${r.b_id}`));

  // Link people who share a name or an inbox, then gather the linked ones into groups.
  const parent = new Map(people.map((p) => [p.id, p.id]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const reasons = new Map<string, Set<string>>();
  const link = (a: Person, b: Person, why: string) => {
    if (ignored.has(pairKey(a.id, b.id).join("|"))) return;
    parent.set(find(a.id), find(b.id));
    for (const id of [a.id, b.id]) { if (!reasons.has(id)) reasons.set(id, new Set()); reasons.get(id)!.add(why); }
  };
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i], b = people[j];
      if (nameKey(a.name) && nameKey(a.name) === nameKey(b.name)) link(a, b, "the same name");
      if (emailKey(a.email) === emailKey(b.email)) link(a, b, "the same email apart from dots or +tags");
    }
  }
  const groups = new Map<string, Person[]>();
  for (const p of people) {
    if (!reasons.has(p.id)) continue;
    const root = find(p.id);
    groups.set(root, [...(groups.get(root) ?? []), p]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const members = [...g].sort((x, y) => y.sessions - x.sessions || x.created_at.localeCompare(y.created_at));
    return {
      id: members.map((m) => m.id).sort().join(","),
      why: [...new Set(members.flatMap((m) => [...(reasons.get(m.id) ?? [])]))],
      // Suggested one to keep: the one with the most history.
      keepId: members[0].id,
      members: members.map((m) => ({
        id: m.id, name: m.name, email: m.email, pronouns: m.pronouns, since: m.created_at,
        sessions: m.sessions, upcoming: m.upcoming, bundles: m.bundles, paidCents: m.paid,
      })),
    };
  });
}

const idList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : []);

export async function adminIgnoreDuplicates(env: Env, idsRaw: unknown) {
  const ids = idList(idsRaw);
  if (ids.length < 2 || ids.length > 12) throw new BookingError(400, "Pick the students that are not duplicates.");
  const stmts = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const [a, b] = pairKey(ids[i], ids[j]);
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO duplicate_ignores (a_id, b_id) VALUES (?1, ?2)").bind(a, b));
  }
  await env.DB.batch(stmts);
  return { ok: true };
}

// Fold the others into `keepId`: their sessions, bundles, repeats and requests move over,
// their notes are added to the kept student's, and their email addresses stay linked to the
// kept student so booking with one later doesn't make a new duplicate.
export async function adminMergeStudents(env: Env, keepId: unknown, mergeRaw: unknown, now: number) {
  const mergeIds = idList(mergeRaw).filter((id) => id !== keepId);
  if (typeof keepId !== "string" || !mergeIds.length || mergeIds.length > 11) throw new BookingError(400, "Pick who to keep and who to merge into them.");
  const keep = await env.DB.prepare("SELECT id, name, pronouns, notes FROM customers WHERE id = ?1").bind(keepId).first<{ id: string; name: string; pronouns: string | null; notes: string | null }>();
  if (!keep) throw new BookingError(404, "Student not found.");
  const others = [];
  for (const id of mergeIds) {
    const o = await env.DB.prepare("SELECT id, name, email, pronouns, notes FROM customers WHERE id = ?1").bind(id).first<{ id: string; name: string; email: string; pronouns: string | null; notes: string | null }>();
    if (!o) throw new BookingError(404, "One of those students no longer exists. Refresh and try again.");
    others.push(o);
  }

  let notes = keep.notes ?? "";
  let pronouns = keep.pronouns;
  const stmts = [];
  for (const o of others) {
    if (o.notes) notes = `${notes}${notes ? "\n\n" : ""}From ${o.name} (${o.email}):\n${o.notes}`;
    pronouns = pronouns || o.pronouns;
    for (const t of ["bookings", "packages", "series", "payment_requests", "refund_requests"]) {
      stmts.push(env.DB.prepare(`UPDATE ${t} SET customer_id = ?1 WHERE customer_id = ?2`).bind(keepId, o.id));
    }
    stmts.push(
      env.DB.prepare("UPDATE customer_aliases SET customer_id = ?1 WHERE customer_id = ?2").bind(keepId, o.id),
      env.DB.prepare("INSERT OR IGNORE INTO customer_aliases (email, customer_id) VALUES (?1, ?2)").bind(o.email, keepId),
      env.DB.prepare("DELETE FROM duplicate_ignores WHERE a_id = ?1 OR b_id = ?1").bind(o.id),
      env.DB.prepare("DELETE FROM customers WHERE id = ?1").bind(o.id),
    );
  }
  // Their bookings and bundles now show the kept student's name (the copy on each record).
  for (const t of ["bookings", "packages", "series"]) {
    stmts.push(env.DB.prepare(`UPDATE ${t} SET client_name = ?1, client_pronouns = ?2 WHERE customer_id = ?3`).bind(keep.name, pronouns, keepId));
  }
  stmts.push(env.DB.prepare("UPDATE customers SET notes = ?1, pronouns = ?2 WHERE id = ?3").bind(notes.slice(0, 5000) || null, pronouns, keepId));
  await env.DB.batch(stmts);

  const upcoming = await env.DB.prepare(
    "SELECT id FROM bookings WHERE customer_id = ?1 AND status = 'confirmed' AND start_utc > ?2 AND group_id IS NULL LIMIT 20",
  ).bind(keepId, iso(now)).all<{ id: string }>();
  for (const { id } of upcoming.results) await refreshCalendarEvent(env, id);
  return { ok: true, merged: others.length, name: keep.name };
}
