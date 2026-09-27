// Cloudflare Turnstile: confirms a real person submitted the booking form.
// The page gets a one-time token; we ask Cloudflare whether it's genuine.

import type { Env } from "./env";
import { usingFakes } from "./env";

export async function verifyHuman(env: Env, token: unknown, ip: string): Promise<boolean> {
  if (usingFakes(env)) return true;
  if (!env.TURNSTILE_SECRET_KEY) return true; // not switched on yet
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }).toString(),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("turnstile: verify failed:", (err as Error).message);
    return false;
  }
}
