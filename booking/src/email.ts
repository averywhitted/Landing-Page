// Sends email through Resend from info@averywhitted.com.
// Every attempt is recorded in email_log (kind + status only, no addresses
// or content). With LOCAL_FAKES=1 nothing is sent; it's logged instead.

import type { Env } from "./env";
import { usingFakes } from "./env";
import { logEvent } from "./events";

export type Email = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string; contentType: string }[];
};

export async function sendEmail(env: Env, kind: string, bookingId: string | null, email: Email): Promise<boolean> {
  let status = "sent";
  let error: string | null = null;
  try {
    if (usingFakes(env)) {
      console.log(`[fake email] ${kind}: "${email.subject}"`);
    } else {
      if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [email.to],
          reply_to: env.EMAIL_REPLY_TO,
          subject: email.subject,
          html: email.html,
          text: email.text,
          attachments: email.attachments?.map((a) => ({
            filename: a.filename,
            content: btoa(unescape(encodeURIComponent(a.content))),
            content_type: a.contentType,
          })),
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${((await res.json().catch(() => ({}))) as { message?: string }).message ?? ""}`);
    }
  } catch (err) {
    status = "failed";
    error = (err as Error).message.slice(0, 300);
    console.error(`email ${kind} failed:`, error);
  }
  await env.DB.prepare("INSERT INTO email_log (booking_id, kind, status, error) VALUES (?1, ?2, ?3, ?4)")
    .bind(bookingId, kind, status, error).run();
  const label = kind.replace(/_/g, " ");
  await logEvent(env, "resend", status === "sent" ? "ok" : "error", status === "sent" ? `Sent a "${label}" email` : `Couldn't send a "${label}" email: ${error}`);
  return status === "sent";
}
