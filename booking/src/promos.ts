// Promo codes, made and switched off from the admin page (Settings > Promo codes).
// Stripe keeps them; nothing is stored here. A code works at checkout for
// anything paid by card: sessions, bundles, and payment links Avery sends.
// Students type it in Stripe's "Add promotion code" box, or arrive with it
// already applied from a ?promo= link.

import type { Env } from "./env";
import { RULES } from "./settings";
import { zonedToUtc } from "./time";
import * as stripe from "./stripe";
import { BookingError, clean } from "./bookings";

const CODE = /^[A-Za-z0-9_-]{2,40}$/;   // same rule as lookupPromotionCode

// Stripe's refusals, in words Avery can act on.
function explain(err: unknown): never {
  if (err instanceof BookingError) throw err;
  const e = err as Error & { status?: number };
  if (e.status === 401 || e.status === 403) {
    throw new BookingError(502, "The booking site's Stripe key isn't allowed to manage promo codes yet. In Stripe: Developers > API keys > the booking site's restricted key > Edit, set Coupons and Promotion codes to Write, then save.");
  }
  if (/already exists/i.test(e.message)) throw new BookingError(409, "There's already a code with that name that's on. Pick another name, or turn the old one off first.");
  if (e.status === 400) throw new BookingError(400, `Stripe said no: ${e.message.replace(/^Stripe [^:]+: /, "")}`);
  throw new BookingError(502, "Couldn't reach Stripe. Try again in a minute.");
}

export async function adminListPromos(env: Env) {
  try { return { codes: await stripe.listPromotionCodes(env) }; } catch (err) { explain(err); }
}

export async function adminCreatePromo(env: Env, b: Record<string, unknown>, now: number) {
  const code = String(b.code ?? "").trim();
  if (!CODE.test(code)) throw new BookingError(400, "Codes are 2 to 40 letters, numbers, dashes or underscores (no spaces).");

  let percentOff: number | undefined, amountOffCents: number | undefined;
  if (b.kind === "percent") {
    percentOff = Number(b.percentOff);
    if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) throw new BookingError(400, "Enter a whole percentage from 1 to 100.");
  } else if (b.kind === "amount") {
    amountOffCents = Math.round(Number(b.amountOffCents));
    if (!Number.isInteger(amountOffCents) || amountOffCents < 100 || amountOffCents > 100000) throw new BookingError(400, "Enter an amount off from $1 to $1,000.");
  } else throw new BookingError(400, "Pick percent off or dollars off.");

  let maxUses: number | undefined;
  if (b.maxUses !== undefined && b.maxUses !== null && b.maxUses !== "") {
    maxUses = Number(b.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) throw new BookingError(400, "Uses must be a whole number from 1 to 10,000, or left blank for no limit.");
  }

  // "Last day" means it works until the end of that day, Eastern time.
  let expiresAt: number | undefined;
  if (b.lastDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.lastDay));
    if (!m) throw new BookingError(400, "Pick the last day it works.");
    expiresAt = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]) + 1, 0, 0, RULES.timeZone) - 1000;
    if (expiresAt <= now) throw new BookingError(400, "The last day has to be today or later.");
    if (expiresAt > now + 5 * 365 * 86400000) throw new BookingError(400, "The last day can be up to 5 years from now.");
  }

  const note = clean(b.note, 200, true) || undefined;
  try {
    const promo = await stripe.createPromotionCode(env, { code, percentOff, amountOffCents, maxUses, expiresAt, note });
    return { code: promo, message: `Made ${promo.code}. Students can use it at checkout now.` };
  } catch (err) { explain(err); }
}

export async function adminSetPromoActive(env: Env, id: string, active: unknown) {
  if (!/^promo_[A-Za-z0-9]+$/.test(id)) throw new BookingError(404, "That code wasn't found.");
  if (typeof active !== "boolean") throw new BookingError(400, "Say whether to turn it on or off.");
  try {
    const promo = await stripe.setPromotionCodeActive(env, id, active);
    return { code: promo, message: active ? `${promo.code} is on again.` : `${promo.code} is off. Checkouts already open with it can still finish.` };
  } catch (err) { explain(err); }
}
