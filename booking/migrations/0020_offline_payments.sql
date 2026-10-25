-- Money Avery collects outside Stripe (cash, Venmo, Zelle...) for a session
-- Avery booked, and amounts Avery lets go. Both come off what the student owes;
-- once nothing is left, the session counts as paid.
-- These are records only: nothing here is ever refunded through Stripe.
CREATE TABLE offline_payments (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  method       TEXT NOT NULL CHECK (method IN ('cash', 'venmo', 'zelle', 'check', 'other', 'waived')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on  TEXT NOT NULL,              -- YYYY-MM-DD in Avery's time zone
  note         TEXT,
  settled      INTEGER NOT NULL DEFAULT 0, -- this one paid the session off (and set bookings.paid_at)
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at   TEXT NOT NULL,
  removed_at   TEXT
);
CREATE INDEX offline_payments_by_booking ON offline_payments (booking_id);
CREATE INDEX offline_payments_by_customer ON offline_payments (customer_id);

-- Running totals of the active rows above, so "what's owed" is one subtraction.
ALTER TABLE bookings ADD COLUMN offline_cents INTEGER NOT NULL DEFAULT 0; -- received outside Stripe
ALTER TABLE bookings ADD COLUMN waived_cents INTEGER NOT NULL DEFAULT 0;  -- let go

-- Never more than the session's price, whatever the code does.
CREATE TRIGGER offline_within_price BEFORE UPDATE OF offline_cents, waived_cents ON bookings
WHEN NEW.offline_cents < 0 OR NEW.waived_cents < 0 OR NEW.offline_cents + NEW.waived_cents > COALESCE(NEW.price_cents, 0)
BEGIN
  SELECT RAISE(ABORT, 'offline payments exceed the price');
END;
