-- Cancelling a whole bundle, and tracking its refund.

ALTER TABLE packages ADD COLUMN cancel_reason TEXT;       -- 'client_cancelled' or 'checkout_expired'
ALTER TABLE packages ADD COLUMN cancelled_at TEXT;
ALTER TABLE packages ADD COLUMN refund_due_cents INTEGER;  -- what Avery needs to refund in Stripe
ALTER TABLE packages ADD COLUMN refunded_at TEXT;
ALTER TABLE packages ADD COLUMN reminder_sent_at TEXT;    -- "finish buying your bundle" email
