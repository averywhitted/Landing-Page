-- Pre-launch audit fixes.

-- Refunds. refund_requested_at is set when a refund is owed and should be sent
-- automatically (client cancelled in time, paid after their time was taken, or
-- Avery chose "refund" when cancelling). It's retried until Stripe confirms.
ALTER TABLE bookings ADD COLUMN refund_requested_at TEXT;
ALTER TABLE bookings ADD COLUMN refund_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN refund_error TEXT;

-- The name and pronouns given with each booking or bundle, so a later booking
-- made with the same email address can't rename earlier ones.
ALTER TABLE bookings ADD COLUMN client_name TEXT;
ALTER TABLE bookings ADD COLUMN client_pronouns TEXT;
ALTER TABLE packages ADD COLUMN client_name TEXT;
ALTER TABLE packages ADD COLUMN client_pronouns TEXT;
UPDATE bookings SET client_name = (SELECT name FROM customers c WHERE c.id = bookings.customer_id),
  client_pronouns = (SELECT pronouns FROM customers c WHERE c.id = bookings.customer_id);
UPDATE packages SET client_name = (SELECT name FROM customers c WHERE c.id = packages.customer_id),
  client_pronouns = (SELECT pronouns FROM customers c WHERE c.id = packages.customer_id);

-- Each booking can hand a session back to its bundle only once, even if two
-- cancellations arrive at the same moment.
DELETE FROM credit_ledger WHERE booking_id IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM credit_ledger WHERE booking_id IS NOT NULL GROUP BY booking_id, reason);
CREATE UNIQUE INDEX credit_ledger_once ON credit_ledger (booking_id, reason) WHERE booking_id IS NOT NULL;

-- Looking up bookings and bundles by Stripe payment (refund notices).
CREATE INDEX bookings_by_payment ON bookings (stripe_payment_intent_id);
CREATE INDEX packages_by_payment ON packages (stripe_payment_intent_id);

-- Guarantees the database enforces itself, whatever the code does:
-- 1. A refunded booking can never become active again.
CREATE TRIGGER refunded_stays_cancelled BEFORE UPDATE OF status ON bookings
WHEN NEW.status IN ('held', 'confirmed') AND (OLD.refunded_at IS NOT NULL OR OLD.refund_requested_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'refunded booking cannot be active');
END;

-- 2. Only held or confirmed bookings can block time on the schedule.
CREATE TRIGGER claims_only_for_active BEFORE INSERT ON slot_claims
WHEN COALESCE((SELECT status FROM bookings WHERE id = NEW.booking_id), '') NOT IN ('held', 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'only active bookings can claim time');
END;
