// The admin's connection status lights: one per outside service, each with a
// plain-English summary. Green = working, amber = worth a look, red = broken,
// grey = nothing to report yet. Live checks are remembered for 5 minutes so
// the admin page refreshing itself doesn't keep pinging Stripe and friends.

import type { Env } from "./env";
import { isLiveSite, usingFakes } from "./env";
import { BookingError } from "./bookings";
import { SERVICES, logEvent, recentEvents, type Service } from "./events";
import { iso } from "./time";

const MIN = 60000;
const HOUR = 60 * MIN;

export type Light = "ok" | "warn" | "error" | "idle";
export type ServiceStatus = { id: Service; label: string; light: Light; summary: string; details: string[]; lastEventAt: string | null };

type Probe = { light: Light; summary: string; details?: string[] };

const withTimeout = async <T>(p: Promise<T>, ms = 6000): Promise<T> => {
  let timer: any;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("no answer after 6 seconds")), ms); })]);
  } finally { clearTimeout(timer); }
};

const ago = (at: string | null, now: number) => {
  if (!at) return "never";
  const m = Math.max(0, Math.round((now - Date.parse(at)) / MIN));
  if (m < 2) return "just now";
  if (m < 90) return `${m} minutes ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} hours ago`;
  return `${Math.round(m / 1440)} days ago`;
};

/* ── One live check per service ── */

async function probeStripe(env: Env, now: number): Promise<Probe> {
  if (usingFakes(env)) return { light: "ok", summary: "Test stand-in (local)" };
  if (!env.STRIPE_SECRET_KEY) return { light: "error", summary: "No Stripe key is set." };
  const res = await withTimeout(fetch("https://api.stripe.com/v1/checkout/sessions?limit=1", { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }));
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "";
    return { light: "error", summary: res.status === 401 ? "Stripe rejected the key. It may have been rolled or deleted." : `Stripe answered with an error (${res.status}).`, details: msg ? [msg] : [] };
  }
  const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY);
  const hook = await env.DB.prepare("SELECT MAX(processed_at) AS at FROM processed_webhooks").first<{ at: string | null }>();
  const details = [`Key works (${live ? "live" : "test"} mode).`, `Last webhook from Stripe: ${ago(hook?.at ?? null, now)}.`];
  if (isLiveSite(env) && !live) return { light: "warn", summary: "The live site is using a Stripe test key.", details };
  if (!isLiveSite(env) && live) return { light: "warn", summary: "A live Stripe key is set on a test copy of the site.", details };
  return { light: "ok", summary: `Connected (${live ? "live" : "test"} mode)`, details };
}

async function probeResend(env: Env, now: number): Promise<Probe> {
  if (usingFakes(env)) return { light: "ok", summary: "Test stand-in (local)" };
  if (!env.RESEND_API_KEY) return { light: "error", summary: "No Resend key is set. No emails can go out." };
  // A key that can only send mail gets a polite refusal here, which still proves the key is real.
  const res = await withTimeout(fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } }));
  const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
  const keyOk = res.ok || (res.status === 401 && body.name === "restricted_api_key");
  const recent = await env.DB.prepare(
    "SELECT status, error, created_at FROM email_log WHERE kind <> 'attention_alert' ORDER BY id DESC LIMIT 5",
  ).all<{ status: string; error: string | null; created_at: string }>();
  const last = recent.results[0];
  const details = [keyOk ? "Key works." : "Resend rejected the key.", last ? `Last email attempt: ${last.status}, ${ago(last.created_at, now)}.` : "No emails sent yet."];
  if (!keyOk) return { light: "error", summary: "Resend rejected the key. No emails can go out.", details };
  if (recent.results.length >= 2 && recent.results.slice(0, 2).every((r) => r.status === "failed")) {
    return { light: "error", summary: "The last emails failed to send.", details: [...details, last.error ?? ""] };
  }
  if (last?.status === "failed") return { light: "warn", summary: "The latest email failed to send.", details: [...details, last.error ?? ""] };
  return { light: "ok", summary: "Connected", details };
}

async function probeIcloud(env: Env, now: number): Promise<Probe> {
  const h = await env.DB.prepare("SELECT failing_since, last_error, last_ok FROM health WHERE key = 'icloud'")
    .first<{ failing_since: string | null; last_error: string | null; last_ok: string | null }>();
  if (!h) return { light: "idle", summary: "Not checked yet (it's checked every 5 minutes)." };
  const details = [`Last successful check: ${ago(h.last_ok, now)}.`];
  if (h.failing_since) return { light: "error", summary: `Can't read your calendar (since ${ago(h.failing_since, now)}).`, details: [...details, h.last_error ?? ""] };
  if (h.last_ok && Date.parse(h.last_ok) < now - 20 * MIN) return { light: "warn", summary: "The calendar hasn't been checked in a while.", details };
  return { light: "ok", summary: "Connected", details };
}

async function probeZoom(env: Env): Promise<Probe> {
  if (usingFakes(env)) return { light: "ok", summary: "Test stand-in (local)" };
  const { zoomConfigured, zoomPing } = await import("./zoom");
  if (!zoomConfigured(env)) return { light: "warn", summary: "Zoom isn't connected. Sessions use the fallback link or none." };
  await withTimeout(zoomPing(env));
  return { light: "ok", summary: "Connected", details: ["Signing in to Zoom works."] };
}

async function probeDatabase(env: Env): Promise<Probe> {
  const t = Date.now();
  await withTimeout(env.DB.prepare("SELECT 1").first());
  const ms = Date.now() - t;
  return { light: ms > 1500 ? "warn" : "ok", summary: ms > 1500 ? "Working, but slow." : "Working", details: [`Answered in ${ms} ms.`] };
}

async function probeBackups(env: Env, now: number): Promise<Probe> {
  if (!env.BACKUPS) return { light: "error", summary: "No backup storage is connected." };
  const h = await env.DB.prepare("SELECT last_ok FROM health WHERE key = 'backup'").first<{ last_ok: string | null }>();
  if (!h?.last_ok) return { light: "warn", summary: "No backup has run yet (one runs each night)." };
  const age = now - Date.parse(h.last_ok);
  const details = [`Last backup: ${ago(h.last_ok, now)}.`, "Kept for 30 days."];
  if (age > 50 * HOUR) return { light: "error", summary: "Backups have stopped. The last one is more than 2 days old.", details };
  if (age > 26 * HOUR) return { light: "warn", summary: "Last night's backup hasn't run yet.", details };
  return { light: "ok", summary: "Backed up", details };
}

async function probeTurnstile(env: Env, now: number): Promise<Probe> {
  const blocked = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM integration_events WHERE service = 'turnstile' AND level = 'warn' AND created_at > ?1",
  ).bind(iso(now - 24 * HOUR)).first<{ n: number }>();
  const details = [`${blocked?.n ?? 0} booking${blocked?.n === 1 ? "" : "s"} blocked in the last 24 hours.`];
  if (usingFakes(env)) return { light: "ok", summary: "Test stand-in (local)" };
  if (!env.TURNSTILE_SECRET_KEY) return { light: "warn", summary: "Off: bookings aren't being bot-checked.", details };
  // A made-up answer: Cloudflare says "invalid response" when the secret is right, "invalid secret" when it isn't.
  const res = await withTimeout(fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: "status-check" }).toString(),
  }));
  const codes = ((await res.json().catch(() => ({}))) as { "error-codes"?: string[] })["error-codes"] ?? [];
  if (codes.includes("invalid-input-secret")) return { light: "error", summary: "Cloudflare rejected the Turnstile secret. Real bookings will be blocked.", details };
  return { light: "ok", summary: "Connected", details };
}

const PROBES: Record<Service, (env: Env, now: number) => Promise<Probe>> = {
  stripe: probeStripe, icloud: probeIcloud, resend: probeResend, zoom: probeZoom, database: probeDatabase, backups: probeBackups, turnstile: probeTurnstile,
};

/* ── Putting it together ── */

const cache = new Map<Service, { at: number; probe: Probe }>();
export function forgetStatusCache() { cache.clear(); }

async function checked(env: Env, id: Service, now: number, fresh: boolean): Promise<Probe> {
  const hit = cache.get(id);
  if (!fresh && hit && now - hit.at < 5 * MIN) return hit.probe;
  let probe: Probe;
  try { probe = await PROBES[id](env, now); }
  catch (err) { probe = { light: "error", summary: `Couldn't check: ${(err as Error).message}` }; }
  // Log when the picture changes, so the log tells the story without a line per page load.
  const before = cache.get(id)?.probe.light;
  if (probe.light === "error" && before !== "error" && !["icloud"].includes(id)) await logEvent(env, id, "error", probe.summary);
  else if (before === "error" && probe.light === "ok" && id !== "icloud") await logEvent(env, id, "ok", "Working again");
  cache.set(id, { at: now, probe });
  return probe;
}

export async function allStatuses(env: Env, now: number, fresh = false): Promise<ServiceStatus[]> {
  return Promise.all(SERVICES.map(async ({ id, label }): Promise<ServiceStatus> => {
    const probe = await checked(env, id, now, fresh);
    const last = await env.DB.prepare(
      "SELECT level, created_at FROM integration_events WHERE service = ?1 AND level IN ('ok', 'error') ORDER BY id DESC LIMIT 1",
    ).bind(id).first<{ level: string; created_at: string }>();
    // A healthy check still turns amber if the last real thing that happened failed.
    let light = probe.light, summary = probe.summary;
    if (light === "ok" && last?.level === "error" && id !== "database") {
      light = "warn"; summary = "Connected, but the last thing it tried failed. Open the log.";
    }
    return { id, label, light, summary, details: (probe.details ?? []).filter(Boolean), lastEventAt: last?.created_at ?? null };
  }));
}

export async function serviceDetail(env: Env, idRaw: unknown, now: number) {
  const service = SERVICES.find((s) => s.id === idRaw);
  if (!service) throw new BookingError(404, "Unknown connection.");
  const [status] = (await allStatuses(env, now)).filter((s) => s.id === service.id);
  return { ...status, events: await recentEvents(env, service.id, 150) };
}

// "Check now": a fresh live check, recorded in the log.
export async function checkNow(env: Env, idRaw: unknown, now: number) {
  const service = SERVICES.find((s) => s.id === idRaw);
  if (!service) throw new BookingError(404, "Unknown connection.");
  if (service.id === "icloud") await (await import("./extras")).checkCalendarHealth(env, now);
  const probe = await checked(env, service.id, now, true);
  await logEvent(env, service.id, probe.light === "error" ? "error" : probe.light === "warn" ? "warn" : "info", `Checked by hand: ${probe.summary}`);
  return serviceDetail(env, service.id, now);
}

// Backups: make one right now.
export async function backupNow(env: Env, now: number) {
  if (!env.BACKUPS) throw new BookingError(409, "No backup storage is connected.");
  try { await (await import("./extras")).nightlyBackup(env, now, true); }
  catch (err) { await logEvent(env, "backups", "error", `Backup failed: ${(err as Error).message}`); throw new BookingError(502, "The backup didn't work. See the log."); }
  forgetStatusCache();
  return serviceDetail(env, "backups", now);
}

// Resend: send Avery a short test message.
export async function testEmail(env: Env, now: number) {
  const { sendEmail } = await import("./email");
  const ok = await sendEmail(env, "status_test", null, {
    to: env.ADMIN_EMAIL, subject: "Test email from your booking admin",
    text: "This is a test from the status page. If you can read it, email is working.",
    html: "<p>This is a test from the status page. If you can read it, email is working.</p>",
  });
  forgetStatusCache();
  if (!ok) throw new BookingError(502, "The test email couldn't be sent. See the log.");
  return serviceDetail(env, "resend", now);
}
