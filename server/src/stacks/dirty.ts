import type Database from "better-sqlite3";

// Queues folders for stack recompute (stack_dirty_folders). Called by the
// scanner (new/changed/missing files), the phash analyzer (new hashes), and
// the settings route (threshold change); drained by StackService.recomputeDirty
// from the AnalysisWorker's idle hook.
export function markFoldersDirty(db: Database.Database, folderIds: Iterable<number>): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO stack_dirty_folders (folder_id) VALUES (?)");
  for (const id of new Set(folderIds)) stmt.run(id);
}
