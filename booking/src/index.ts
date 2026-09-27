import { Hono } from "hono";
import { SERVICES, findService } from "./services";
import { RULES } from "./settings";
import { getBusy, type ICloudEnv } from "./icloud";
import { openSlots } from "./availability";
import { zonedToUtc } from "./time";

type Env = ICloudEnv & { DB: D1Database };

const app = new Hono<{ Bindings: Env }>();

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
  if (cached) return cached;

  const from = zonedToUtc(+m[1], +m[2], +m[3], 0, 0, RULES.timeZone);
  const to = from + days * 86400000;
  const now = Date.now();

  let busy;
  try {
    busy = await getBusy(c.env, from, to);
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
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

export default app;
