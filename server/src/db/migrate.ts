import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Logger } from "pino";

// Migrations live as source (server/migrations) but ship alongside the compiled
// output (server/dist/migrations) - resolve whichever exists next to this module.
function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "..", "..", "migrations"), // src/db -> server/migrations (dev)
    path.resolve(import.meta.dirname, "..", "migrations"), // dist/db -> dist/migrations (build copies it here)
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`Could not locate migrations directory. Checked: ${candidates.join(", ")}`);
}

// Uses SQLite's own online backup API (not a raw file copy, which could catch
// the DB mid-write under WAL mode) to snapshot the database before applying
// pending migrations - cheap insurance for anyone upgrading between releases,
// since the DB is otherwise rebuildable from source media but a bad migration
// shouldn't force that.
const MAX_MIGRATION_BACKUPS = 5;

async function backupDatabaseFile(db: Database.Database, dbPath: string, logger: Logger): Promise<void> {
  if (!fs.existsSync(dbPath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-migration-${stamp}.bak`;
  await db.backup(backupPath);
  logger.info({ backupPath }, "Backed up database before applying migrations");

  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const oldBackups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.pre-migration-`) && f.endsWith(".bak"))
    .sort();
  for (const stale of oldBackups.slice(0, -MAX_MIGRATION_BACKUPS)) {
    fs.unlinkSync(path.join(dir, stale));
  }
}

export async function runMigrations(db: Database.Database, dbPath: string, logger: Logger): Promise<void> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const migrationsDir = resolveMigrationsDir();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name),
  );

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length > 0) await backupDatabaseFile(db, dbPath, logger);

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    logger.info({ migration: file }, "Applying database migration");
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    });
    applyMigration();
  }
}
