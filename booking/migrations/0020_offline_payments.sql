-- Money Avery collects outside Stripe (cash, Venmo, Zelle...) and amounts
-- Avery lets go. Each record is for one of:
--   a session Avery booked   (booking_id)              comes off what's owed
--   a payment request        (request_id + booking_id) comes off the request
--   a bundle sold directly   (package_id)              the whole price
-- Once nothing is left on a session or request, it counts as paid.
-- These are records only: nothing here is ever refunded through Stripe.
CREATE TABLE offline_payments (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT REFERENCES bookings(id),
  request_id   TEXT REFERENCES payment_requests(id),
  package_id   TEXT REFERENCES packages(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  method       TEXT NOT NULL CHECK (method IN ('cash', 'venmo', 'zelle', 'check', 'other', 'waived')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on  TEXT NOT NULL,              -- YYYY-MM-DD in Avery's time zone
  note         TEXT,
  settled      INTEGER NOT NULL DEFAULT 0, -- this one paid it off (and set paid_at / status 'paid')
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at   TEXT NOT NULL,
  removed_at   TEXT,
  CHECK ((booking_id IS NULL) <> (package_id IS NULL)),
  CHECK (request_id IS NULL OR booking_id IS NOT NULL),
  CHECK (package_id IS NULL OR method <> 'waived')
);
CREATE INDEX offline_payments_by_booking ON offline_payments (booking_id);
CREATE INDEX offline_payments_by_customer ON offline_payments (customer_id);

-- Running totals of the active rows above, so "what's owed" is one subtraction.
-- (A request's records count toward the request, not the session.)
ALTER TABLE bookings ADD COLUMN offline_cents INTEGER NOT NULL DEFAULT 0; -- received outside Stripe
ALTER TABLE bookings ADD COLUMN waived_cents INTEGER NOT NULL DEFAULT 0;  -- let go
ALTER TABLE payment_requests ADD COLUMN offline_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_requests ADD COLUMN waived_cents INTEGER NOT NULL DEFAULT 0;
-- A bundle sold outside Stripe: what they paid. amount_cents stays card only.
ALTER TABLE packages ADD COLUMN offline_cents INTEGER NOT NULL DEFAULT 0;

-- Never more than the price, whatever the code does.
CREATE TRIGGER offline_within_price BEFORE UPDATE OF offline_cents, waived_cents ON bookings
WHEN NEW.offline_cents < 0 OR NEW.waived_cents < 0 OR NEW.offline_cents + NEW.waived_cents > COALESCE(NEW.price_cents, 0)
BEGIN
  SELECT RAISE(ABORT, 'offline payments exceed the price');
END;
CREATE TRIGGER offline_within_request BEFORE UPDATE OF offline_cents, waived_cents ON payment_requests
WHEN NEW.offline_cents < 0 OR NEW.waived_cents < 0 OR NEW.offline_cents + NEW.waived_cents > NEW.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'offline payments exceed the request');
END;
