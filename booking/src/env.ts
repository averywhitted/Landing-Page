// Everything the booking service is given by Cloudflare.
// Plain settings live in wrangler.toml [vars]; secrets are added with
// `npm run cf -- secret put NAME` and never appear in the repo.

export type Env = {
  DB: D1Database;

  // Settings (wrangler.toml)
  ICLOUD_APPLE_ID: string;
  SITE_URL: string;          // https://averywhitted.com (where the booking pages live)
  EMAIL_FROM: string;        // "Avery Whitted <info@averywhitted.com>"
  EMAIL_REPLY_TO: string;    // info@averywhitted.com
  ADMIN_EMAIL: string;       // where new-booking notices go
  REMINDERS_ENABLED?: string; // "1" turns on "finish your booking" emails
  ZOOM_FALLBACK_URL?: string; // used if Zoom isn't connected or fails
  ZOOM_USER?: string;         // Zoom login the meetings are created under
  ACCESS_TEAM_DOMAIN?: string; // Cloudflare Access team domain, e.g. averywhitted.cloudflareaccess.com (admin lock)
  ACCESS_AUD?: string;         // the Access application's "AUD" tag (admin lock)
  ADMIN_ALLOWED_EMAILS?: string; // comma-separated; defaults to ADMIN_EMAIL

  // Secrets
  ICLOUD_APP_PASSWORD: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  ZOOM_ACCOUNT_ID?: string;
  ZOOM_CLIENT_ID?: string;
  ZOOM_CLIENT_SECRET?: string;
  HASH_SALT?: string;         // random string for hashing IP addresses
  MANAGE_LINK_SECRET?: string; // signs clients' reschedule/cancel links
  TURNSTILE_SECRET_KEY?: string; // Cloudflare Turnstile (bot check on the booking form)

  // Local testing only. Never set these in wrangler.toml or as secrets.
  // LOCAL_FAKES=1 swaps iCloud, email, and Zoom for stand-ins and lets
  // STRIPE_API_BASE point at a fake Stripe running on this Mac.
  LOCAL_FAKES?: string;
  STRIPE_API_BASE?: string;
};

export const usingFakes = (env: Env) => env.LOCAL_FAKES === "1";

// Is this the real site, or a test copy of the pages served from this Mac?
export const isLiveSite = (env: Env) => /^https:\/\/(www\.)?averywhitted\.com\/?$/.test(env.SITE_URL);

// Addresses of this Mac: itself, or on the home network (so a phone on the
// same Wi-Fi can test). Only trusted while testing, never on the live site.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

// May a booking page at this address use the service?
export function allowedPage(env: Env, protocol: string, host: string): boolean {
  if (protocol === "https:" && (host === "averywhitted.com" || host === "www.averywhitted.com")) return true;
  return protocol === "http:" && !isLiveSite(env) && LOCAL_HOST.test(host);
}
