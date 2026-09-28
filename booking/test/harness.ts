// Runs the real booking service inside Node for tests.
// Only the outside world is faked: the database is an in-memory SQLite copy
// with the real migrations applied, and Stripe, Resend, and iCloud are
// replaced by stand-ins that record what they were asked to do.
// Nothing here touches the network.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createHmac, generateKeyPairSync, createSign } from "node:crypto";
import worker from "../src/index";
import type { Env } from "../src/env";

/* ── D1 stand-in (same SQLite engine D1 uses) ── */

class Stmt {
  constructor(private db: DatabaseSync, public sql: string, public params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : p))); }
  private prep() { return this.db.prepare(this.sql); }
  async first<T>(): Promise<T | null> { return ((this.prep().get(...(this.params as never[])) as T) ?? null); }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.prep().all(...(this.params as never[])) as T[] }; }
  async run() {
    const r = this.prep().run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
  runSync() { return this.prep().run(...(this.params as never[])); }
}

export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out.map((r) => ({ success: true, meta: { changes: Number(r.changes) } }));
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql: string) { db.exec(sql); },
  };
  return { db, d1: d1 as unknown as D1Database };
}

/* ── Pretend Cloudflare Access (signs admin passes with a test key) ── */

export const ACCESS_TEAM = "test.cloudflareaccess.com";
export const ACCESS_AUD = "test-aud";
const accessKeys = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, publicJwk: publicKey.export({ format: "jwk" }) };
})();
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function accessToken(claims: Record<string, unknown> = {}, opts: { forged?: boolean } = {}): string {
  const header = b64u(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }));
  const payload = b64u(JSON.stringify({
    aud: [ACCESS_AUD], iss: `https://${ACCESS_TEAM}`, email: "avery@averywhitted.com",
    exp: Math.floor(Date.now() / 1000) + 3600, ...claims,
  }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(opts.forged ? otherKey : accessKeys.privateKey);
  return `${header}.${payload}.${b64u(sig)}`;
}

/* ── Fake outside world ── */

export type BusyEvent = { calendar: string; ics: string };

export function makeWorld() {
  const state = {
    stripeSessions: new Map<string, Record<string, any>>(),
    stripeFailNextCreate: false,
    promoCodes: {} as Record<string, string>,       // code -> Stripe promo id
    promoLookupForbidden: false,                    // simulate a key without "Promotion Codes: Read"
    refunds: [] as Record<string, any>[],
    refundFailNext: 0,                              // simulate Stripe refusing refunds
    refundedIntents: new Set<string>(),             // Stripe won't refund the same payment twice
    calendarDeleteFailNext: 0,                      // simulate iCloud failing to delete
    emails: [] as Record<string, any>[],
    resendFailNext: 0,
    calendarEvents: new Map<string, string>(),   // url -> ics
    busy: [] as BusyEvent[],                      // raw VEVENT blocks per calendar
    requests: [] as string[],
    counter: 0,
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const withUrl = (res: Response, url: string) => { Object.defineProperty(res, "url", { value: url }); return res; };
  const xml = (body: string, url: string) => withUrl(new Response(body, { status: 207, headers: { "Content-Type": "application/xml" } }), url);
  const parseForm = (body: string) => {
    const out: Record<string, any> = {};
    for (const [k, v] of new URLSearchParams(body)) {
      const parts = k.replace(/]/g, "").split("[");
      let node = out;
      for (const p of parts.slice(0, -1)) node = node[p] ??= {};
      node[parts.at(-1)!] = v;
    }
    return out;
  };

  const CAL_HOME = "https://p01-caldav.icloud.com/123/calendars/";
  const CALS: Record<string, string> = { Professional: "work", Personal: "home", Coaching: "coaching" };

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    state.requests.push(`${method} ${url}`);
    const u = new URL(url);

    /* Stripe */
    if (u.host === "api.stripe.com") {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth !== "Bearer sk_test_harness") return json({ error: { message: "bad key" } }, 401);
      const p = u.pathname;
      if (p === "/v1/checkout/sessions" && method === "POST") {
        if (state.stripeFailNextCreate) { state.stripeFailNextCreate = false; return json({ error: { message: "Stripe is down" } }, 500); }
        const f = parseForm(body);
        const id = `cs_test_${++state.counter}`;
        const s = {
          id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`,
          amount_total: Number(f.line_items["0"].price_data.unit_amount), payment_intent: null, expires_at: Number(f.expires_at),
          metadata: f.metadata ?? {}, _form: f, _promo: f.discounts?.["0"]?.promotion_code ?? null,
        };
        state.stripeSessions.set(id, s);
        return json(s);
      }
      const m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/);
      if (m) {
        const s = state.stripeSessions.get(m[1]);
        if (!s) return json({ error: { message: "No such session" } }, 404);
        if (m[2]) {
          if (s.status !== "open") return json({ error: { message: `Session is ${s.status}` } }, 400);
          s.status = "expired";
        }
        return json({ ...s, total_details: { breakdown: { discounts: s._promo ? [{ discount: { promotion_code: s._promo } }] : [] } } });
      }
      if (p === "/v1/promotion_codes" && method === "GET") {
        if (state.promoLookupForbidden) return json({ error: { message: "missing permission" } }, 403);
        const id = state.promoCodes[u.searchParams.get("code") ?? ""];
        return json({ data: id ? [{ id }] : [] });
      }
      const pc = p.match(/^\/v1\/promotion_codes\/([^/]+)$/);
      if (pc && method === "GET") {
        const code = Object.entries(state.promoCodes).find(([, id]) => id === pc[1])?.[0];
        return code ? json({ id: pc[1], code }) : json({ error: { message: "No such promotion code" } }, 404);
      }
      if (p === "/v1/refunds" && method === "POST") {
        if (state.refundFailNext > 0) { state.refundFailNext--; return json({ error: { message: "Stripe is having trouble" } }, 500); }
        const f = parseForm(body);
        // Like Stripe: partial refunds add up, but never past what was paid.
        const paidFor = [...state.stripeSessions.values()].find((x) => `pi_${x.id}` === f.payment_intent)?.amount_total ?? Infinity;
        const already = state.refunds.filter((r) => r.payment_intent === f.payment_intent).reduce((n, r) => n + Number(r.amount ?? paidFor), 0);
        const amount = f.amount !== undefined ? Number(f.amount) : paidFor - already;
        if (already >= paidFor || already + amount > paidFor) return json({ error: { message: "Charge has already been refunded.", code: "charge_already_refunded" } }, 400);
        state.refunds.push(f);
        return json({ id: `re_${++state.counter}`, status: "succeeded" });
      }
      return json({ error: { message: `unhandled stripe ${method} ${p}` } }, 404);
    }

    /* Cloudflare Access public keys (for the admin lock) */
    if (u.host === ACCESS_TEAM && u.pathname === "/cdn-cgi/access/certs") {
      return json({ keys: [{ ...accessKeys.publicJwk, kid: "test-kid", alg: "RS256", use: "sig" }] });
    }

    /* Cloudflare Turnstile */
    if (u.host === "challenges.cloudflare.com") {
      const f = new URLSearchParams(body);
      // Tokens name the page they were made on: good-token (averywhitted.com), lan-token, elsewhere-token.
      const hosts: Record<string, string> = { "good-token": "averywhitted.com", "lan-token": "192.168.1.155", "elsewhere-token": "evil.example" };
      const host = hosts[f.get("response") ?? ""];
      const good = f.get("secret") === "turnstile-secret" && !!host;
      return json(good ? { success: true, hostname: host } : { success: false, "error-codes": ["invalid-input-response"] });
    }

    /* Resend */
    if (u.host === "api.resend.com") {
      if (state.resendFailNext > 0) { state.resendFailNext--; return json({ message: "temporary failure" }, 500); }
      state.emails.push(JSON.parse(body));
      return json({ id: `email_${++state.counter}` });
    }

    /* iCloud CalDAV */
    if (u.host.endsWith("caldav.icloud.com")) {
      const ok = new Headers(init?.headers).get("Authorization") === "Basic " + btoa("avery@example.com:app-pass");
      if (!ok) return withUrl(new Response("", { status: 401 }), url);
      if (method === "PROPFIND" && u.pathname === "/") {
        return xml(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`, "https://caldav.icloud.com/");
      }
      if (method === "PROPFIND" && u.pathname === "/123/principal/") {
        return xml(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${CAL_HOME}</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`, url);
      }
      if (method === "PROPFIND" && url === CAL_HOME) {
        const rows = Object.entries(CALS).map(([name, slug]) =>
          `<d:response><d:href>/123/calendars/${slug}/</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname></d:prop></d:propstat></d:response>`).join("");
        return xml(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/123/calendars/</d:href></d:response>${rows}</d:multistatus>`, url);
      }
      const cal = Object.entries(CALS).find(([, slug]) => u.pathname === `/123/calendars/${slug}/`)?.[0];
      if (method === "REPORT" && cal) {
        const events = state.busy.filter((e) => e.calendar === cal).map((e) =>
          `<d:response><d:href>${u.pathname}e.ics</d:href><d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR&#13;\nVERSION:2.0&#13;\n${e.ics}&#13;\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response>`).join("");
        return xml(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${events}</d:multistatus>`, url);
      }
      if (method === "PUT" && u.pathname.startsWith("/123/calendars/coaching/")) {
        const existed = state.calendarEvents.has(url);
        state.calendarEvents.set(url, body);
        return withUrl(new Response(null, { status: existed ? 204 : 201 }), url);
      }
      if (method === "DELETE") {
        if (state.calendarDeleteFailNext > 0) { state.calendarDeleteFailNext--; return withUrl(new Response("", { status: 503 }), url); }
        state.calendarEvents.delete(url);
        return withUrl(new Response(null, { status: 204 }), url);
      }
      return withUrl(new Response(`unhandled caldav ${method} ${url}`, { status: 400 }), url);
    }

    throw new Error(`Test tried to reach the real network: ${method} ${url}`);
  }

  return { state, fakeFetch };
}

/* ── Running requests against the worker ── */

export function makeEnv(d1: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: d1,
    ICLOUD_APPLE_ID: "avery@example.com",
    ICLOUD_APP_PASSWORD: "app-pass",
    SITE_URL: "https://averywhitted.com",
    EMAIL_FROM: "Avery Whitted <info@averywhitted.com>",
    EMAIL_REPLY_TO: "info@averywhitted.com",
    ADMIN_EMAIL: "avery@averywhitted.com",
    REMINDERS_ENABLED: "1",
    STRIPE_SECRET_KEY: "sk_test_harness",
    STRIPE_WEBHOOK_SECRET: "whsec_harness",
    RESEND_API_KEY: "re_test_harness",
    HASH_SALT: "salt",
    MANAGE_LINK_SECRET: "manage-secret",
    ...overrides,
  };
}

export function makeClient(env: Env) {
  async function call(method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const req = new Request(`https://book.averywhitted.com${path}`, {
      method,
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...opts.headers },
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const res = await worker.fetch(req, env, ctx);
    await Promise.all(pending);
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  }
  async function cron() {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    worker.scheduled({} as ScheduledController, env, ctx);
    await Promise.all(pending);
  }
  function webhook(type: string, object: Record<string, unknown>, opts: { secret?: string; id?: string } = {}) {
    const payload = JSON.stringify({ id: opts.id ?? `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", opts.secret ?? env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${payload}`).digest("hex");
    return call("POST", "/api/stripe/webhook", { raw: payload, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
  }
  return { call, cron, webhook };
}
