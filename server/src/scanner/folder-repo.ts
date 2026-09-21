import type Database from "better-sqlite3";

interface FolderRow {
  id: number;
  scan_root_id: number;
  parent_id: number | null;
  name: string;
  absolute_path: string;
}

export function getOrCreateFolder(
  db: Database.Database,
  scanRootId: number,
  parentId: number | null,
  name: string,
  absolutePath: string,
): FolderRow {
  const existing = db.prepare("SELECT * FROM folders WHERE absolute_path = ?").get(absolutePath) as
    | FolderRow
    | undefined;
  if (existing) {
    db.prepare(
      "UPDATE folders SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(existing.id);
    return existing;
  }
  const info = db
    .prepare("INSERT INTO folders (scan_root_id, parent_id, name, absolute_path) VALUES (?, ?, ?, ?)")
    .run(scanRootId, parentId, name, absolutePath);
  return db.prepare("SELECT * FROM folders WHERE id = ?").get(info.lastInsertRowid) as FolderRow;
}
