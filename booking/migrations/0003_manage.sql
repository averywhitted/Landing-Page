-- Rescheduling and cancelling from the client's manage link.

ALTER TABLE bookings ADD COLUMN reschedule_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN previous_start_utc TEXT;   -- the time before the latest reschedule
ALTER TABLE bookings ADD COLUMN cancelled_at TEXT;
