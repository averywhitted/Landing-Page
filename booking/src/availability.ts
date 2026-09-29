// Works out which start times to offer for a given session length.

import { RULES } from "./settings";
import { iso, zonedDate, zonedToUtc } from "./time";
import type { Interval } from "./icloud";
import type { Scheduling } from "./config";

const MIN = 60000;

// The settings these functions need (from the admin page, or the defaults).
export type SlotRules = Pick<Scheduling, "dayStartHour" | "dayEndHour" | "workDays" | "bufferMinutes" | "minNoticeHours" | "slotStepMinutes">;
const DEFAULT_RULES: SlotRules = {
  dayStartHour: RULES.dayStartHour, dayEndHour: RULES.dayEndHour, workDays: [0, 1, 2, 3, 4, 5, 6],
  bufferMinutes: RULES.bufferMinutes, minNoticeHours: RULES.minNoticeHours, slotStepMinutes: RULES.slotStepMinutes,
};

// The 15-minute blocks a booking needs: every block it covers plus the
// buffer after it. Used both here and when writing slot_claims.
export function blocksFor(start: number, durationMinutes: number, bufferMinutes = RULES.bufferMinutes): string[] {
  const blocks: string[] = [];
  const end = start + (durationMinutes + bufferMinutes) * MIN;
  for (let t = start; t < end; t += RULES.blockMinutes * MIN) blocks.push(iso(t));
  return blocks;
}

// Is this start time free, given calendar events and already-claimed blocks?
export function isFree(start: number, durationMinutes: number, busy: Interval[], claimed: Set<string>, bufferMinutes = RULES.bufferMinutes): boolean {
  const end = start + durationMinutes * MIN;
  const buffer = bufferMinutes * MIN;
  // Keep a buffer on both sides of anything on the calendar.
  for (const b of busy) if (start < b.end + buffer && end + buffer > b.start) return false;
  return blocksFor(start, durationMinutes, bufferMinutes).every((blk) => !claimed.has(blk));
}

// All start times between `from` and `to` that fit the working days and
// hours, notice period, calendar, and existing bookings.
export function openSlots(opts: {
  durationMinutes: number;
  from: number;
  to: number;
  now: number;
  busy: Interval[];
  claimed: Set<string>;
  rules?: SlotRules;
}): string[] {
  const { durationMinutes, from, to, now, busy, claimed } = opts;
  const r = opts.rules ?? DEFAULT_RULES;
  const earliest = now + r.minNoticeHours * 60 * MIN;
  const slots: string[] = [];

  // Walk day by day in Avery's time zone so daylight saving is handled.
  let [y, m, d] = zonedDate(from, RULES.timeZone);
  for (;;) {
    if (zonedToUtc(y, m, d, 0, 0, RULES.timeZone) >= to) break;
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (r.workDays.includes(weekday)) {
      const dayStart = zonedToUtc(y, m, d, r.dayStartHour, 0, RULES.timeZone);
      const dayEnd = zonedToUtc(y, m, d, r.dayEndHour, 0, RULES.timeZone);
      for (let t = dayStart; t + durationMinutes * MIN <= dayEnd; t += r.slotStepMinutes * MIN) {
        if (t < from || t >= to || t < earliest) continue;
        if (isFree(t, durationMinutes, busy, claimed, r.bufferMinutes)) slots.push(iso(t));
      }
    }
    // Next calendar day (Date.UTC handles month and year rollover).
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    [y, m, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
  }
  return slots;
}
