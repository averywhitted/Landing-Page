// Scheduling rules. Change a number here to change how availability works.

export const RULES = {
  timeZone: "America/New_York", // Avery's working time zone
  dayStartHour: 9,               // first possible start: 9:00am
  dayEndHour: 21,                // every session must END by 9:00pm
  bufferMinutes: 15,             // gap kept before and after anything on the calendar
  minNoticeHours: 24,            // earliest a client can book is 24 hours from now
  slotStepMinutes: 30,           // offer start times every 30 minutes (9:00, 9:30, ...)
  blockMinutes: 15,              // size of each double-booking guard block (see slot_claims)
  farAheadNoticeDays: 60,        // past this, show "sessions this far out may change"
  maxDaysPerRequest: 31,         // how many days one availability lookup can cover
  holdMinutes: 31,               // slot is held while the client pays (Stripe needs at least 30)
  maxActiveHoldsPerPerson: 2,    // unpaid holds one email or network can have at once
  maxUpcomingIntros: 1,          // free intro calls one email can have booked at once
  packageValidDays: 60,          // bundles must be used within this many days of purchase
  packageExpiryNoticeDays: 7,    // "sessions expiring" email this many days before
  packageSessionService: "coaching-60", // what one bundle credit books
};

// iCloud calendars. Anything on these blocks booking; new bookings are written to bookingCalendar.
export const CALENDARS = {
  busy: ["Professional", "Personal", "Coaching"],
  booking: "Coaching",
};
