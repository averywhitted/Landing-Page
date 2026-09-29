// Old email addresses that belong to a student who was merged or re-emailed
// (see migrations/0015). Booking with one goes to that student.

import type { Env } from "./env";

export async function customerForAlias(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT customer_id FROM customer_aliases WHERE email = ?1").bind(email).first<{ customer_id: string }>();
  return row?.customer_id ?? null;
}
