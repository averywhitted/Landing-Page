// Works out which start times to offer for a given session length.

import { RULES } from "./settings";
import { iso, zonedDate, zonedToUtc } from "./time";
import type { Interval } from "./icloud";

const MIN = 60000;

// The 15-minute blocks a booking needs: every block it covers plus one
// block of buffer after it. Used both here and when writing slot_claims.
export function blocksFor(start: number, durationMinutes: number): string[] {
  const blocks: string[] = [];
  const end = start + (durationMinutes + RULES.bufferMinutes) * MIN;
  for (let t = start; t < end; t += RULES.blockMinutes * MIN) blocks.push(iso(t));
  return blocks;
}

// Is this start time free, given calendar events and already-claimed blocks?
export function isFree(start: number, durationMinutes: number, busy: Interval[], claimed: Set<string>): boolean {
  const end = start + durationMinutes * MIN;
  const buffer = RULES.bufferMinutes * MIN;
  // Keep a buffer on both sides of anything on the calendar.
  for (const b of busy) if (start < b.end + buffer && end + buffer > b.start) return false;
  return blocksFor(start, durationMinutes).every((blk) => !claimed.has(blk));
}

// All start times between `from` and `to` that fit the working day, notice
// period, calendar, and existing bookings.
export function openSlots(opts: {
  durationMinutes: number;
  from: number;
  to: number;
  now: number;
  busy: Interval[];
  claimed: Set<string>;
}): string[] {
  const { durationMinutes, from, to, now, busy, claimed } = opts;
  const earliest = now + RULES.minNoticeHours * 60 * MIN;
  const slots: string[] = [];

  // Walk day by day in Avery's time zone so daylight saving is handled.
  let [y, m, d] = zonedDate(from, RULES.timeZone);
  for (;;) {
    const dayStart = zonedToUtc(y, m, d, RULES.dayStartHour, 0, RULES.timeZone);
    if (dayStart >= to) break;
    const dayEnd = zonedToUtc(y, m, d, RULES.dayEndHour, 0, RULES.timeZone);

    for (let t = dayStart; t + durationMinutes * MIN <= dayEnd; t += RULES.slotStepMinutes * MIN) {
      if (t < from || t >= to || t < earliest) continue;
      if (isFree(t, durationMinutes, busy, claimed)) slots.push(iso(t));
    }

    // Next calendar day (Date.UTC handles month and year rollover).
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    [y, m, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
  }
  return slots;
}
