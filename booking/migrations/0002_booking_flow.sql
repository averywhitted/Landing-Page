-- Columns and tables for holds, payment, confirmation, and reminders.

ALTER TABLE bookings ADD COLUMN client_time_zone TEXT;         -- for showing times in emails
ALTER TABLE bookings ADD COLUMN cancel_reason TEXT;            -- e.g. 'hold_expired', 'slot_taken_after_payment'
ALTER TABLE bookings ADD COLUMN confirmed_at TEXT;
ALTER TABLE bookings ADD COLUMN client_email_sent_at TEXT;     -- confirmation email to the client
ALTER TABLE bookings ADD COLUMN admin_email_sent_at TEXT;      -- notification to Avery
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;         -- "finish your booking" email
ALTER TABLE bookings ADD COLUMN refunded_at TEXT;
ALTER TABLE bookings ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE bookings ADD COLUMN ip_hash TEXT;                  -- salted hash, only for limiting abuse

CREATE INDEX bookings_by_customer ON bookings (customer_id, status);
CREATE INDEX bookings_by_ip ON bookings (ip_hash, status);

-- One row per email attempt, so failures can be retried and seen later.
-- No addresses or message bodies are stored here.
CREATE TABLE email_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  TEXT,
  kind        TEXT NOT NULL,   -- client_confirmation, admin_notification, checkout_reminder, ...
  status      TEXT NOT NULL,   -- sent, failed, skipped
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX email_log_by_booking ON email_log (booking_id);
