-- "Time to follow up" prompts: a week (by default) after a student's last
-- session, if they have nothing booked. Both columns hold the start time of the
-- session the prompt was about, so a newer session starts a fresh prompt.
-- followup_done_for: Avery dismissed it. followup_emailed_for: it was in her daily email.
ALTER TABLE customers ADD COLUMN followup_done_for TEXT;
ALTER TABLE customers ADD COLUMN followup_emailed_for TEXT;

-- The new "After a recent session" email template ('followup'). SQLite can't
-- change a CHECK constraint, so the table is copied into a new one with it added.
CREATE TABLE nudge_emails_new (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  template     TEXT NOT NULL CHECK (template IN ('followup', 'checkin', 'coming_up', 'intro', 'credits', 'custom')),
  subject      TEXT,
  body         TEXT,
  button       INTEGER NOT NULL DEFAULT 1, -- unused
  send_at      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'skipped', 'cancelled', 'failed')),
  note         TEXT,      -- why it was skipped or failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO nudge_emails_new (id, customer_id, template, subject, body, button, send_at, status, note, attempts, sent_at, created_at)
  SELECT id, customer_id, template, subject, body, button, send_at, status, note, attempts, sent_at, created_at FROM nudge_emails;
DROP TABLE nudge_emails;
ALTER TABLE nudge_emails_new RENAME TO nudge_emails;
CREATE INDEX nudge_emails_by_customer ON nudge_emails (customer_id);
CREATE INDEX nudge_emails_due ON nudge_emails (status, send_at);
