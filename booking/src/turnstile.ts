// Cloudflare Turnstile: confirms a real person submitted the booking form.
// The page gets a one-time token; we ask Cloudflare whether it's genuine.

import type { Env } from "./env";
import { allowedPage, usingFakes } from "./env";
import { logEvent } from "./events";

export async function verifyHuman(env: Env, token: unknown, ip: string): Promise<boolean> {
  if (usingFakes(env)) return true;
  if (!env.TURNSTILE_SECRET_KEY) return true; // not switched on yet
  if (typeof token !== "string" || !token || token.length > 2048) {
    console.warn("turnstile: no token sent with the booking");
    await logEvent(env, "turnstile", "warn", "A booking arrived with no bot-check token (blocked)");
    return false;
  }
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }).toString(),
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[]; hostname?: string };
    if (data.success !== true) {
      // Cloudflare's reason codes (e.g. invalid-input-secret, timeout-or-duplicate). No personal data.
      console.warn(`turnstile: rejected (${(data["error-codes"] ?? []).join(", ") || "no reason given"}), hostname ${data.hostname ?? "unknown"}`);
    }
    if (data.success !== true) {
      await logEvent(env, "turnstile", "warn", `Blocked a booking: ${(data["error-codes"] ?? []).join(", ") || "check failed"}`);
      return false;
    }
    // A pass only counts if it came from one of our booking pages.
    if (!data.hostname || !allowedPage(env, "https:", data.hostname) && !allowedPage(env, "http:", data.hostname)) {
      console.warn(`turnstile: pass came from another site (${data.hostname ?? "unknown"})`);
      await logEvent(env, "turnstile", "warn", `Blocked a booking: the bot check passed on another site (${data.hostname ?? "unknown"})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("turnstile: verify failed:", (err as Error).message);
    await logEvent(env, "turnstile", "error", `Couldn't reach Cloudflare to check a booking: ${(err as Error).message}`);
    return false;
  }
}
