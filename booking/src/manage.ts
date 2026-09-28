// Private "manage your booking" links.
// Each link carries the booking id plus a signature made with a secret only
// the booking service knows, so a link opens exactly one booking and can't be
// guessed or edited to reach another.

import type { Env } from "./env";

const enc = new TextEncoder();

function base64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(env: Env, id: string, purpose = "manage"): Promise<string> {
  if (!env.MANAGE_LINK_SECRET) throw new Error("MANAGE_LINK_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(env.MANAGE_LINK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, enc.encode(`${purpose}:${id}`))).slice(0, 32);
}

export async function manageUrl(env: Env, bookingId: string): Promise<string> {
  return `${env.SITE_URL}/book/manage/?b=${encodeURIComponent(bookingId)}&t=${await sign(env, bookingId)}`;
}

export async function validManageToken(env: Env, bookingId: unknown, token: unknown, purpose = "manage"): Promise<boolean> {
  if (typeof bookingId !== "string" || typeof token !== "string") return false;
  if (!/^[0-9a-f-]{36}$/.test(bookingId) || token.length !== 32) return false;
  const expected = await sign(env, bookingId, purpose);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

// Bundle pages use the same scheme with a different purpose, so a booking
// link can never be used as a bundle link or the other way round.
export async function packageUrl(env: Env, packageId: string): Promise<string> {
  return `${env.SITE_URL}/book/package/?p=${encodeURIComponent(packageId)}&t=${await sign(env, packageId, "package")}`;
}
export const validPackageToken = (env: Env, id: unknown, token: unknown) => validManageToken(env, id, token, "package");
