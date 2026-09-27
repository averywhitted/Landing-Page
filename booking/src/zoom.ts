// Creates one Zoom meeting per booking using a Zoom "Server-to-Server OAuth" app.
// If Zoom isn't connected yet (or fails), returns null and the booking still
// goes through; Avery is told to send a link, or ZOOM_FALLBACK_URL is used.

import type { Env } from "./env";
import { usingFakes } from "./env";

export type ZoomMeeting = { id: string; joinUrl: string };

async function token(env: Env): Promise<string> {
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID!)}`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`) },
  });
  if (!res.ok) throw new Error(`Zoom token failed (${res.status})`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export function zoomConfigured(env: Env): boolean {
  return !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET);
}

export async function createMeeting(env: Env, p: { topic: string; start: number; durationMinutes: number }): Promise<ZoomMeeting | null> {
  if (usingFakes(env)) return { id: "fake-zoom-1", joinUrl: "https://zoom.us/j/0000000000?pwd=fake" };
  if (!zoomConfigured(env)) return null;
  // One retry for brief network hiccups.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const user = encodeURIComponent(env.ZOOM_USER || "me");
      const res = await fetch(`https://api.zoom.us/v2/users/${user}/meetings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token(env)}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: p.topic,
          type: 2,
          start_time: new Date(p.start).toISOString().replace(/\.\d{3}Z$/, "Z"),
          duration: p.durationMinutes,
          timezone: "UTC",
          settings: { join_before_host: false, waiting_room: true },
        }),
      });
      if (!res.ok) throw new Error(`Zoom create failed (${res.status})`);
      const m = (await res.json()) as { id: number; join_url: string };
      return { id: String(m.id), joinUrl: m.join_url };
    } catch (err) {
      if (attempt === 2) { console.error("zoom:", (err as Error).message); return null; }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return null;
}

export async function updateMeeting(env: Env, id: string, p: { start: number; durationMinutes: number }): Promise<void> {
  if (usingFakes(env) || !zoomConfigured(env)) return;
  const res = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${await token(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start_time: new Date(p.start).toISOString().replace(/\.\d{3}Z$/, "Z"), duration: p.durationMinutes, timezone: "UTC" }),
  });
  if (!res.ok) throw new Error(`Zoom update failed (${res.status})`);
}

export async function deleteMeeting(env: Env, id: string): Promise<void> {
  if (usingFakes(env) || !zoomConfigured(env)) return;
  const res = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${await token(env)}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Zoom delete failed (${res.status})`);
}
