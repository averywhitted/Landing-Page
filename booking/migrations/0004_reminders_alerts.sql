-- Day-before session reminders and "something needs attention" alerts.

ALTER TABLE bookings ADD COLUMN session_reminder_sent_at TEXT;

-- When each kind of alert was last emailed to Avery (so alerts aren't repeated too often).
CREATE TABLE alerts_sent (
  kind          TEXT PRIMARY KEY,
  last_sent_at  TEXT NOT NULL
);
