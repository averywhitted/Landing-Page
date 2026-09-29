-- Merging duplicate students, and remembering "these two are different people".

-- An old email address that now belongs to a merged (or re-emailed) student.
-- If someone books again with it, the booking goes to that student instead of
-- creating a duplicate.
CREATE TABLE customer_aliases (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX customer_aliases_by_customer ON customer_aliases (customer_id);

-- Pairs Avery has marked "not the same person" (a_id < b_id), so they stop being suggested.
CREATE TABLE duplicate_ignores (
  a_id  TEXT NOT NULL,
  b_id  TEXT NOT NULL,
  PRIMARY KEY (a_id, b_id)
);
