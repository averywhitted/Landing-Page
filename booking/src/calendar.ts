// The calendar the booking service talks to. In production this is iCloud;
// for local testing (LOCAL_FAKES=1) it's a stand-in that never leaves this Mac.

import type { Env } from "./env";
import { usingFakes } from "./env";
import * as icloud from "./icloud";
import type { Interval } from "./icloud";
import { icloudCredentials } from "./secrets";

export type CalendarProvider = {
  getBusy(from: number, to: number): Promise<Interval[]>;
  putEvent(uid: string, ics: string, existingUrl?: string | null): Promise<string>;
  deleteEvent(url: string): Promise<void>;
  listNames(): Promise<string[]>;
};

// `cals` comes from the admin settings; without it the code defaults are used.
export function calendarFor(env: Env, cals?: { busyCalendars: string[]; bookingCalendar: string }): CalendarProvider {
  if (usingFakes(env)) return fakeCalendar;
  // The password changed from the admin page, if there is one; otherwise the Cloudflare secret.
  return {
    getBusy: async (from, to) => icloud.getBusy(await icloudCredentials(env), from, to, cals?.busyCalendars),
    putEvent: async (uid, ics, existingUrl) => icloud.putEvent(await icloudCredentials(env), uid, ics, existingUrl, cals?.bookingCalendar),
    deleteEvent: async (url) => icloud.deleteEvent(await icloudCredentials(env), url),
    listNames: async () => Object.keys(await icloud.findCalendars(await icloudCredentials(env), null)).sort(),
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
  async listNames() { return ["Coaching", "Personal", "Professional"]; },
};
