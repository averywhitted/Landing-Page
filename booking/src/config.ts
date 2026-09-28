// The scheduling settings Avery can change from the admin page.
// Defaults come from src/settings.ts (and REMINDERS_ENABLED); anything saved
// from the admin page is stored in the `settings` table and wins.

import type { Env } from "./env";
import { CALENDARS, RULES } from "./settings";

export type Scheduling = {
  dayStartHour: number;       // first possible start, in Avery's time zone
  dayEndHour: number;         // sessions must end by this hour
  workDays: number[];         // 0 = Sunday ... 6 = Saturday
  bufferMinutes: number;      // gap before and after anything on the calendar
  minNoticeHours: number;     // earliest a client can book from now
  slotStepMinutes: number;    // how often start times are offered
  packageValidDays: number;   // bundles must be used within this many days
  busyCalendars: string[];    // iCloud calendars that block booking
  bookingCalendar: string;    // iCloud calendar new bookings are written to
  remindersEnabled: boolean;  // "finish your booking" emails
};

export function defaults(env: Env): Scheduling {
  return {
    dayStartHour: RULES.dayStartHour,
    dayEndHour: RULES.dayEndHour,
    workDays: [0, 1, 2, 3, 4, 5, 6],
    bufferMinutes: RULES.bufferMinutes,
    minNoticeHours: RULES.minNoticeHours,
    slotStepMinutes: RULES.slotStepMinutes,
    packageValidDays: RULES.packageValidDays,
    busyCalendars: [...CALENDARS.busy],
    bookingCalendar: CALENDARS.booking,
    remindersEnabled: env.REMINDERS_ENABLED === "1",
  };
}

export class SettingsError extends Error {}

// Checks every field and returns a clean copy. Throws SettingsError with a
// plain-English message if something doesn't make sense.
export function validate(input: unknown): Scheduling {
  const v = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const int = (k: string, min: number, max: number, label: string) => {
    const n = Number(v[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new SettingsError(`${label} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const dayStartHour = int("dayStartHour", 0, 23, "Start hour");
  const dayEndHour = int("dayEndHour", 1, 24, "End hour");
  if (dayEndHour <= dayStartHour) throw new SettingsError("Your day has to end after it starts.");
  const workDays = Array.isArray(v.workDays) ? [...new Set(v.workDays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (!workDays.length) throw new SettingsError("Pick at least one working day.");
  const bufferMinutes = int("bufferMinutes", 0, 120, "Buffer");
  if (bufferMinutes % 5) throw new SettingsError("Buffer must be in steps of 5 minutes.");
  const minNoticeHours = int("minNoticeHours", 0, 336, "Minimum notice");
  const slotStepMinutes = int("slotStepMinutes", 15, 60, "Start-time spacing");
  if (![15, 30, 60].includes(slotStepMinutes)) throw new SettingsError("Start times can be every 15, 30, or 60 minutes.");
  const packageValidDays = int("packageValidDays", 14, 365, "Bundle validity");
  const names = (x: unknown) => (Array.isArray(x) ? x : []).filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
  const busyCalendars = [...new Set(names(v.busyCalendars))].slice(0, 10);
  const bookingCalendar = typeof v.bookingCalendar === "string" ? v.bookingCalendar.trim() : "";
  if (!bookingCalendar || bookingCalendar.length > 100) throw new SettingsError("Pick the calendar new bookings go into.");
  if (busyCalendars.some((n) => n.length > 100)) throw new SettingsError("Calendar names are too long.");
  // The bookings calendar always blocks time too, or you could be double-booked.
  if (!busyCalendars.includes(bookingCalendar)) busyCalendars.push(bookingCalendar);
  return {
    dayStartHour, dayEndHour, workDays, bufferMinutes, minNoticeHours, slotStepMinutes, packageValidDays,
    busyCalendars, bookingCalendar, remindersEnabled: v.remindersEnabled === true,
  };
}

type Loaded = { values: Scheduling; updatedAt: string | null; updatedBy: string | null };
const cache = new WeakMap<D1Database, { at: number; loaded: Loaded }>();

// Current settings (defaults + anything saved). Cached for 30 seconds.
export async function loadScheduling(env: Env): Promise<Loaded> {
  const hit = cache.get(env.DB);
  if (hit && Date.now() - hit.at < 30000) return hit.loaded;
  let loaded: Loaded = { values: defaults(env), updatedAt: null, updatedBy: null };
  try {
    const row = await env.DB.prepare("SELECT value, updated_at, updated_by FROM settings WHERE key = 'scheduling'")
      .first<{ value: string; updated_at: string; updated_by: string | null }>();
    if (row) loaded = { values: { ...defaults(env), ...validate({ ...defaults(env), ...JSON.parse(row.value) }) }, updatedAt: row.updated_at, updatedBy: row.updated_by };
  } catch (err) {
    // A bad or missing row never takes booking down: fall back to the defaults.
    console.error("settings: using defaults:", (err as Error).message);
  }
  cache.set(env.DB, { at: Date.now(), loaded });
  return loaded;
}

export const scheduling = async (env: Env) => (await loadScheduling(env)).values;

export async function saveScheduling(env: Env, values: Scheduling, by: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('scheduling', ?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(JSON.stringify(values), new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), by).run();
  cache.delete(env.DB);
}

export async function resetScheduling(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'scheduling'").run();
  cache.delete(env.DB);
}
