-- Students Avery adds by hand (no session yet). They show in the Students list
-- even though they have no bookings.
ALTER TABLE customers ADD COLUMN added_manually INTEGER NOT NULL DEFAULT 0;
