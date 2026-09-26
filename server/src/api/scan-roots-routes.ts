import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  createScanRootRequestSchema,
  updateScanRootRequestSchema,
  moveScanRootRequestSchema,
  type ScanRootDto,
  type ScanRootStatsDto,
} from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { NEEDS_TRANSCODE_SQL_CLAUSE } from "../media/video-compatibility.js";
import { isApplePhotosEnabled } from "../plugins/registry.js";
import { UNMARKED_MEDIA_SQL } from "../query/media-query.js";

interface ScanRootRow {
  id: number;
  path: string;
  kind: "folder" | "apple-photos";
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface MediaTypeAggRow {
  media_type: "image" | "raw" | "video";
  count: number;
  size: number | null;
  pending: number;
  failed: number;
}

const execFileAsync = promisify(execFile);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function pickLocalFolder(): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = 'Choose a photo folder for MemoryLane'",
        "$dialog.ShowNewFolderButton = $false",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ].join("; ");
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true });
      return stdout.trim() || null;
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("osascript", ["-e", "POSIX path of (choose folder with prompt \"Choose a photo folder for MemoryLane\")"]);
      return stdout.trim().replace(/\/$/, "") || null;
    }
    const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Choose a photo folder for MemoryLane"]);
    return stdout.trim() || null;
  } catch (error) {
    const exitCode = (error as NodeJS.ErrnoException).code;
    if (String(exitCode) === "1") return null;
    throw error;
  }
}

function getScanRootStats(db: Database.Database, scanRootId: number): ScanRootStatsDto {
  const byType = db
    .prepare(
      `SELECT media_type, COUNT(*) as count, SUM(file_size) as size,
        SUM(CASE WHEN thumbnail_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN thumbnail_status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM media WHERE scan_root_id = ? AND status = 'active' AND ${UNMARKED_MEDIA_SQL} GROUP BY media_type`,
    )
    .all(scanRootId) as MediaTypeAggRow[];

  const folderCount = (
    db.prepare("SELECT COUNT(*) as c FROM folders WHERE scan_root_id = ? AND status = 'active'").get(scanRootId) as {
      c: number;
    }
  ).c;

  const transcodeCandidateCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM media
         WHERE scan_root_id = ? AND media_type = 'video' AND status = 'active' AND ${UNMARKED_MEDIA_SQL}
           AND (source_kind IS NULL OR source_kind != 'apple-photos') AND ${NEEDS_TRANSCODE_SQL_CLAUSE}`,
      )
      .get(scanRootId) as { c: number }
  ).c;

  const stats: ScanRootStatsDto = {
    mediaCount: 0,
    photoCount: 0,
    rawCount: 0,
    videoCount: 0,
    folderCount,
    totalSizeBytes: 0,
    pendingThumbnails: 0,
    failedThumbnails: 0,
    transcodeCandidateCount,
  };

  for (const row of byType) {
    stats.mediaCount += row.count;
    stats.totalSizeBytes += row.size ?? 0;
    stats.pendingThumbnails += row.pending;
    stats.failedThumbnails += row.failed;
    if (row.media_type === "image") stats.photoCount += row.count;
    else if (row.media_type === "raw") stats.rawCount += row.count;
    else if (row.media_type === "video") stats.videoCount += row.count;
  }

  return stats;
}

function toDto(db: Database.Database, row: ScanRootRow): ScanRootDto {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: getScanRootStats(db, row.id),
  };
}

export async function registerScanRootRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get("/api/scan-roots", { preHandler: app.requireAuth }, async (_request, reply) => {
    const rows = db.prepare("SELECT * FROM scan_roots ORDER BY sort_order, id").all() as ScanRootRow[];
    return reply.send(rows.map((row) => toDto(db, row)));
  });

  app.post("/api/scan-roots/pick-folder", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!LOOPBACK_ADDRESSES.has(request.ip)) {
      return reply.code(403).send({ error: "Folder selection is available only on this computer" });
    }
    try {
      return reply.send({ path: await pickLocalFolder() });
    } catch (error) {
      request.log.warn({ err: error }, "Native folder picker is unavailable");
      return reply.code(501).send({ error: "The native folder picker is unavailable on this system" });
    }
  });

  app.post("/api/scan-roots", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = createScanRootRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }

    const resolvedPath = path.resolve(parsed.data.path);
    if (parsed.data.kind === "apple-photos") {
      if (!isApplePhotosEnabled(db)) return reply.code(409).send({ error: "Enable Apple Photos before adding a library" });
      if (!resolvedPath.toLowerCase().endsWith(".photoslibrary")) {
        return reply.code(400).send({ error: "Select a .photoslibrary package" });
      }
    } else if (resolvedPath.toLowerCase().endsWith(".photoslibrary")) {
      return reply.code(400).send({ error: "Add this package through the Apple Photos plugin" });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolvedPath);
    } catch {
      return reply.code(400).send({ error: "Path does not exist or is not accessible" });
    }
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: "Path is not a directory" });
    }

    try {
      const nextSortOrder = (
        db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM scan_roots").get() as { next: number }
      ).next;
      const info = db
        .prepare("INSERT INTO scan_roots (path, enabled, sort_order, kind) VALUES (?, 1, ?, ?)")
        .run(resolvedPath, nextSortOrder, parsed.data.kind);
      const row = db.prepare("SELECT * FROM scan_roots WHERE id = ?").get(info.lastInsertRowid) as ScanRootRow;
      return reply.code(201).send(toDto(db, row));
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return reply.code(409).send({ error: "This path is already a scan root" });
      }
      throw err;
    }
  });

  app.put("/api/scan-roots/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = updateScanRootRequestSchema.safeParse(request.body);
    if (!parsed.success || Number.isNaN(id)) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const existing = db.prepare("SELECT * FROM scan_roots WHERE id = ?").get(id) as ScanRootRow | undefined;
    if (!existing) return reply.code(404).send({ error: "Scan root not found" });

    if (parsed.data.enabled !== undefined) {
      db.prepare("UPDATE scan_roots SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .run(parsed.data.enabled ? 1 : 0, id);
    }
    const updated = db.prepare("SELECT * FROM scan_roots WHERE id = ?").get(id) as ScanRootRow;
    return reply.send(toDto(db, updated));
  });

  app.post("/api/scan-roots/:id/move", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = moveScanRootRequestSchema.safeParse(request.body);
    if (!parsed.success || Number.isNaN(id)) {
      return reply.code(400).send({ error: "Invalid input" });
    }

    const ordered = db.prepare("SELECT * FROM scan_roots ORDER BY sort_order, id").all() as ScanRootRow[];
    const index = ordered.findIndex((r) => r.id === id);
    if (index === -1) return reply.code(404).send({ error: "Scan root not found" });

    const swapWithIndex = parsed.data.direction === "up" ? index - 1 : index + 1;
    if (swapWithIndex < 0 || swapWithIndex >= ordered.length) {
      // Already at the top/bottom - not an error, just a no-op.
      return reply.send(ordered.map((row) => toDto(db, row)));
    }

    const current = ordered[index];
    const swapWith = ordered[swapWithIndex];
    const swap = db.transaction(() => {
      db.prepare("UPDATE scan_roots SET sort_order = ? WHERE id = ?").run(swapWith.sort_order, current.id);
      db.prepare("UPDATE scan_roots SET sort_order = ? WHERE id = ?").run(current.sort_order, swapWith.id);
    });
    swap();

    const updated = db.prepare("SELECT * FROM scan_roots ORDER BY sort_order, id").all() as ScanRootRow[];
    return reply.send(updated.map((row) => toDto(db, row)));
  });

  app.delete("/api/scan-roots/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (Number.isNaN(id)) return reply.code(400).send({ error: "Invalid id" });
    // ON DELETE CASCADE removes associated folders/media rows; thumbnail files
    // for those media become orphaned and can be swept by a future cleanup job -
    // the cache is disposable by design, so this is a cosmetic disk-space concern only.
    db.prepare("DELETE FROM scan_roots WHERE id = ?").run(id);
    return reply.code(204).send();
  });
}
