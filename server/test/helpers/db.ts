import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";

const silentLogger = { info() {}, warn() {}, error() {} } as unknown as import("pino").Logger;

// In-memory SQLite with the full production schema. runMigrations resolves
// server/migrations relative to src/db, and skips the pre-migration backup
// because ":memory:" doesn't exist on disk (but it still awaits, so this
// helper is async).
export async function createTestDb(): Promise<Database.Database> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  await runMigrations(db, ":memory:", silentLogger);
  return db;
}

export function seedScanRoot(db: Database.Database, path = "/library"): number {
  const info = db.prepare("INSERT INTO scan_roots (path, enabled) VALUES (?, 1)").run(path);
  return Number(info.lastInsertRowid);
}

export function seedFolder(
  db: Database.Database,
  scanRootId: number,
  absolutePath: string,
  parentId: number | null = null,
): number {
  const name = absolutePath.split("/").filter(Boolean).pop() ?? absolutePath;
  const info = db
    .prepare("INSERT INTO folders (scan_root_id, parent_id, name, absolute_path) VALUES (?, ?, ?, ?)")
    .run(scanRootId, parentId, name, absolutePath);
  return Number(info.lastInsertRowid);
}

export interface SeedMediaOverrides {
  filename?: string;
  media_type?: "image" | "raw" | "video";
  status?: "active" | "missing";
  thumbnail_status?: "pending" | "done" | "failed" | "unsupported";
  captured_date?: string | null;
  fingerprint?: string;
  fs_created_at?: string | null;
}

let seedCounter = 0;

export function seedMedia(db: Database.Database, folderId: number, scanRootId: number, o: SeedMediaOverrides = {}): number {
  seedCounter++;
  const filename = o.filename ?? `IMG_${String(seedCounter).padStart(4, "0")}.jpg`;
  const ext = filename.split(".").pop()!.toLowerCase();
  const info = db
    .prepare(
      `INSERT INTO media (parent_folder_id, scan_root_id, absolute_path, filename, extension, media_type,
         file_size, fs_created_at, fs_modified_at, fingerprint, thumbnail_status, status, captured_date)
       VALUES (?, ?, ?, ?, ?, ?, 1000, ?, '2020-01-01T00:00:00.000Z', ?, ?, ?, ?)`,
    )
    .run(
      folderId, scanRootId, `/library/${folderId}/${filename}`, filename, ext, o.media_type ?? "image",
      o.fs_created_at ?? "2020-01-01T00:00:00.000Z", o.fingerprint ?? "1000:1", o.thumbnail_status ?? "done",
      o.status ?? "active", o.captured_date ?? null,
    );
  return Number(info.lastInsertRowid);
}
