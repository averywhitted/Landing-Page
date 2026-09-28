-- Why a cancelled session's calendar event or Zoom meeting couldn't be
-- removed (shown on the admin page instead of only in the logs).
ALTER TABLE bookings ADD COLUMN cleanup_error TEXT;
ALTER TABLE groups ADD COLUMN cleanup_error TEXT;

-- Bundles Avery cancels from the admin page: the refund she chose and
-- whether Stripe has confirmed it.
ALTER TABLE packages ADD COLUMN refund_error TEXT;
