-- Students can pause or stop check-in emails themselves, from the link at the
-- bottom of each one. email_paused_until is a time (year 9999 means "for good");
-- email_paused_at is when they chose. Your own "don't email" flag (no_email) is separate.
ALTER TABLE customers ADD COLUMN email_paused_until TEXT;
ALTER TABLE customers ADD COLUMN email_paused_at TEXT;
