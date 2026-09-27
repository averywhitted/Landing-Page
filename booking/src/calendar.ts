// The calendar the booking service talks to. In production this is iCloud;
// for local testing (LOCAL_FAKES=1) it's a stand-in that never leaves this Mac.

import type { Env } from "./env";
import { usingFakes } from "./env";
import * as icloud from "./icloud";
import type { Interval } from "./icloud";

export type CalendarProvider = {
  getBusy(from: number, to: number): Promise<Interval[]>;
  putEvent(uid: string, ics: string, existingUrl?: string | null): Promise<string>;
  deleteEvent(url: string): Promise<void>;
};

export function calendarFor(env: Env): CalendarProvider {
  if (usingFakes(env)) return fakeCalendar;
  return {
    getBusy: (from, to) => icloud.getBusy(env, from, to),
    putEvent: (uid, ics, existingUrl) => icloud.putEvent(env, uid, ics, existingUrl),
    deleteEvent: (url) => icloud.deleteEvent(env, url),
  };
}

// Stand-in: an empty calendar that just logs what would have been written.
const fakeCalendar: CalendarProvider = {
  async getBusy() { return []; },
  async putEvent(uid) {
    console.log(`[fake calendar] wrote event ${uid}`);
    return `fake-calendar://Coaching/${uid}.ics`;
  },
  async deleteEvent(url) { console.log(`[fake calendar] deleted ${url}`); },
};
