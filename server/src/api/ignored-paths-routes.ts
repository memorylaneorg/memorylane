import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { IgnoredPathDto, IgnoreFolderResultDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { thumbnailPathForMediaId, previewPathForMediaId } from "../config/paths.js";

interface IgnoredPathRow {
  id: number;
  path: string;
  created_at: string;
}

function toIgnoredPathDto(row: IgnoredPathRow): IgnoredPathDto {
  return { id: row.id, path: row.path, createdAt: row.created_at };
}

const DESCENDANT_FOLDERS_CTE = `
  WITH RECURSIVE descendant_folders(id) AS (
    SELECT id FROM folders WHERE id = ?
    UNION ALL
    SELECT f.id FROM folders f JOIN descendant_folders d ON f.parent_id = d.id
  )
`;

export async function registerIgnoredPathsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, paths } = ctx;

  app.get("/api/ignored-paths", { preHandler: app.requireAuth }, async (_request, reply) => {
    const rows = db.prepare("SELECT * FROM ignored_paths ORDER BY path").all() as IgnoredPathRow[];
    return reply.send(rows.map(toIgnoredPathDto));
  });

  // Un-ignoring only removes the path from the list - it does not restore
  // anything. The folder (and any files still on disk under it) will be
  // picked back up fresh on the next scan, same as any other new folder.
  app.delete("/api/ignored-paths/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    db.prepare("DELETE FROM ignored_paths WHERE id = ?").run(id);
    return reply.code(204).send();
  });

  app.post("/api/folders/:id/ignore", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const folder = db.prepare(`SELECT folders.id, folders.parent_id, folders.absolute_path, scan_roots.kind
      FROM folders JOIN scan_roots ON scan_roots.id = folders.scan_root_id WHERE folders.id = ?`).get(id) as
      | { id: number; parent_id: number | null; absolute_path: string; kind: string }
      | undefined;
    if (!folder) return reply.code(404).send({ error: "Folder not found" });
    if (folder.kind === "apple-photos") {
      return reply.code(409).send({ error: "Apple Photos libraries cannot be ignored as ordinary folders; disable the plugin or remove the library root instead" });
    }

    // Collect every media id under this folder's subtree (itself included)
    // before deleting anything, so their cached thumbnail/preview files on
    // disk can be cleaned up too - the cascading DB delete below only
    // removes rows, not files.
    const mediaIds = (
      db
        .prepare(
          `${DESCENDANT_FOLDERS_CTE}
           SELECT id FROM media WHERE parent_folder_id IN (SELECT id FROM descendant_folders)`,
        )
        .all(id) as { id: number }[]
    ).map((r) => r.id);

    const folderCount = (
      db.prepare(`${DESCENDANT_FOLDERS_CTE} SELECT COUNT(*) as c FROM descendant_folders`).get(id) as { c: number }
    ).c;

    await Promise.all(
      mediaIds.flatMap((mediaId) => [
        fs.unlink(thumbnailPathForMediaId(paths.thumbnailsDir, mediaId)).catch(() => {}),
        fs.unlink(previewPathForMediaId(paths.previewsDir, mediaId)).catch(() => {}),
      ]),
    );

    const addIgnoredPath = db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO ignored_paths (path) VALUES (?)").run(folder.absolute_path);
      // Cascades to every descendant folder, every media row under them, and
      // (via further cascade) their favorites/engagement rows - see the
      // ON DELETE CASCADE chain in migrations 003/006. FTS tables stay in
      // sync automatically too, via the folders_ad/media_ad triggers, which
      // SQLite also fires for cascaded deletes.
      db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    });
    addIgnoredPath();

    const result: IgnoreFolderResultDto = {
      ignoredPath: folder.absolute_path,
      parentFolderId: folder.parent_id,
      removedFolderCount: folderCount,
      removedMediaCount: mediaIds.length,
    };
    return reply.send(result);
  });
}
