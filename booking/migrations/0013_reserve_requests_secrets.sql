-- Repeating sessions that clash with Avery's calendar or a day off are held
-- (not sent to the student) until Avery keeps or moves them.
ALTER TABLE bookings ADD COLUMN series_conflict TEXT;      -- 'calendar' | 'day_off' | NULL
ALTER TABLE bookings ADD COLUMN series_conflict_at TEXT;   -- when Avery was alerted

-- Payment requests Avery sends for a session (e.g. one that happened unpaid).
CREATE TABLE payment_requests (
  id                         TEXT PRIMARY KEY,
  booking_id                 TEXT NOT NULL REFERENCES bookings(id),
  customer_id                TEXT NOT NULL REFERENCES customers(id),
  amount_cents               INTEGER NOT NULL CHECK (amount_cents > 0),
  note                       TEXT,
  status                     TEXT NOT NULL CHECK (status IN ('open', 'paid', 'cancelled')),
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  paid_cents                 INTEGER,
  paid_at                    TEXT,
  last_reminder_at           TEXT,
  reminders_sent             INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX payment_requests_by_booking ON payment_requests (booking_id);
CREATE INDEX payment_requests_open ON payment_requests (status);

-- Secrets Avery changes from the admin page (the iCloud app-specific password),
-- encrypted with a key that only exists in Cloudflare's secret storage.
-- Never included in backups or exports.
CREATE TABLE stored_secrets (
  name       TEXT PRIMARY KEY,
  iv         TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
