// The iCloud app-specific password, changeable from the admin page.
//
// How it's kept safe:
//  - It's encrypted (AES-256-GCM) before it's stored. The key is derived from
//    SECRETS_KEY, which lives only in Cloudflare's secret storage, so the
//    database (or a backup of it) alone never reveals the password.
//  - It's never sent back to the browser, logged, or included in backups.
//  - A new password is tried against iCloud before it replaces the old one.
//  - Only the admin page can change it (Cloudflare Access plus this service's
//    own check), and every change emails Avery.
//  - If the stored copy can't be read for any reason, the service falls back
//    to the ICLOUD_APP_PASSWORD secret it was set up with.

import type { Env } from "./env";
import type { ICloudEnv } from "./icloud";
import { BookingError } from "./bookings";

const NAME = "icloud_app_password";
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// SECRETS_KEY is 32 random bytes as hex (made by push-secrets.sh).
const hasKey = (env: Env) => /^[0-9a-f]{64}$/i.test(env.SECRETS_KEY ?? "");

async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from((env.SECRETS_KEY ?? "").match(/../g)!.map((h) => parseInt(h, 16)));
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("averywhitted-booking"), info: new TextEncoder().encode("stored-secrets/v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

async function encrypt(env: Env, name: string, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, await aesKey(env), new TextEncoder().encode(plain));
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) };
}

async function decrypt(env: Env, name: string, iv: string, ciphertext: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(name) }, await aesKey(env), unb64(ciphertext));
  return new TextDecoder().decode(pt);
}

// Remembered briefly in memory, so each calendar request doesn't decrypt it again.
let cache: { at: number; value: string | null } | null = null;
const CACHE_MS = 60_000;
export function forgetStoredPassword() { cache = null; }

async function storedPassword(env: Env): Promise<string | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: string | null = null;
  if (hasKey(env)) {
    try {
      const row = await env.DB.prepare("SELECT iv, ciphertext FROM stored_secrets WHERE name = ?1").bind(NAME).first<{ iv: string; ciphertext: string }>();
      if (row) value = await decrypt(env, NAME, row.iv, row.ciphertext);
    } catch (err) {
      console.error("stored iCloud password couldn't be read; using the Cloudflare secret instead:", (err as Error).name);
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

// The Apple ID and password to use for iCloud right now.
export async function icloudCredentials(env: Env): Promise<ICloudEnv> {
  return { ICLOUD_APPLE_ID: env.ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD: (await storedPassword(env)) ?? env.ICLOUD_APP_PASSWORD };
}

/* ── The admin page ── */

export async function icloudPasswordStatus(env: Env) {
  const row = hasKey(env)
    ? await env.DB.prepare("SELECT updated_at, updated_by FROM stored_secrets WHERE name = ?1").bind(NAME).first<{ updated_at: string; updated_by: string }>()
    : null;
  return { canUpdate: hasKey(env), fromAdmin: !!row, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
}

// Apple shows app-specific passwords as xxxx-xxxx-xxxx-xxxx (lowercase letters).
export function normalizeAppPassword(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const letters = s.replace(/-/g, "");
  if (!/^[a-z]{16}$/.test(letters) || !/^([a-z]{4}-?){3}[a-z]{4}$/.test(s)) return null;
  return letters.match(/.{4}/g)!.join("-");
}

export async function adminSetIcloudPassword(env: Env, raw: unknown, by: string, now: number,
  test: (creds: ICloudEnv) => Promise<void>) {
  if (!hasKey(env)) throw new BookingError(503, "One-time setup needed first: run ./scripts/push-secrets.sh, then deploy.");
  const password = normalizeAppPassword(raw);
  if (!password) throw new BookingError(400, "That doesn't look like an app-specific password. Apple shows them as four groups of four letters, like abcd-efgh-ijkl-mnop.");
  try {
    await test({ ICLOUD_APPLE_ID: env.ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD: password });
  } catch {
    throw new BookingError(400, `iCloud didn't accept that password for ${env.ICLOUD_APPLE_ID}. Check it was made for this Apple ID and copied exactly, then try again. Nothing was changed.`);
  }
  const { iv, ciphertext } = await encrypt(env, NAME, password);
  await env.DB.prepare(
    `INSERT INTO stored_secrets (name, iv, ciphertext, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(NAME, iv, ciphertext, new Date(now).toISOString(), by.slice(0, 200)).run();
  forgetStoredPassword();
}

// Go back to the password the service was set up with (the Cloudflare secret).
export async function adminClearIcloudPassword(env: Env) {
  await env.DB.prepare("DELETE FROM stored_secrets WHERE name = ?1").bind(NAME).run();
  forgetStoredPassword();
}
