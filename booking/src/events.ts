// The running log behind the admin's status lights (see migrations/0014).
// Writing to it must never break the thing being logged, so every failure here
// is swallowed.

import type { Env } from "./env";

export type Service = "stripe" | "icloud" | "resend" | "zoom" | "database" | "backups" | "turnstile";
export type Level = "ok" | "info" | "warn" | "error";

export const SERVICES: { id: Service; label: string }[] = [
  { id: "stripe", label: "Stripe" },
  { id: "icloud", label: "iCloud" },
  { id: "resend", label: "Resend" },
  { id: "zoom", label: "Zoom" },
  { id: "database", label: "Database" },
  { id: "backups", label: "Backups" },
  { id: "turnstile", label: "Turnstile" },
];

export async function logEvent(env: Env, service: Service, level: Level, message: string): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO integration_events (service, level, message) VALUES (?1, ?2, ?3)")
      .bind(service, level, message.slice(0, 400)).run();
  } catch { /* the log is a nice-to-have */ }
}

export async function recentEvents(env: Env, service: Service, limit = 100) {
  const rows = await env.DB.prepare(
    "SELECT id, level, message, created_at FROM integration_events WHERE service = ?1 ORDER BY id DESC LIMIT ?2",
  ).bind(service, limit).all<{ id: number; level: Level; message: string; created_at: string }>();
  return rows.results.map((r) => ({ id: r.id, level: r.level, message: r.message, at: r.created_at }));
}
