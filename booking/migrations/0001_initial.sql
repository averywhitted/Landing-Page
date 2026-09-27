-- First version of the booking database.
-- All times are stored in UTC as text like 2026-09-30T18:00:00Z,
-- which sorts correctly and converts cleanly for display.

-- People who have booked.
CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pronouns    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Every booking, from the moment a slot is held until it's done or cancelled.
CREATE TABLE bookings (
  id                          TEXT PRIMARY KEY,
  customer_id                 TEXT NOT NULL REFERENCES customers(id),
  service_id                  TEXT NOT NULL,             -- matches an id in src/services.ts
  start_utc                   TEXT NOT NULL,
  end_utc                     TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'completed')),
  hold_expires_at             TEXT,                      -- only for 'held' bookings
  amount_cents                INTEGER NOT NULL DEFAULT 0, -- what was actually charged
  promo_code                  TEXT,
  stripe_checkout_session_id  TEXT UNIQUE,
  package_id                  TEXT,                      -- used once bundles arrive (Phase 3)
  zoom_meeting_id             TEXT,
  zoom_join_url               TEXT,
  calendar_event_url          TEXT,                      -- where the event lives in the Coaching calendar
  ics_uid                     TEXT NOT NULL UNIQUE,      -- stays the same for the life of the booking
  ics_sequence                INTEGER NOT NULL DEFAULT 0, -- goes up by one each reschedule
  intake_json                 TEXT,                      -- intake form answers
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX bookings_by_start ON bookings (start_utc);
CREATE INDEX bookings_by_hold ON bookings (status, hold_expires_at);

-- The double-booking guard. The day is split into 15-minute blocks.
-- A booking claims every block it covers plus one block of buffer after it.
-- Each block can only be claimed once, so the database itself refuses a
-- second booking that overlaps, even if two people click at the same instant.
-- When a booking is cancelled or its hold expires, its claims are deleted.
CREATE TABLE slot_claims (
  slot_start  TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX slot_claims_by_booking ON slot_claims (booking_id);

-- Stripe sometimes sends the same notification twice. Recording each one
-- here lets us safely ignore repeats.
CREATE TABLE processed_webhooks (
  stripe_event_id  TEXT PRIMARY KEY,
  processed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
