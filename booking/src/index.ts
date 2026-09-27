import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { SERVICES, findService } from "./services";
import { RULES } from "./settings";
import { calendarFor } from "./calendar";
import { openSlots } from "./availability";
import { zonedToUtc } from "./time";
import { verifyWebhook, type CheckoutSession } from "./stripe";
import {
  BookingError, afterConfirm, confirmPaid, createBooking, expireHolds, publicStatus,
  releaseForSession, retryConfirmations, sendReminders,
} from "./bookings";

const app = new Hono<{ Bindings: Env }>();

// Only averywhitted.com (and local previews on this Mac) may call the API from a browser.
const ALLOWED_ORIGINS = ["https://averywhitted.com", "https://www.averywhitted.com"];
app.use("/api/*", cors({
  origin: (origin) =>
    ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null,
  allowMethods: ["GET", "POST"],
  maxAge: 86400,
}));

app.get("/", (c) => c.text("Hello from the averywhitted.com booking service."));

// Public list of services and prices, read from services.ts.
app.get("/api/services", (c) => c.json(SERVICES));

// Quick check that the service can reach its database.
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, database: "connected" });
  } catch {
    return c.json({ ok: false, database: "unreachable" }, 500);
  }
});

// Open start times for a session.
//   /api/availability?service=coaching-60&from=2026-10-01&days=7
// `from` is a date in Avery's time zone; results are UTC times the page
// converts to the client's own zone for display.
app.get("/api/availability", async (c) => {
  const service = findService(c.req.query("service") ?? "");
  if (!service || service.kind === "bundle") return c.json({ error: "Unknown session type." }, 400);

  const fromParam = c.req.query("from") ?? "";
  const m = fromParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return c.json({ error: "from must be a date like 2026-10-01." }, 400);
  const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "7", 10) || 7, 1), RULES.maxDaysPerRequest);

  // Serve a recent answer for the same question from Cloudflare's cache for
  // up to 60 seconds, so heavy traffic doesn't hammer iCloud. Bookings are
  // re-checked live before any slot is held.
  const cache = caches.default;
  const cacheKey = new Request(new URL(c.req.url).toString());
  const cached = await cache.match(cacheKey);
  // Rebuild through Hono so this request's own CORS headers are applied.
  if (cached) return c.newResponse(cached.body, 200, Object.fromEntries(cached.headers));

  const from = zonedToUtc(+m[1], +m[2], +m[3], 0, 0, RULES.timeZone);
  const to = from + days * 86400000;
  const now = Date.now();

  let busy;
  try {
    busy = await calendarFor(c.env).getBusy(from, to);
  } catch (err) {
    console.error("availability: calendar lookup failed:", (err as Error).message);
    return c.json({ error: "Availability is temporarily unavailable. Please try again shortly." }, 503);
  }

  // Blocks already taken by confirmed bookings or unexpired holds.
  const rows = await c.env.DB.prepare(
    `SELECT sc.slot_start FROM slot_claims sc JOIN bookings b ON b.id = sc.booking_id
     WHERE sc.slot_start >= ?1 AND sc.slot_start < ?2
       AND (b.status = 'confirmed' OR (b.status = 'held' AND b.hold_expires_at > ?3))`,
  ).bind(new Date(from - 86400000).toISOString(), new Date(to + 86400000).toISOString(), new Date(now).toISOString())
    .all<{ slot_start: string }>();
  const claimed = new Set(rows.results.map((r) => r.slot_start));

  const slots = openSlots({ durationMinutes: service.durationMinutes, from, to, now, busy, claimed });
  const farAhead = to > now + RULES.farAheadNoticeDays * 86400000;

  const res = c.json({
    service: service.id,
    durationMinutes: service.durationMinutes,
    timeZone: RULES.timeZone,
    slots,
    ...(farAhead && { notice: "Sessions booked more than two months ahead may need to be rescheduled." }),
  });
  res.headers.set("Cache-Control", "public, max-age=60");
  // Cache a copy without CORS headers; those depend on who is asking.
  const toCache = new Response(res.clone().body, res);
  for (const h of [...toCache.headers.keys()]) if (h.startsWith("access-control-")) toCache.headers.delete(h);
  c.executionCtx.waitUntil(cache.put(cacheKey, toCache));
  return res;
});

// Submit the booking form. Paid sessions get a Stripe checkout link;
// free intro calls are confirmed right away.
app.post("/api/bookings", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid request." }, 400); }
  try {
    const result = await createBooking(c.env, body, {
      ip: c.req.header("cf-connecting-ip") ?? "local",
      now: Date.now(),
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof BookingError) return c.json({ error: err.message }, err.status);
    console.error("bookings: unexpected error:", (err as Error).message);
    return c.json({ error: "Something went wrong. Please try again." }, 500);
  }
});

// What the confirmation page shows: /api/confirmation?session_id=... or ?booking=...
app.get("/api/confirmation", async (c) => {
  const session = c.req.query("session_id");
  const booking = c.req.query("booking");
  const valid = (v?: string) => !!v && /^[\w-]{8,200}$/.test(v);
  const result = valid(session) ? await publicStatus(c.env, "session", session!)
    : valid(booking) ? await publicStatus(c.env, "booking", booking!)
    : null;
  if (!result) return c.json({ error: "Booking not found." }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(result);
});

// Stripe's notifications. Signed, checked, and handled once each.
app.post("/api/stripe/webhook", async (c) => {
  const raw = await c.req.text();
  const ok = await verifyWebhook(raw, c.req.header("stripe-signature") ?? null, c.env.STRIPE_WEBHOOK_SECRET ?? "");
  if (!ok) return c.text("Invalid signature", 400);

  const event = JSON.parse(raw) as { id: string; type: string; data: { object: Record<string, unknown> } };
  const first = await c.env.DB.prepare("INSERT OR IGNORE INTO processed_webhooks (stripe_event_id) VALUES (?1)").bind(event.id).run();
  if (!first.meta.changes) return c.json({ received: true, duplicate: true });

  const now = Date.now();
  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as unknown as CheckoutSession;
      if (s.payment_status === "paid") {
        const id = await confirmPaid(c.env, s, now);
        if (id) c.executionCtx.waitUntil(afterConfirm(c.env, id));
      }
    } else if (event.type === "checkout.session.expired") {
      await releaseForSession(c.env, String(event.data.object.id), now);
    } else if (event.type === "charge.refunded") {
      const pi = event.data.object.payment_intent;
      if (typeof pi === "string") {
        await c.env.DB.prepare("UPDATE bookings SET refunded_at = COALESCE(refunded_at, ?1) WHERE stripe_payment_intent_id = ?2")
          .bind(new Date(now).toISOString(), pi).run();
      }
    }
  } catch (err) {
    // Let Stripe retry: forget that we saw this event.
    await c.env.DB.prepare("DELETE FROM processed_webhooks WHERE stripe_event_id = ?1").bind(event.id).run();
    console.error(`webhook ${event.type} failed:`, (err as Error).message);
    return c.text("Temporary error", 500);
  }
  return c.json({ received: true });
});

// Every 5 minutes: release unpaid holds, send reminders, retry failed follow-ups.
async function scheduled(env: Env): Promise<void> {
  const now = Date.now();
  const holds = await expireHolds(env, now);
  const reminders = await sendReminders(env, now);
  const retried = await retryConfirmations(env, now);
  if (holds.released || holds.confirmed || reminders || retried) {
    console.log(`cron: released ${holds.released}, late-confirmed ${holds.confirmed}, reminders ${reminders}, retried ${retried}`);
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(scheduled(env)); },
};
