// One-off test: can we read busy times from iCloud?
// Runs only on this Mac. Reads the app-specific password from Keychain,
// connects to iCloud Calendar, and prints the start and end times of events
// in the next 7 days for the Professional and Personal calendars.
// It never prints event titles, notes, or locations, and changes nothing.

import { execFileSync } from "node:child_process";

const APPLE_ID = "averywhitted@me.com";
const CALENDARS = ["Professional", "Personal"];
const DAYS = 7;

const password = execFileSync(
  "security",
  ["find-generic-password", "-s", "icloud-booking-app-password", "-w"],
  { encoding: "utf8" },
).trim();
const auth = "Basic " + Buffer.from(`${APPLE_ID}:${password}`).toString("base64");

async function dav(method, url, depth, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
    body,
  });
  if (res.status === 401) throw new Error("iCloud rejected the sign-in (check the Apple ID and app-specific password).");
  if (!res.ok && res.status !== 207) throw new Error(`${method} ${new URL(url).pathname} failed: ${res.status}`);
  return { text: await res.text(), url: res.url };
}

// Pull the first <tag>...</tag> href inside a named property.
function hrefIn(xml, prop) {
  const m = xml.match(new RegExp(`<[^>]*${prop}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)<`, "i"));
  return m?.[1];
}

// iCloud times look like 20260928T140000Z. Turn them into readable Eastern time.
function pretty(value) {
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} (all day)`;
  const iso = value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/, "$1-$2-$3T$4:$5:$6$7");
  const d = new Date(iso);
  if (isNaN(d)) return value;
  return d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const start = new Date();
const end = new Date(start.getTime() + DAYS * 86400000);

// 1. Who am I?
const who = await dav("PROPFIND", "https://caldav.icloud.com/", 0,
  `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
const principal = new URL(hrefIn(who.text, "current-user-principal"), who.url).href;

// 2. Where do my calendars live?
const home = await dav("PROPFIND", principal, 0,
  `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`);
const homeUrl = new URL(hrefIn(home.text, "calendar-home-set"), home.url).href;

// 3. List calendars and find the two we care about.
const list = await dav("PROPFIND", homeUrl, 1,
  `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`);
const found = {};
for (const block of list.text.split(/<[^>]*response[ >]/i).slice(1)) {
  const href = block.match(/<[^>]*href[^>]*>([^<]+)</i)?.[1];
  const name = block.match(/<[^>]*displayname[^>]*>([^<]*)</i)?.[1];
  if (href && name && CALENDARS.includes(name.trim())) found[name.trim()] = new URL(href, list.url).href;
}
console.log(`Signed in to iCloud. Found calendars: ${Object.keys(found).join(", ") || "none"}`);
for (const name of CALENDARS) if (!found[name]) console.log(`  Could not find a calendar named "${name}".`);

// 4. Ask each calendar for events in the window, with repeating events expanded.
for (const [name, url] of Object.entries(found)) {
  const report = await dav("REPORT", url, 1, `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand start="${stamp(start)}" end="${stamp(end)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${stamp(start)}" end="${stamp(end)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`);

  const busy = [];
  for (const ev of report.text.split("BEGIN:VEVENT").slice(1)) {
    const body = ev.split("END:VEVENT")[0].replace(/\r?\n[ \t]/g, "");
    if (/^TRANSP:TRANSPARENT/m.test(body)) continue; // marked "free", doesn't block
    const s = body.match(/^DTSTART[^:]*:(\S+)/m)?.[1];
    const e = body.match(/^DTEND[^:]*:(\S+)/m)?.[1];
    if (s) busy.push([s, `  ${pretty(s)}  to  ${e ? pretty(e) : "(no end time)"}`]);
  }
  busy.sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\n${name}: ${busy.length} busy block(s) in the next ${DAYS} days`);
  for (const [, line] of busy) console.log(line);
}
