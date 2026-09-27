// The one place prices and session types live. Change a price here and
// every page, checkout, and email picks it up. Prices are in cents.

export type Service = {
  id: string;
  name: string;
  kind: "intro" | "single" | "bundle";
  durationMinutes: number;
  priceCents: number;
  credits?: number; // bundles only: how many 60-minute sessions it includes
  // "on-request": Zoom by default, in person only if the client reaches out first.
  // "only": in person only (for example, a future in-person workshop).
  inPerson: "on-request" | "only";
  blurb: string; // one line shown on the booking page
};

export const IN_PERSON_NOTE = "Sessions are on Zoom. Reach out before booking if you'd like to meet in person.";

export const SERVICES: Service[] = [
  { id: "intro-15", name: "General Meeting", kind: "intro", durationMinutes: 15, priceCents: 0, inPerson: "on-request",
    blurb: "A relaxed 15 minute call to get acquainted." },
  { id: "coaching-30", name: "Private Coaching Session, 30 min", kind: "single", durationMinutes: 30, priceCents: 7500, inPerson: "on-request",
    blurb: "Audition prep, quick-turnaround sides, and last-minute confidence before you go on tape." },
  { id: "coaching-60", name: "Private Coaching Session, 1 hour", kind: "single", durationMinutes: 60, priceCents: 13000, inPerson: "on-request",
    blurb: "Deeper script work, making and testing strong choices, and self-tape support." },
  { id: "coaching-90", name: "Private Coaching Session, 90 min", kind: "single", durationMinutes: 90, priceCents: 19500, inPerson: "on-request",
    blurb: "A full deep dive: multiple pieces, layered choice work, or a self-tape session with time to record, review, and retake." },
  { id: "bundle-2", name: "2 Session Bundle", kind: "bundle", durationMinutes: 60, priceCents: 23000, credits: 2, inPerson: "on-request",
    blurb: "Two one-hour private coaching sessions over Zoom." },
  { id: "bundle-3", name: "3 Session Bundle", kind: "bundle", durationMinutes: 60, priceCents: 34000, credits: 3, inPerson: "on-request",
    blurb: "Three one-hour private coaching sessions over Zoom." },
  { id: "bundle-4", name: "4 Session Bundle", kind: "bundle", durationMinutes: 60, priceCents: 44000, credits: 4, inPerson: "on-request",
    blurb: "Four one-hour private coaching sessions over Zoom." },
];

export function findService(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}
