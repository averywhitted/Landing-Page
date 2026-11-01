// Talks to Stripe's API directly (no extra library needed).
// Card details never touch this service: clients pay on Stripe's own page.

import type { Env } from "./env";
import { usingFakes } from "./env";
import { logEvent } from "./events";

function apiBase(env: Env): string {
  // Only local tests may point at a fake Stripe.
  return usingFakes(env) && env.STRIPE_API_BASE ? env.STRIPE_API_BASE.replace(/\/$/, "") : "https://api.stripe.com";
}

// Stripe expects form-encoded bodies with bracketed keys: line_items[0][quantity]=1
function formEncode(data: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe<T>(env: Env, method: "GET" | "POST" | "DELETE", path: string, data?: Record<string, unknown>, idempotencyKey?: string, version?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  const res = await fetch(`${apiBase(env)}/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      ...(version && { "Stripe-Version": version }),
    },
    body: data ? formEncode(data).join("&") : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string } };
  // Only what matters goes in the log: money-moving calls, and every failure
  // (except "not found" lookups, which are routine).
  const what = method === "POST" && path === "refunds" ? "refund" : method === "POST" && path === "checkout/sessions" ? "checkout page" : null;
  if (!res.ok && res.status !== 404) await logEvent(env, "stripe", "error", `Stripe refused ${method} ${path.split("?")[0].replace(/\/cs_[^/]+/, "")} (${res.status}): ${body.error?.message ?? "unknown error"}`);
  else if (res.ok && what) await logEvent(env, "stripe", "ok", what === "refund" ? "Sent a refund to Stripe" : "Created a checkout page");
  if (!res.ok) {
    const err = new Error(`Stripe ${path} failed (${res.status}): ${body.error?.message ?? "unknown error"}`) as Error & { code?: string; status?: number };
    err.code = body.error?.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

// "paid", or "no_payment_required" when a promo code covered the whole price.
export const isPaid = (s: { payment_status: string }) => s.payment_status === "paid" || s.payment_status === "no_payment_required";

export type CheckoutSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: string;
  payment_intent: string | null;
  amount_total: number | null;
  expires_at?: number;     // seconds
  metadata: Record<string, string>;
};

export function createCheckoutSession(env: Env, p: {
  bookingId: string;            // the booking's id, or the bundle's id when kind is "package"
  // booking: a client booking a time; package: buying a bundle;
  // payment: paying for a session Avery booked for them
  kind?: "booking" | "package" | "payment" | "request";
  requestId?: string;           // kind "request": the payment request being paid
  idempotencyKey?: string;
  email: string;
  productName: string;
  description: string;
  amountCents: number;
  expiresAt: number;       // ms
  successUrl: string;
  cancelUrl: string;
  promotionCodeId?: string;     // pre-applied promo code (from a ?promo= link)
}): Promise<CheckoutSession> {
  return stripe<CheckoutSession>(env, "POST", "checkout/sessions", {
    mode: "payment",
    payment_method_types: { 0: "card" },
    customer_email: p.email,
    client_reference_id: p.bookingId,
    // Stripe allows either a pre-applied code or the "Add promotion code" box, not both.
    ...(p.promotionCodeId ? { discounts: { 0: { promotion_code: p.promotionCodeId } } } : { allow_promotion_codes: "true" }),
    expires_at: Math.floor(p.expiresAt / 1000),
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: p.amountCents, product_data: { name: p.productName, description: p.description } } } },
    metadata: metadataFor(p),
    payment_intent_data: {
      metadata: metadataFor(p),
      description: `${p.productName}, ${p.description}`,
    },
  }, p.idempotencyKey ?? `checkout-${p.bookingId}`);
}

const metadataFor = (p: { kind?: string; bookingId: string; requestId?: string }) =>
  p.kind === "package" ? { package_id: p.bookingId }
  : p.kind === "request" ? { booking_id: p.bookingId, request_id: p.requestId ?? "", purpose: "request" }
  : p.kind === "payment" ? { booking_id: p.bookingId, purpose: "payment" }
  : { booking_id: p.bookingId };

export function getCheckoutSession(env: Env, sessionId: string): Promise<CheckoutSession> {
  return stripe<CheckoutSession>(env, "GET", `checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// Turns a code a client arrived with (e.g. ?promo=SPRING20) into Stripe's id
// for it. Returns null if it doesn't exist, is inactive, or the key can't look
// codes up (needs the "Promotion Codes: Read" permission).
export async function lookupPromotionCode(env: Env, code: unknown): Promise<string | null> {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{2,40}$/.test(code)) return null;
  try {
    const res = await stripe<{ data: { id: string }[] }>(env, "GET", `promotion_codes?code=${encodeURIComponent(code)}&active=true&limit=1`);
    return res.data[0]?.id ?? null;
  } catch (err) {
    console.warn("stripe: promo lookup failed:", (err as Error).message);
    return null;
  }
}

// Which promo code (if any) was used on a finished checkout, for the records.
export async function promoCodeUsed(env: Env, sessionId: string): Promise<string | null> {
  try {
    const s = await stripe<{ total_details?: { breakdown?: { discounts?: { discount?: { promotion_code?: string | { code?: string } | null } }[] } } }>(
      env, "GET", `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=total_details.breakdown`);
    const promo = s.total_details?.breakdown?.discounts?.[0]?.discount?.promotion_code;
    if (!promo) return null;
    if (typeof promo === "object") return promo.code ?? null;
    const pc = await stripe<{ code: string }>(env, "GET", `promotion_codes/${encodeURIComponent(promo)}`);
    return pc.code ?? null;
  } catch (err) {
    console.warn("stripe: couldn't read promo code used:", (err as Error).message);
    return null;
  }
}

// ── Promo codes made from the admin page ──
// Each is a Stripe coupon (the discount, once per purchase) with one
// promotion code (the word students type). These calls name an API version
// because newer versions moved the coupon inside a "promotion" field; pinned,
// the request and reply shapes stay the same whatever the account's default.
// The key needs Coupons and Promotion Codes set to Write.

const PROMO_API_VERSION = "2024-06-20";

type StripePromo = {
  id: string; code: string; active: boolean; created: number; times_redeemed: number;
  max_redemptions: number | null; expires_at: number | null; metadata?: Record<string, string>;
  coupon: { id: string; percent_off: number | null; amount_off: number | null; valid: boolean };
};

export type PromoCode = {
  id: string; code: string; active: boolean; createdAt: number; timesUsed: number;
  maxUses: number | null; expiresAt: number | null; percentOff: number | null; amountOffCents: number | null;
  note: string | null; fromAdmin: boolean;
};

const promoView = (p: StripePromo): PromoCode => ({
  id: p.id, code: p.code, active: p.active && p.coupon.valid, createdAt: p.created * 1000, timesUsed: p.times_redeemed,
  maxUses: p.max_redemptions, expiresAt: p.expires_at ? p.expires_at * 1000 : null,
  percentOff: p.coupon.percent_off, amountOffCents: p.coupon.amount_off,
  note: p.metadata?.note || null, fromAdmin: p.metadata?.created_by === "admin",
});

// The newest 100 (made here or in Stripe's dashboard).
export async function listPromotionCodes(env: Env): Promise<PromoCode[]> {
  const res = await stripe<{ data: StripePromo[] }>(env, "GET", "promotion_codes?limit=100", undefined, undefined, PROMO_API_VERSION);
  return res.data.map(promoView);
}

export async function createPromotionCode(env: Env, p: {
  code: string; percentOff?: number; amountOffCents?: number; maxUses?: number; expiresAt?: number; note?: string;
}): Promise<PromoCode> {
  const coupon = await stripe<{ id: string }>(env, "POST", "coupons", {
    ...(p.percentOff ? { percent_off: p.percentOff } : { amount_off: p.amountOffCents, currency: "usd" }),
    duration: "once",
    name: p.code,
    metadata: { created_by: "admin" },
  }, undefined, PROMO_API_VERSION);
  try {
    const promo = await stripe<StripePromo>(env, "POST", "promotion_codes", {
      coupon: coupon.id,
      code: p.code,
      max_redemptions: p.maxUses,
      expires_at: p.expiresAt ? Math.floor(p.expiresAt / 1000) : undefined,
      metadata: { created_by: "admin", note: p.note || undefined },
    }, undefined, PROMO_API_VERSION);
    await logEvent(env, "stripe", "ok", `Made promo code ${p.code}`);
    return promoView(promo);
  } catch (err) {
    // No code to go with it: don't leave the coupon lying around in Stripe.
    await stripe(env, "DELETE", `coupons/${encodeURIComponent(coupon.id)}`, undefined, undefined, PROMO_API_VERSION).catch(() => {});
    throw err;
  }
}

// Turning a code off stops new checkouts using it; it can be turned back on.
export async function setPromotionCodeActive(env: Env, id: string, active: boolean): Promise<PromoCode> {
  const promo = await stripe<StripePromo>(env, "POST", `promotion_codes/${encodeURIComponent(id)}`, { active: String(active) }, undefined, PROMO_API_VERSION);
  return promoView(promo);
}

// Ends an unpaid checkout early. Returns the session's final state.
// Stripe refuses to expire one that's already finished (paid, or its hour ran
// out), and that refusal would show as a Stripe error, so it looks first.
export async function expireCheckoutSession(env: Env, sessionId: string): Promise<CheckoutSession> {
  const path = `checkout/sessions/${encodeURIComponent(sessionId)}`;
  const now = await stripe<CheckoutSession>(env, "GET", path);
  if (now.status !== "open") return now;
  try {
    return await stripe<CheckoutSession>(env, "POST", `${path}/expire`, {});
  } catch (err) {
    // Finished in the moment between: report its real state instead.
    return stripe<CheckoutSession>(env, "GET", path);
  }
}

// Refunds one payment in full. Keyed by the payment, so the same payment is
// never refunded twice (and Stripe refuses a second refund of it anyway).
export function refundPayment(env: Env, paymentIntentId: string, bookingId: string, amountCents?: number, idempotencyKey?: string) {
  return stripe<{ id: string; status: string }>(env, "POST", "refunds", {
    payment_intent: paymentIntentId,
    ...(amountCents !== undefined && { amount: amountCents }), // part of it; otherwise all of it
    metadata: { booking_id: bookingId },
  }, idempotencyKey ?? `refund-${paymentIntentId}`);
}

// ── Webhook signatures ──
// Stripe signs each notification with the webhook secret. We recompute the
// signature and refuse anything that doesn't match or is over 5 minutes old.

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhook(rawBody: string, header: string | null, secret: string, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > 300) return false;

  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  return sigs.some((s) => safeEqual(s, expected));
}
