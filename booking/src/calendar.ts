// The calendar the booking service talks to. In production this is iCloud;
// for local testing (LOCAL_FAKES=1) it's a stand-in that never leaves this Mac.

import type { Env } from "./env";
import { usingFakes } from "./env";
import * as icloud from "./icloud";
import type { Interval } from "./icloud";
import { icloudCredentials } from "./secrets";
import { logEvent } from "./events";

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
    putEvent: async (uid, ics, existingUrl) => {
      try {
        const url = await icloud.putEvent(await icloudCredentials(env), uid, ics, existingUrl, cals?.bookingCalendar);
        await logEvent(env, "icloud", "ok", existingUrl ? "Updated a session on the calendar" : "Added a session to the calendar");
        return url;
      } catch (err) { await logEvent(env, "icloud", "error", `Couldn't write to the calendar: ${(err as Error).message}`); throw err; }
    },
    deleteEvent: async (url) => {
      try {
        await icloud.deleteEvent(await icloudCredentials(env), url);
        await logEvent(env, "icloud", "ok", "Removed a session from the calendar");
      } catch (err) { await logEvent(env, "icloud", "error", `Couldn't remove a calendar event: ${(err as Error).message}`); throw err; }
    },
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
