// Time zone helpers built on the Intl API that Cloudflare Workers provide.
// Everything inside the app is a UTC millisecond timestamp; these convert
// to and from wall-clock times in a named zone (handling daylight saving).

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// How far ahead of UTC the zone is at this instant, in milliseconds (Eastern is negative).
function offsetAt(ms: number, timeZone: string): number {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in a zone -> UTC timestamp. Example: 9:00am New York on Sept 30.
export function zonedToUtc(y: number, month: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, month - 1, d, h, min);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second;
}

// UTC timestamp -> the calendar date in a zone, as [year, month, day].
export function zonedDate(ms: number, timeZone: string): [number, number, number] {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return [+p.year, +p.month, +p.day];
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
