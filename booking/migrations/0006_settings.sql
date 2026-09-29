-- Settings Avery can change from the admin page (working hours, buffer, ...).
-- The defaults live in src/settings.ts; a row here overrides them.

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,     -- JSON
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by  TEXT
);
