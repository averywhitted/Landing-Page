import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { allowedPage } from "./env";
import { SERVICES, findService } from "./services";
import { RULES } from "./settings";
import { calendarFor } from "./calendar";
import { openSlots } from "./availability";
import { zonedToUtc } from "./time";
import { scheduling } from "./config";
import wordmark from "../assets/email-wordmark.png";
import { HEADING_BYTES } from "./email-headings";
import { verifyWebhook, type CheckoutSession } from "./stripe";
import {
  BookingError, afterConfirm, cancelBooking, confirmPaid, createBooking, expireHolds, manageView, publicStatus,
  releaseForSession, rescheduleBooking, retryConfirmations, sendReminders,
  sendSessionReminders, runRetention, checkAlerts, retryRefunds, cleanUpCancelled, claimedBlocks,
} from "./bookings";
import { validManageToken } from "./manage";
import {
  adminCancelPackage, adminPackageCancelPreview,
  afterPackage, bookWithCredit, cancelPackage, confirmPackage, createPackagePurchase, expirePendingPackages, packagePublicStatus,
  packageView, releasePackageForSession, retryPackageEmails, sendBundleReminders, sendExpiryNotices,
} from "./packages";
import { isPaid, promoCodeUsed } from "./stripe";
import {
  adminCancelGroup, adminCheckTime, adminCreateSession, adminMove, adminRemind, adminRemindStudent, adminResendInvite, adminStudentDetail, adminStudents, maintainGroups, recordPayment,
  releaseUnpaid, sendPaymentReminders, startPayment,
} from "./sessions";
import {
  adminAdjustCredits, adminCalendar, adminCancelBooking, adminExtendPackage, adminGetSettings, adminOverview,
  adminResetSettings, adminSaveSettings, requireAdmin,
} from "./admin";
import adminHtml from "../admin/index.html";
import adminJs from "../admin/app.js.txt";

const app = new Hono<{ Bindings: Env }>();

// Only averywhitted.com may call the API from a browser (plus copies of the
// pages served from this Mac or the home network while testing).
app.use("/api/*", cors({
  origin: (origin, c) => {
    try {
      const u = new URL(origin);
      return allowedPage(c.env, u.protocol, u.hostname) ? origin : null;
    } catch {
      return null;
    }
  },
  allowMethods: ["GET", "POST"],
  maxAge: 86400,
}));

app.get("/", (c) => c.text("Hello from the averywhitted.com booking service."));

// The "AVERY WHITTED" wordmark (in Horizon) shown at the top of every email.
app.get("/email/wordmark.png", () => new Response(wordmark, {
  headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
}));

// Email headings drawn in Horizon (see tools/render-headings.html).
app.get("/email/h/:file", (c) => {
  const file = c.req.param("file");
  const bytes = Object.hasOwn(HEADING_BYTES, file) ? HEADING_BYTES[file] : undefined;
  if (!bytes) return c.notFound();
  return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
});

// Public list of services and prices, read from services.ts.
// Bundles include how long they're valid for, so the page never hard-codes it.
app.get("/api/services", async (c) => {
  const validDays = (await scheduling(c.env)).packageValidDays;
  return c.json(SERVICES.map((s) => (s.kind === "bundle" ? { ...s, validDays } : s)));
});

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
  // Only from yesterday to a year ahead, so nobody can make it look up
  // arbitrary dates in the calendar over and over.
  const fromMs = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!(fromMs >= Date.now() - 2 * 86400000 && fromMs <= Date.now() + 366 * 86400000)) {
    return c.json({ error: "Please pick a date within the next year." }, 400);
  }

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

  const cfg = await scheduling(c.env);
  let busy;
  try {
    busy = await calendarFor(c.env, cfg).getBusy(from, to);
  } catch (err) {
    console.error("availability: calendar lookup failed:", (err as Error).message);
    return c.json({ error: "Availability is temporarily unavailable. Please try again shortly." }, 503);
  }

  // When rescheduling (?b=&t= from the manage link), the booking being moved
  // shouldn't block times next to itself.
  const moving = (await validManageToken(c.env, c.req.query("b"), c.req.query("t")))
    ? await c.env.DB.prepare("SELECT id, ics_uid FROM bookings WHERE id = ?1").bind(c.req.query("b")).first<{ id: string; ics_uid: string }>()
    : null;
  if (moving) busy = busy.filter((b) => b.uid !== moving.ics_uid);

  // Blocks already taken by confirmed bookings, unexpired holds, and group sessions.
  const claimed = await claimedBlocks(c.env, from - 86400000, to + 86400000, now, moving?.id);

  const slots = openSlots({ durationMinutes: service.durationMinutes, from, to, now, busy, claimed, rules: cfg });
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
// free intro chats are confirmed right away.
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
  const result = valid(session) ? (await publicStatus(c.env, "session", session!)) ?? (await packagePublicStatus(c.env, session!))
    : valid(booking) ? await publicStatus(c.env, "booking", booking!)
    : null;
  if (!result) return c.json({ error: "Booking not found." }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(result);
});

// Client self-service from the private link in their emails.
function bookingErrorResponse(c: any, err: unknown) {
  if (err instanceof BookingError) return c.json({ error: err.message }, err.status);
  console.error("manage: unexpected error:", (err as Error).message);
  return c.json({ error: "Something went wrong. Please try again, or email info@averywhitted.com." }, 500);
}

app.get("/api/manage", async (c) => {
  try {
    c.header("Cache-Control", "no-store");
    return c.json(await manageView(c.env, c.req.query("b"), c.req.query("t"), Date.now()));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/manage/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(await cancelBooking(c.env, body.b, body.t, { now: Date.now(), waitUntil: (p) => c.executionCtx.waitUntil(p) }));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/manage/reschedule", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(await rescheduleBooking(c.env, body.b, body.t, body.start, { now: Date.now(), waitUntil: (p) => c.executionCtx.waitUntil(p) }));
  } catch (err) { return bookingErrorResponse(c, err); }
});

// After Avery cancels a paid session: the student picks a new time (no charge) or a refund.
app.post("/api/manage/rebook", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const { rebookCancelled } = await import("./bookings");
    return c.json(await rebookCancelled(c.env, body.b, body.t, body.start, { now: Date.now(), waitUntil: (p) => c.executionCtx.waitUntil(p) }));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/manage/refund", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const { refundCancelled } = await import("./bookings");
    return c.json(await refundCancelled(c.env, body.b, body.t, { now: Date.now(), waitUntil: (p) => c.executionCtx.waitUntil(p) }));
  } catch (err) { return bookingErrorResponse(c, err); }
});

// A student asking for a refund they can't get online (Avery decides).
app.post("/api/refund-requests", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const { studentRefundRequest } = await import("./refunds");
    return c.json(await studentRefundRequest(c.env, body, Date.now()), 201);
  } catch (err) { return bookingErrorResponse(c, err); }
});

// A student stops their sessions repeating (from the manage page).
app.post("/api/series/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try { const { studentStopSeries } = await import("./series"); return c.json(await studentStopSeries(c.env, body.b, body.t, Date.now())); }
  catch (err) { return bookingErrorResponse(c, err); }
});

// Paying a payment request Avery sent (the "Pay" link in that email).
app.post("/api/pay-request", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const { startRequestPayment } = await import("./requests");
    return c.json(await startRequestPayment(c.env, body.b, body.t, body.r, Date.now()));
  } catch (err) { return bookingErrorResponse(c, err); }
});

// Paying for a session Avery booked (the "Pay" link in the invite).
app.post("/api/pay", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(await startPayment(c.env, body.b, body.t, Date.now()));
  } catch (err) { return bookingErrorResponse(c, err); }
});

// Bundles: buy one, view the bundle page, book a session with a credit.
app.post("/api/packages", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await createPackagePurchase(c.env, body, { ip: c.req.header("cf-connecting-ip") ?? "local", now: Date.now() }), 201);
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.get("/api/packages", async (c) => {
  try {
    c.header("Cache-Control", "no-store");
    return c.json(await packageView(c.env, c.req.query("p"), c.req.query("t"), Date.now()));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/packages/book", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(await bookWithCredit(c.env, body.p, body.t, body.start, body.focus, { now: Date.now(), waitUntil: (p) => c.executionCtx.waitUntil(p) }), 201);
  } catch (err) { return bookingErrorResponse(c, err); }
});

/* ── Admin (book.averywhitted.com/admin), behind Cloudflare Access ── */

const ADMIN_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://averywhitted.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

async function adminPage(c: any, body: string, type: string) {
  try {
    await requireAdmin(c.env, c.req.raw);
  } catch (err) {
    return c.text((err as Error).message, 403, ADMIN_HEADERS);
  }
  return c.body(body, 200, { ...ADMIN_HEADERS, "Content-Type": type });
}
app.get("/admin", (c) => adminPage(c, adminHtml, "text/html; charset=utf-8"));
app.get("/admin/", (c) => c.redirect("/admin", 301));
app.get("/admin/app.js", (c) => adminPage(c, adminJs, "text/javascript; charset=utf-8"));

// Every admin API call: must come from the admin page itself, and carry a valid Access pass.
app.use("/api/admin/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (c.req.header("X-Admin") !== "1" || (origin && origin !== new URL(c.req.url).origin)) {
    return c.json({ error: "Forbidden." }, 403, ADMIN_HEADERS);
  }
  try {
    await requireAdmin(c.env, c.req.raw);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 403, ADMIN_HEADERS);
  }
  for (const [k, v] of Object.entries(ADMIN_HEADERS)) c.header(k, v);
  await next();
});

app.get("/api/admin/overview", async (c) => c.json(await adminOverview(c.env, Date.now())));

app.post("/api/admin/bookings/:id/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(await adminCancelBooking(c.env, c.req.param("id"), {
      notifyClient: body.notifyClient === true, returnCredit: body.returnCredit === true, refund: body.refund === true,
      note: typeof body.note === "string" ? body.note : undefined,
    }, { now: Date.now(), waitUntil: (p) => c.executionCtx.waitUntil(p) }));
  } catch (err) { return bookingErrorResponse(c, err); }
});

// Refund any amount of a session or bundle (e.g. a goodwill refund after it happened).
for (const kind of ["bookings", "packages"] as const) {
  app.post(`/api/admin/${kind}/:id/refund`, async (c) => {
    const body = await jsonBody(c);
    try {
      const { adminRefundAmount } = await import("./refunds");
      return c.json(await adminRefundAmount(c.env, kind === "bookings" ? "booking" : "package", c.req.param("id"), body.amountCents,
        { notifyClient: body.notifyClient !== false, message: typeof body.message === "string" ? body.message : "" }, Date.now()));
    } catch (err) { return bookingErrorResponse(c, err); }
  });
}

// A repeating session held because it clashes with Avery's calendar: keep it (sends the invite).
app.post("/api/admin/bookings/:id/keep", async (c) => {
  try { const { adminKeepHeld } = await import("./series"); return c.json(await adminKeepHeld(c.env, c.req.param("id"), Date.now())); }
  catch (err) { return bookingErrorResponse(c, err); }
});

// Payment requests for a session (send, remind, withdraw).
app.post("/api/admin/payment-requests", async (c) => {
  const body = await jsonBody(c);
  try { const { adminCreateRequest } = await import("./requests"); return c.json(await adminCreateRequest(c.env, body, Date.now()), 201); }
  catch (err) { return bookingErrorResponse(c, err); }
});
app.post("/api/admin/payment-requests/:id/remind", async (c) => {
  try { const { adminRemindRequest } = await import("./requests"); return c.json(await adminRemindRequest(c.env, c.req.param("id"), Date.now())); }
  catch (err) { return bookingErrorResponse(c, err); }
});
app.post("/api/admin/payment-requests/:id/cancel", async (c) => {
  try { const { adminCancelRequest } = await import("./requests"); return c.json(await adminCancelRequest(c.env, c.req.param("id"), Date.now())); }
  catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/series/:id/stop", async (c) => {
  const body = await jsonBody(c);
  try { const { stopSeries } = await import("./series"); return c.json(await stopSeries(c.env, c.req.param("id"), "admin", Date.now(), body.notifyClient !== false)); }
  catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/refund-requests/:id/decline", async (c) => {
  const body = await jsonBody(c);
  try {
    const { adminDeclineRefundRequest } = await import("./refunds");
    return c.json(await adminDeclineRefundRequest(c.env, c.req.param("id"), typeof body.message === "string" ? body.message : "", Date.now()));
  } catch (err) { return bookingErrorResponse(c, err); }
});

// Booking students from the admin page.
const ctxOf = (c: any) => ({ now: Date.now(), waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) });
const jsonBody = async (c: any) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

app.get("/api/admin/students", async (c) => c.json(await adminStudents(c.env, Date.now())));

app.get("/api/admin/students/:id", async (c) => {
  try { return c.json(await adminStudentDetail(c.env, c.req.param("id"), Date.now())); } catch (err) { return bookingErrorResponse(c, err); }
});

app.get("/api/admin/packages/:id/cancel", async (c) => {
  try { return c.json(await adminPackageCancelPreview(c.env, c.req.param("id"), Date.now())); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/packages/:id/cancel", async (c) => {
  const body = await jsonBody(c);
  try {
    return c.json(await adminCancelPackage(c.env, c.req.param("id"), { refundCents: Number(body.refundCents), notifyClient: body.notifyClient === true }, ctxOf(c)));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/check-time", async (c) => {
  try { return c.json(await adminCheckTime(c.env, await jsonBody(c), Date.now())); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/sessions", async (c) => {
  try { return c.json(await adminCreateSession(c.env, await jsonBody(c), ctxOf(c)), 201); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/bookings/:id/move", async (c) => {
  try { return c.json(await adminMove(c.env, { bookingId: c.req.param("id") }, await jsonBody(c), ctxOf(c))); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/groups/:id/move", async (c) => {
  try { return c.json(await adminMove(c.env, { groupId: c.req.param("id") }, await jsonBody(c), ctxOf(c))); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/groups/:id/cancel", async (c) => {
  const body = await jsonBody(c);
  try {
    return c.json(await adminCancelGroup(c.env, c.req.param("id"), { notifyClient: body.notifyClient === true, refund: body.refund === true }, ctxOf(c)));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/bookings/:id/remind", async (c) => {
  try { return c.json(await adminRemind(c.env, c.req.param("id"), Date.now())); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/students/:id/remind", async (c) => {
  try { return c.json(await adminRemindStudent(c.env, c.req.param("id"), Date.now())); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/students/:id/notes", async (c) => {
  const body = await jsonBody(c);
  try { const { adminSaveNotes } = await import("./extras"); return c.json(await adminSaveNotes(c.env, c.req.param("id"), body.notes, Date.now())); }
  catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/bookings/:id/attendance", async (c) => {
  const body = await jsonBody(c);
  try { const { adminSetAttendance } = await import("./extras"); return c.json(await adminSetAttendance(c.env, c.req.param("id"), body.noShow === true, Date.now())); }
  catch (err) { return bookingErrorResponse(c, err); }
});

app.get("/api/admin/export", async (c) => {
  try {
    const { adminExport } = await import("./extras");
    return c.body(await adminExport(c.env, c.req.query("from"), c.req.query("to")), 200, { "Content-Type": "text/csv; charset=utf-8" });
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/clear-test-data", async (c) => {
  const body = await jsonBody(c);
  try { const { clearTestData } = await import("./extras"); return c.json(await clearTestData(c.env, body.confirm)); }
  catch (err) { return bookingErrorResponse(c, err); }
});

app.get("/api/admin/backup", async (c) => {
  const { backupJson } = await import("./extras");
  return c.body(await backupJson(c.env, Date.now()), 200, { "Content-Type": "application/json; charset=utf-8" });
});

app.get("/api/admin/calendar", async (c) => {
  try { return c.json(await adminCalendar(c.env, c.req.query("from"), c.req.query("to"), Date.now())); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/bookings/:id/resend", async (c) => {
  try { return c.json(await adminResendInvite(c.env, c.req.param("id"))); } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/packages/:id/credits", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const notify = body.notifyClient === true ? { message: typeof body.message === "string" ? body.message : "" } : undefined;
    return c.json(await adminAdjustCredits(c.env, c.req.param("id"), Number(body.delta), typeof body.note === "string" ? body.note : "", Date.now(), notify));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.get("/api/admin/settings", async (c) => c.json(await adminGetSettings(c.env)));

app.post("/api/admin/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const who = await requireAdmin(c.env, c.req.raw);
    return c.json(await adminSaveSettings(c.env, body, who));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/settings/reset", async (c) => c.json(await adminResetSettings(c.env)));

// A new iCloud app-specific password (tested, then stored encrypted; see secrets.ts).
app.post("/api/admin/icloud-password", async (c) => {
  const body = await jsonBody(c);
  try {
    const who = await requireAdmin(c.env, c.req.raw);
    const { adminUpdateIcloudPassword } = await import("./admin");
    return c.json(await adminUpdateIcloudPassword(c.env, body.password, who, Date.now()));
  } catch (err) { return bookingErrorResponse(c, err); }
});
app.post("/api/admin/icloud-password/reset", async (c) => {
  try {
    const who = await requireAdmin(c.env, c.req.raw);
    const { adminResetIcloudPassword } = await import("./admin");
    return c.json(await adminResetIcloudPassword(c.env, who, Date.now()));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/admin/packages/:id/extend", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const notify = body.notifyClient === true ? { message: typeof body.message === "string" ? body.message : "" } : undefined;
    return c.json(await adminExtendPackage(c.env, c.req.param("id"), Number(body.days), Date.now(), notify));
  } catch (err) { return bookingErrorResponse(c, err); }
});

app.post("/api/packages/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(await cancelPackage(c.env, body.p, body.t, { now: Date.now(), waitUntil: (p) => c.executionCtx.waitUntil(p) }));
  } catch (err) { return bookingErrorResponse(c, err); }
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
      if (isPaid(s)) {
        const promo = await promoCodeUsed(c.env, s.id);
        if (s.metadata?.purpose === "payment") {
          await recordPayment(c.env, s, now, promo);
        } else if (s.metadata?.purpose === "request") {
          await (await import("./requests")).recordRequestPayment(c.env, s, now);
        } else if (s.metadata?.package_id) {
          const id = await confirmPackage(c.env, s, now, promo);
          if (id) c.executionCtx.waitUntil(afterPackage(c.env, id));
        } else {
          const id = await confirmPaid(c.env, s, now, promo);
          if (id) c.executionCtx.waitUntil(afterConfirm(c.env, id));
        }
      }
    } else if (event.type === "checkout.session.expired") {
      await releaseForSession(c.env, String(event.data.object.id), now);
      await releasePackageForSession(c.env, String(event.data.object.id), now);
    } else if (event.type === "charge.refunded") {
      // Record how much has been refunded; "refunded" (in full) only once it all has.
      const pi = event.data.object.payment_intent;
      const refunded = Number(event.data.object.amount_refunded ?? 0);
      const whole = event.data.object.refunded === true;
      if (typeof pi === "string") {
        // A cancelled bundle counts as refunded once the refund due has gone out.
        for (const [table, target] of [["bookings", "amount_cents"], ["packages", "COALESCE(refund_due_cents, amount_cents)"]]) {
          await c.env.DB.prepare(
            `UPDATE ${table} SET refunded_cents = MAX(refunded_cents, ?1),
               refunded_at = CASE WHEN ?3 = 1 OR MAX(refunded_cents, ?1) >= ${target} THEN COALESCE(refunded_at, ?2) ELSE refunded_at END
             WHERE stripe_payment_intent_id = ?4`,
          ).bind(refunded, new Date(now).toISOString(), whole ? 1 : 0, pi).run();
        }
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
// Each job is isolated so one failing doesn't stop the others.
async function scheduled(env: Env): Promise<void> {
  const now = Date.now();
  const run = async <T>(name: string, job: () => Promise<T>): Promise<T | null> => {
    try { return await job(); } catch (err) { console.error(`cron ${name} failed:`, (err as Error).message); return null; }
  };
  const holds = await run("holds", () => expireHolds(env, now));
  const bundles = await run("bundle checkouts", () => expirePendingPackages(env, now));
  const expiring = await run("bundle expiry notices", () => sendExpiryNotices(env, now));
  const checkout = await run("checkout reminders", () => sendReminders(env, now));
  await run("bundle checkout reminders", () => sendBundleReminders(env, now));
  const session = await run("session reminders", () => sendSessionReminders(env, now));
  const retried = await run("retries", () => retryConfirmations(env, now));
  const refunds = await run("refund retries", () => retryRefunds(env, now));
  const unpaid = await run("unpaid deadlines", () => releaseUnpaid(env, now));
  await run("payment reminders", () => sendPaymentReminders(env, now));
  await run("group sessions", () => maintainGroups(env, now));
  const series = await import("./series");
  const repeats = await run("repeating sessions", () => series.bookNextSessions(env, now));
  await run("abandoned repeats", () => series.dropAbandonedSeries(env, now));
  const undecided = await run("held repeats", () => series.releaseUndecided(env, now));
  const extras = await import("./extras");
  await run("icloud health", () => extras.checkCalendarHealth(env, now));
  await run("backup", () => extras.nightlyBackup(env, now));
  await run("cancelled cleanup", () => cleanUpCancelled(env, now));
  await run("bundle email retries", () => retryPackageEmails(env, now));
  const cleaned = await run("retention", () => runRetention(env, now));
  const alerts = await run("alerts", () => checkAlerts(env, now));
  const summary = { released: holds?.released, lateConfirmed: holds?.confirmed, bundles, expiring, checkout, session, retried, refunds, unpaid, repeats, undecided, cleaned, alerts: alerts?.length };
  if (Object.values(summary).some((v) => v)) console.log("cron:", JSON.stringify(summary));
}

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(scheduled(env)); },
};
