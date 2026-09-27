// One-off test: can the booking system add, move, and remove an event in
// your "Coaching" calendar?
//
//   node scripts/calendar-write-test.mjs          adds a test event
//   node scripts/calendar-write-test.mjs move     moves it one hour later
//   node scripts/calendar-write-test.mjs delete   removes it
//
// It only ever touches the "Coaching" calendar, and only this one test event.

import { execFileSync } from "node:child_process";

const APPLE_ID = "averywhitted@me.com";
const CALENDAR = "Coaching";
const UID = "booking-write-test@averywhitted.com";
const action = process.argv[2] ?? "add";

const password = execFileSync(
  "security",
  ["find-generic-password", "-s", "icloud-booking-app-password", "-w"],
  { encoding: "utf8" },
).trim();
const auth = "Basic " + Buffer.from(`${APPLE_ID}:${password}`).toString("base64");

async function dav(method, url, { depth, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(depth !== undefined && { Depth: String(depth) }),
      "Content-Type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8",
      ...headers,
    },
    body,
  });
  if (res.status === 401) throw new Error("iCloud rejected the sign-in (check the Apple ID and app-specific password).");
  return { status: res.status, text: await res.text(), url: res.url };
}

function hrefIn(xml, prop) {
  return xml.match(new RegExp(`<[^>]*${prop}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)<`, "i"))?.[1];
}

// Find the Coaching calendar (same steps as calendar-test.mjs).
const who = await dav("PROPFIND", "https://caldav.icloud.com/", { depth: 0,
  body: `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>` });
const principal = new URL(hrefIn(who.text, "current-user-principal"), who.url).href;
const home = await dav("PROPFIND", principal, { depth: 0,
  body: `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>` });
const homeUrl = new URL(hrefIn(home.text, "calendar-home-set"), home.url).href;
const list = await dav("PROPFIND", homeUrl, { depth: 1,
  body: `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>` });
let calendarUrl;
for (const block of list.text.split(/<[^>]*response[ >]/i).slice(1)) {
  const href = block.match(/<[^>]*href[^>]*>([^<]+)</i)?.[1];
  const name = block.match(/<[^>]*displayname[^>]*>([^<]*)</i)?.[1];
  if (href && name?.trim() === CALENDAR) calendarUrl = new URL(href, list.url).href;
}
if (!calendarUrl) {
  console.log(`Could not find an iCloud calendar named "${CALENDAR}". Make sure it's under iCloud, not "On My Mac".`);
  process.exit(1);
}
const eventUrl = new URL("booking-write-test.ics", calendarUrl.endsWith("/") ? calendarUrl : calendarUrl + "/").href;

if (action === "delete") {
  const res = await dav("DELETE", eventUrl);
  console.log(res.status === 204 || res.status === 200 ? "Deleted the test event." : res.status === 404 ? "No test event to delete." : `Delete failed: ${res.status}`);
  process.exit(0);
}

// Three days from now at 2:00pm Eastern (3:00pm for "move"), 30 minutes.
// Eastern is UTC-4 until early November, so 2pm Eastern is 18:00 UTC.
const day = new Date(Date.now() + 3 * 86400000);
const hourUtc = action === "move" ? 19 : 18;
const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc, 0));
const end = new Date(start.getTime() + 30 * 60000);
const ics = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const event = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//averywhitted.com//Booking//EN",
  "BEGIN:VEVENT",
  `UID:${UID}`,
  `DTSTAMP:${ics(new Date())}`,
  `DTSTART:${ics(start)}`,
  `DTEND:${ics(end)}`,
  "SUMMARY:TEST: Booking system event",
  "DESCRIPTION:Test event from the new booking system. Safe to ignore.",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const res = await dav("PUT", eventUrl, { body: event });
const when = start.toLocaleString("en-US", {
  timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
});
if (res.status === 201 || res.status === 204) {
  console.log(`${action === "move" ? "Moved" : "Added"} the test event: ${when} Eastern, in your ${CALENDAR} calendar.`);
} else {
  console.log(`iCloud refused the change (${res.status}).`);
  process.exit(1);
}
