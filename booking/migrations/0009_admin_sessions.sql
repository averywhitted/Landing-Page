-- Sessions Avery books for students from the admin page.

-- A group session: one time, one Zoom meeting, one calendar event, several
-- students. Each student is a booking row with group_id set.
CREATE TABLE groups (
  id                  TEXT PRIMARY KEY,
  service_id          TEXT NOT NULL,
  start_utc           TEXT NOT NULL,
  end_utc             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  ics_uid             TEXT NOT NULL UNIQUE,
  ics_sequence        INTEGER NOT NULL DEFAULT 0,
  calendar_event_url  TEXT,
  zoom_meeting_id     TEXT,
  zoom_join_url       TEXT,
  previous_start_utc  TEXT,
  cancelled_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

ALTER TABLE bookings ADD COLUMN group_id TEXT REFERENCES groups(id);
ALTER TABLE bookings ADD COLUMN created_by TEXT;               -- 'admin' when Avery booked it
ALTER TABLE bookings ADD COLUMN price_cents INTEGER;           -- what an admin-booked session costs
ALTER TABLE bookings ADD COLUMN pay_by TEXT;                   -- unpaid by then: released automatically
ALTER TABLE bookings ADD COLUMN paid_at TEXT;
ALTER TABLE bookings ADD COLUMN payment_reminder_sent_at TEXT;
ALTER TABLE bookings ADD COLUMN invite_message TEXT;           -- Avery's note in the invite
CREATE INDEX bookings_by_group ON bookings (group_id);
CREATE INDEX bookings_by_pay_by ON bookings (status, pay_by);

-- Time can now be held by a booking or by a group session. The table is
-- rebuilt because SQLite can't change a column's constraints in place.
DROP TRIGGER claims_only_for_active;
CREATE TABLE slot_claims_new (
  slot_start  TEXT PRIMARY KEY,
  booking_id  TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  group_id    TEXT REFERENCES groups(id) ON DELETE CASCADE,
  CHECK ((booking_id IS NULL) <> (group_id IS NULL))
);
INSERT INTO slot_claims_new (slot_start, booking_id) SELECT slot_start, booking_id FROM slot_claims;
DROP TABLE slot_claims;
ALTER TABLE slot_claims_new RENAME TO slot_claims;
CREATE INDEX slot_claims_by_booking ON slot_claims (booking_id);
CREATE INDEX slot_claims_by_group ON slot_claims (group_id);

-- Only held or confirmed bookings, or active group sessions, can block time.
CREATE TRIGGER claims_only_for_active BEFORE INSERT ON slot_claims
WHEN (NEW.booking_id IS NOT NULL AND COALESCE((SELECT status FROM bookings WHERE id = NEW.booking_id), '') NOT IN ('held', 'confirmed'))
  OR (NEW.group_id IS NOT NULL AND COALESCE((SELECT status FROM groups WHERE id = NEW.group_id), '') <> 'active')
BEGIN
  SELECT RAISE(ABORT, 'only active bookings can claim time');
END;
