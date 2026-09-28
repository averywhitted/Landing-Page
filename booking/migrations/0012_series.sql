-- Repeating sessions. A series books the next session automatically once
-- the previous one has ended, at the same weekday and time.
CREATE TABLE series (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  service_id       TEXT NOT NULL,
  started_by       TEXT NOT NULL CHECK (started_by IN ('admin', 'client')),
  every_weeks      INTEGER NOT NULL CHECK (every_weeks BETWEEN 1 AND 4),
  sessions_left    INTEGER,          -- more sessions to book; NULL = until stopped
  last_start       TEXT NOT NULL,    -- the latest session booked (or skipped)
  price_cents      INTEGER NOT NULL, -- for each session after the first
  pay_by_rule      TEXT NOT NULL,    -- 'none' | 'before24'
  status           TEXT NOT NULL CHECK (status IN ('pending', 'active', 'stopped', 'ended')),
  stopped_reason   TEXT,
  misses           INTEGER NOT NULL DEFAULT 0, -- unpaid sessions in a row
  client_name      TEXT,
  client_pronouns  TEXT,
  client_time_zone TEXT,
  message          TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX series_active ON series (status, last_start);

ALTER TABLE bookings ADD COLUMN series_id TEXT REFERENCES series(id);
CREATE INDEX bookings_by_series ON bookings (series_id);
