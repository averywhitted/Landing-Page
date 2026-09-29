-- Payment reminders: how many went out and when the last one did (automatic
-- or sent by Avery), so they don't clash.
ALTER TABLE bookings ADD COLUMN payment_reminders_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN last_payment_reminder_at TEXT;

-- Refunds can be partial (a goodwill refund on a past session, part of a
-- bundle). refunded_at still means "refunded in full".
ALTER TABLE bookings ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packages ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
UPDATE bookings SET refunded_cents = amount_cents WHERE refunded_at IS NOT NULL;
UPDATE packages SET refunded_cents = COALESCE(refund_due_cents, 0) WHERE refunded_at IS NOT NULL;

-- Attendance on past sessions ('no_show'; nothing means it happened).
ALTER TABLE bookings ADD COLUMN attendance TEXT;

-- Avery's private notes about a student.
ALTER TABLE customers ADD COLUMN notes TEXT;

-- Refund requests from students (for things that can't be refunded online,
-- like a session that already happened). Avery grants or declines each one.
CREATE TABLE refund_requests (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('booking', 'package')),
  target_id    TEXT NOT NULL,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  message      TEXT,
  status       TEXT NOT NULL CHECK (status IN ('open', 'granted', 'declined')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  resolved_at  TEXT
);
CREATE UNIQUE INDEX refund_requests_one_open ON refund_requests (kind, target_id) WHERE status = 'open';

-- Health of the connection to iCloud (alert Avery if it's down).
CREATE TABLE health (
  key            TEXT PRIMARY KEY,
  failing_since  TEXT,
  last_error     TEXT,
  last_ok        TEXT,
  alerted_at     TEXT
);
