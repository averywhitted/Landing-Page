-- "Been a while" emails Avery sends (or schedules) from a student's profile.

-- Students Avery has marked "don't email". Their nudge button is off and any
-- scheduled nudge for them is skipped.
ALTER TABLE customers ADD COLUMN no_email INTEGER NOT NULL DEFAULT 0;

CREATE TABLE nudge_emails (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  template     TEXT NOT NULL CHECK (template IN ('checkin', 'coming_up', 'intro', 'credits', 'custom')),
  subject      TEXT,      -- custom emails only
  body         TEXT,      -- custom emails only
  button       INTEGER NOT NULL DEFAULT 1, -- custom emails only: include the "Book a session" button
  send_at      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'skipped', 'cancelled', 'failed')),
  note         TEXT,      -- why it was skipped or failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX nudge_emails_by_customer ON nudge_emails (customer_id);
CREATE INDEX nudge_emails_due ON nudge_emails (status, send_at);
