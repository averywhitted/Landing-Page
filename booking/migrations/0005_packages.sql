-- Session bundles ("packages") and their credits.

CREATE TABLE packages (
  id                          TEXT PRIMARY KEY,
  customer_id                 TEXT NOT NULL REFERENCES customers(id),
  service_id                  TEXT NOT NULL,              -- bundle-2 / bundle-3 / bundle-4 in src/services.ts
  status                      TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled')),
  credits_total               INTEGER NOT NULL,
  credits_used                INTEGER NOT NULL DEFAULT 0,
  expires_at                  TEXT,                       -- set when payment completes
  amount_cents                INTEGER NOT NULL DEFAULT 0,
  promo_code                  TEXT,
  stripe_checkout_session_id  TEXT UNIQUE,
  stripe_payment_intent_id    TEXT,
  intake_json                 TEXT,
  client_time_zone            TEXT,
  ip_hash                     TEXT,
  confirmation_sent_at        TEXT,
  admin_email_sent_at         TEXT,
  expiry_notice_sent_at       TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- The database itself refuses to overdraw a bundle, even with two bookings at once.
  CHECK (credits_used >= 0 AND credits_used <= credits_total)
);
CREATE INDEX packages_by_customer ON packages (customer_id, status);

-- Every change to a bundle's credits, never overwritten.
CREATE TABLE credit_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id  TEXT NOT NULL REFERENCES packages(id),
  booking_id  TEXT,
  delta       INTEGER NOT NULL,   -- +4 purchase, -1 session booked, +1 cancelled in time, +/- admin
  reason      TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX credit_ledger_by_package ON credit_ledger (package_id);
CREATE INDEX bookings_by_package ON bookings (package_id);
