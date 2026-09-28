// Talks to Stripe's API directly (no extra library needed).
// Card details never touch this service: clients pay on Stripe's own page.

import type { Env } from "./env";
import { usingFakes } from "./env";

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

async function stripe<T>(env: Env, method: "GET" | "POST", path: string, data?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  const res = await fetch(`${apiBase(env)}/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
    },
    body: data ? formEncode(data).join("&") : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string } };
  if (!res.ok) {
    const err = new Error(`Stripe ${path} failed (${res.status}): ${body.error?.message ?? "unknown error"}`) as Error & { code?: string };
    err.code = body.error?.code;
    throw err;
  }
  return body;
}

export type CheckoutSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: string;
  payment_intent: string | null;
  amount_total: number | null;
  metadata: Record<string, string>;
};

export function createCheckoutSession(env: Env, p: {
  bookingId: string;            // the booking's id, or the bundle's id when kind is "package"
  kind?: "booking" | "package";
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
    customer_email: p.email,
    client_reference_id: p.bookingId,
    // Stripe allows either a pre-applied code or the "Add promotion code" box, not both.
    ...(p.promotionCodeId ? { discounts: { 0: { promotion_code: p.promotionCodeId } } } : { allow_promotion_codes: "true" }),
    expires_at: Math.floor(p.expiresAt / 1000),
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: p.amountCents, product_data: { name: p.productName, description: p.description } } } },
    metadata: p.kind === "package" ? { package_id: p.bookingId } : { booking_id: p.bookingId },
    payment_intent_data: {
      metadata: p.kind === "package" ? { package_id: p.bookingId } : { booking_id: p.bookingId },
      description: `${p.productName}, ${p.description}`,
    },
  }, `checkout-${p.bookingId}`);
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

// Ends an unpaid checkout early. Returns the session's final state.
export async function expireCheckoutSession(env: Env, sessionId: string): Promise<CheckoutSession> {
  try {
    return await stripe<CheckoutSession>(env, "POST", `checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
  } catch (err) {
    // Already finished (paid or expired): report its real state instead.
    return stripe<CheckoutSession>(env, "GET", `checkout/sessions/${encodeURIComponent(sessionId)}`);
  }
}

export function refundPayment(env: Env, paymentIntentId: string, bookingId: string) {
  return stripe<{ id: string; status: string }>(env, "POST", "refunds", {
    payment_intent: paymentIntentId,
    metadata: { booking_id: bookingId },
  }, `refund-${bookingId}`);
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
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > 300) return false;

  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  return sigs.some((s) => safeEqual(s, expected));
}
