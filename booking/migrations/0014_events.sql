-- A running log of what each connection (Stripe, iCloud, Resend, Zoom, the
-- database, backups, Turnstile) has been up to, shown under the status lights
-- in the admin. Short plain sentences only: no card numbers, no email
-- addresses, no message contents.
CREATE TABLE integration_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service     TEXT NOT NULL,   -- stripe, icloud, resend, zoom, database, backups, turnstile
  level       TEXT NOT NULL,   -- ok, info, warn, error
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX integration_events_by_service ON integration_events (service, id DESC);
