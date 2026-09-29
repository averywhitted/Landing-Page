// Checks that a backup can really be restored, without touching anything live.
//
//   npm run check-backup -- ~/Downloads/booking-backup.json      (from Admin > Settings)
//   npm run check-backup -- ~/Downloads/2026-10-01.json.gz       (a nightly copy from R2)
//
// It builds a throwaway database from this repo's migrations, loads every row
// from the backup into it, and checks that nothing is missing or broken
// (row counts, links between tables, database integrity). It also writes
// <backup>.restore.sql next to the backup: the same rows as SQL, for loading
// into an empty, freshly migrated database if a real restore is ever needed.
// (A real restore is a deliberate step Avery runs; see LAUNCH.md.)

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

type Backup = { made: string; tables: Record<string, Record<string, unknown>[]> };
export type CheckResult = { ok: boolean; made: string; counts: Record<string, { backup: number; restored: number }>; problems: string[]; sql: string };

const sqlValue = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

export function checkBackup(json: string, migrations: string[]): CheckResult {
  const backup = JSON.parse(json) as Backup;
  if (!backup?.tables || typeof backup.tables !== "object") throw new Error("This doesn't look like a booking backup.");
  const db = new DatabaseSync(":memory:");
  for (const m of migrations) db.exec(m);
  const problems: string[] = [];
  const counts: CheckResult["counts"] = {};
  const sql: string[] = ["-- Restores a booking backup into an EMPTY, freshly migrated database.", `-- Backup made ${backup.made}.`, "PRAGMA defer_foreign_keys = ON;"];

  // Links are checked once everything is in, so the order tables load in doesn't matter.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN");
  for (const [table, rows] of Object.entries(backup.tables)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) { problems.push(`The backup has a table (${table}) this database doesn't.`); continue; }
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const row of rows) {
      const cols = Object.keys(row).filter((c) => columns.has(c));
      const missing = Object.keys(row).filter((c) => !columns.has(c));
      if (missing.length) problems.push(`${table}: column(s) ${missing.join(", ")} aren't in this database.`);
      const stmt = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      try {
        db.prepare(stmt).run(...cols.map((c) => row[c] as never));
      } catch (err) {
        problems.push(`${table}: a row couldn't be restored (${(err as Error).message}).`);
      }
      sql.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(row[c])).join(", ")});`);
    }
    const restored = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    counts[table] = { backup: rows.length, restored };
    if (restored !== rows.length) problems.push(`${table}: ${rows.length} rows in the backup, ${restored} restored.`);
  }
  db.exec("COMMIT");
  for (const f of db.prepare("PRAGMA foreign_key_check").all() as { table: string; parent: string }[]) {
    problems.push(`${f.table}: a row points to a missing ${f.parent} row.`);
  }
  const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  if (integrity !== "ok") problems.push(`Database integrity: ${integrity}`);
  for (const t of ["customers", "bookings", "packages"]) if (!(t in backup.tables)) problems.push(`The backup is missing the ${t} table.`);
  db.close();
  return { ok: problems.length === 0, made: backup.made, counts, problems: [...new Set(problems)], sql: sql.join("\n") + "\n" };
}

function readMigrations(): string[] {
  const dir = new URL("../migrations/", import.meta.url);
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(new URL(f, dir), "utf8"));
}

// Run from the command line.
if (process.argv[1]?.endsWith("check-backup.mjs")) {
  const path = process.argv[2];
  if (!path) { console.error("Use: npm run check-backup -- <backup file (.json or .json.gz)>"); process.exit(2); }
  const raw = readFileSync(path);
  const json = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const r = checkBackup(json, readMigrations());
  console.log(`Backup made ${r.made}`);
  for (const [t, c] of Object.entries(r.counts)) console.log(`  ${t.padEnd(18)} ${String(c.restored).padStart(5)} of ${c.backup} rows`);
  const out = path.replace(/(\.json)?(\.gz)?$/, "") + ".restore.sql";
  writeFileSync(out, r.sql);
  if (r.ok) console.log(`\nRestores cleanly. Restore file (only for an empty database): ${out}`);
  else { console.log("\nProblems:"); for (const p of r.problems) console.log(`  - ${p}`); process.exit(1); }
}
