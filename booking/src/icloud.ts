// Reads busy times from iCloud Calendar over CalDAV.
// Only start and end times are used. Titles, notes, and locations are
// never stored or logged.

import { CALENDARS, RULES } from "./settings";
import { isValidTimeZone, zonedToUtc } from "./time";

export type ICloudEnv = { ICLOUD_APPLE_ID: string; ICLOUD_APP_PASSWORD: string };
export type Interval = { start: number; end: number; uid?: string };

const ROOT = "https://caldav.icloud.com/";

async function dav(env: ICloudEnv, method: string, url: string, depth: number, body: string) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Basic " + btoa(`${env.ICLOUD_APPLE_ID}:${env.ICLOUD_APP_PASSWORD}`),
      Depth: String(depth),
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  if (res.status !== 207 && !res.ok) throw new Error(`iCloud ${method} failed with status ${res.status}`);
  return { text: await res.text(), url: res.url };
}

function hrefIn(xml: string, prop: string): string {
  const m = xml.match(new RegExp(`<[^>]*${prop}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)<`, "i"));
  if (!m) throw new Error(`iCloud response had no ${prop}`);
  return m[1];
}

// Every calendar's name and address (names: null means all of them).
export async function findCalendars(env: ICloudEnv, names: string[] | null): Promise<Record<string, string>> {
  const who = await dav(env, "PROPFIND", ROOT, 0,
    `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
  const principal = new URL(hrefIn(who.text, "current-user-principal"), who.url).href;
  const home = await dav(env, "PROPFIND", principal, 0,
    `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`);
  const homeUrl = new URL(hrefIn(home.text, "calendar-home-set"), home.url).href;
  const list = await dav(env, "PROPFIND", homeUrl, 1,
    `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`);

  const found: Record<string, string> = {};
  for (const block of list.text.split(/<[^>]*response[ >]/i).slice(1)) {
    const href = block.match(/<[^>]*href[^>]*>([^<]+)</i)?.[1];
    const name = block.match(/<[^>]*displayname[^>]*>([^<]*)</i)?.[1]?.trim();
    if (href && name && (names === null || names.includes(name))) found[name] = new URL(href, list.url).href;
  }
  return found;
}

// Parses an iCalendar date line such as
//   DTSTART:20260930T180000Z
//   DTSTART;TZID=America/New_York:20260930T140000
//   DTSTART;VALUE=DATE:20260930          (all-day)
// into a UTC timestamp. Times with no zone are treated as Avery's zone.
function parseIcsDate(line: string): { ms: number; allDay: boolean } | null {
  const m = line.match(/^[A-Z]+((?:;[^:]*)?):(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, params, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { ms: zonedToUtc(+y, +mo, +d, 0, 0, RULES.timeZone), allDay: true };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  const tzid = params.match(/TZID=([^;:]+)/)?.[1]?.replace(/^"|"$/g, "");
  const zone = tzid && isValidTimeZone(tzid) ? tzid : RULES.timeZone;
  return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, zone), allDay: false };
}

// Pulls busy intervals out of a CalDAV calendar-query response.
function busyFromIcs(text: string): Interval[] {
  const out: Interval[] = [];
  for (const chunk of text.split("BEGIN:VEVENT").slice(1)) {
    // Undo iCalendar line folding and XML escaping before reading fields.
    const body = chunk.split("END:VEVENT")[0].replace(/&#13;/g, "").replace(/\r?\n[ \t]/g, "");
    if (/^TRANSP:TRANSPARENT/m.test(body)) continue; // marked "Free"
    if (/^STATUS:CANCELLED/m.test(body)) continue;
    const start = parseIcsDate(body.match(/^DTSTART[^\r\n]*/m)?.[0] ?? "");
    if (!start) continue;
    let end = parseIcsDate(body.match(/^DTEND[^\r\n]*/m)?.[0] ?? "")?.ms;
    if (end === undefined) {
      const dur = body.match(/^DURATION:P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/m);
      end = dur
        ? start.ms + ((+(dur[1] ?? 0) * 24 + +(dur[2] ?? 0)) * 60 + +(dur[3] ?? 0)) * 60000
        : start.ms + (start.allDay ? 86400000 : 0);
    }
    const uid = body.match(/^UID:(.+)$/m)?.[1]?.trim();
    if (end > start.ms) out.push({ start: start.ms, end, uid });
  }
  return out;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Every busy interval between `from` and `to` across the blocking calendars.
// Repeating events are expanded by iCloud into each occurrence.
export async function getBusy(env: ICloudEnv, from: number, to: number, names: string[] = CALENDARS.busy): Promise<Interval[]> {
  const calendars = await findCalendars(env, names);
  const missing = names.filter((n) => !calendars[n]);
  if (missing.length) throw new Error(`iCloud calendars not found: ${missing.join(", ")}`);

  const query = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand start="${stamp(from)}" end="${stamp(to)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${stamp(from)}" end="${stamp(to)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;

  const results = await Promise.all(Object.values(calendars).map((url) => dav(env, "REPORT", url, 1, query)));
  return results.flatMap((r) => busyFromIcs(r.text));
}

// ── Writing events to the Coaching calendar ──

async function calendarUrl(env: ICloudEnv, name: string): Promise<string> {
  const found = await findCalendars(env, [name]);
  const url = found[name];
  if (!url) throw new Error(`iCloud calendar not found: ${name}`);
  return url.endsWith("/") ? url : url + "/";
}

// Creates or replaces the event stored at <calendar>/<uid>.ics.
// Returns the event's address so it can be updated or removed later.
export async function putEvent(env: ICloudEnv, uid: string, ics: string, existingUrl?: string | null, calendarName: string = CALENDARS.booking): Promise<string> {
  const url = existingUrl || new URL(encodeURIComponent(uid) + ".ics", await calendarUrl(env, calendarName)).href;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Basic " + btoa(`${env.ICLOUD_APPLE_ID}:${env.ICLOUD_APP_PASSWORD}`),
      "Content-Type": "text/calendar; charset=utf-8",
    },
    body: ics,
  });
  if (res.status !== 201 && res.status !== 204 && !res.ok) throw new Error(`iCloud PUT failed with status ${res.status}`);
  return url;
}

export async function deleteEvent(env: ICloudEnv, url: string): Promise<void> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: "Basic " + btoa(`${env.ICLOUD_APPLE_ID}:${env.ICLOUD_APP_PASSWORD}`) },
  });
  if (!res.ok && res.status !== 404) throw new Error(`iCloud DELETE failed with status ${res.status}`);
}
