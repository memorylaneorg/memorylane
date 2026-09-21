import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { StackDto, StackKind, StackRefDto } from "@memorylane/shared";
import type { SettingsRepo } from "../db/settings-repo.js";
import { EXCLUDE_LIVE_PHOTO_VIDEOS, EXCLUDE_PAIRED_RAW, UNMARKED_MEDIA_SQL } from "../query/media-query.js";
import type { MediaRow } from "../api/mappers.js";
import { groupBursts, STACK_RULE_VERSION, type StackCandidate } from "./stacker.js";
import { markFoldersDirty } from "./dirty.js";
import { blobToVector } from "../vectors/embedding-repo.js";

export class StackError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface StackRow {
  id: number;
  kind: string;
  cover_media_id: number;
  parent_folder_id: number;
  rule_version: string | null;
  user_modified: number;
  created_at: string;
  updated_at: string;
  count: number;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// Owns every read/write of stacks, stack_members, stack_exclusions and
// stack_dirty_folders (design doc §8). The auto-stacker only ever touches
// stacks with user_modified = 0; every user operation flips that flag so the
// user's arrangement survives future recomputes.
export class StackService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
    private settings: SettingsRepo,
    // Embedding model whose vectors feed stacks v2; null = pHash/time only.
    private getModel: () => string | null = () => null,
  ) {}

  // ---- recompute -----------------------------------------------------------

  private listCandidates(folderId: number): StackCandidate[] {
    const model = this.getModel() ?? "";
    const rows = this.db
      .prepare(
        `SELECT media.id, media.filename, mx.captured_at_precise AS capturedAt,
                COALESCE(mx.camera_serial, mx.camera_model) AS body, ph.phash, mx.burst_id AS burstId,
                mx.shutter_speed_s AS shutterSeconds, em.vector AS embeddingBlob
         FROM media
         LEFT JOIN media_exif mx ON mx.media_id = media.id
         LEFT JOIN media_phash ph ON ph.media_id = media.id
         LEFT JOIN media_embeddings em ON em.media_id = media.id AND em.model = ?
         WHERE media.parent_folder_id = ? AND media.status = 'active' AND media.media_type IN ('image', 'raw')
           AND ${EXCLUDE_LIVE_PHOTO_VIDEOS} AND ${EXCLUDE_PAIRED_RAW}
           AND ${UNMARKED_MEDIA_SQL}
           AND media.id NOT IN (SELECT media_id FROM stack_exclusions)
           AND media.id NOT IN (SELECT sm.media_id FROM stack_members sm JOIN stacks s ON s.id = sm.stack_id WHERE s.user_modified = 1)`,
      )
      .all(model, folderId) as (StackCandidate & { embeddingBlob: Buffer | null })[];
    return rows.map(({ embeddingBlob, ...r }) => ({ ...r, embedding: embeddingBlob ? blobToVector(embeddingBlob) : null }));
  }

  // Replaces every auto stack in the folder with a fresh grouping. Returns
  // the number of stacks created. Idempotent.
  recomputeFolder(folderId: number): number {
    const { stackGapSeconds, stackMaxHamming, stackMinCosine, stackSeriesGapSeconds } = this.settings.getAll();
    const groups = groupBursts(this.listCandidates(folderId), {
      gapSeconds: stackGapSeconds,
      maxHamming: stackMaxHamming,
      minCosine: stackMinCosine,
      seriesGapSeconds: stackSeriesGapSeconds,
    });
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM stacks WHERE parent_folder_id = ? AND user_modified = 0").run(folderId);
      for (const ids of groups) this.insertStack("burst", folderId, ids, STACK_RULE_VERSION, false);
    });
    tx();
    return groups.length;
  }

  // Drains up to `limit` dirty folders. A folder is un-marked before its
  // recompute so anything that dirties it mid-way re-queues it.
  recomputeDirty(limit = 5): number {
    const rows = this.db.prepare("SELECT folder_id FROM stack_dirty_folders LIMIT ?").all(limit) as { folder_id: number }[];
    for (const { folder_id } of rows) {
      this.db.prepare("DELETE FROM stack_dirty_folders WHERE folder_id = ?").run(folder_id);
      try {
        const n = this.recomputeFolder(folder_id);
        this.logger.info({ folderId: folder_id, stacks: n }, "Recomputed stacks");
      } catch (err) {
        this.logger.error({ err, folderId: folder_id }, "Stack recompute failed");
      }
    }
    return rows.length;
  }

  markAllDirty(): number {
    return this.db
      .prepare("INSERT OR IGNORE INTO stack_dirty_folders (folder_id) SELECT id FROM folders WHERE status = 'active'")
      .run().changes;
  }

  markFolderDirty(folderId: number): void {
    markFoldersDirty(this.db, [folderId]);
  }

  // True when auto stacks were computed by an older rule - the caller marks
  // everything dirty once so they get regrouped under the current rule.
  hasStaleAutoStacks(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM stacks WHERE user_modified = 0 AND (rule_version IS NULL OR rule_version != ?) LIMIT 1")
      .get(STACK_RULE_VERSION);
  }

  // ---- reads ---------------------------------------------------------------

  private toDto(row: StackRow): StackDto {
    return {
      id: row.id,
      kind: row.kind as StackKind,
      coverMediaId: row.cover_media_id,
      parentFolderId: row.parent_folder_id,
      userModified: row.user_modified === 1,
      count: row.count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getStack(id: number): StackDto | null {
    const row = this.db
      .prepare("SELECT s.*, (SELECT COUNT(*) FROM stack_members m WHERE m.stack_id = s.id AND m.media_id NOT IN (SELECT media_id FROM deletion_marks)) AS count FROM stacks s WHERE s.id = ?")
      .get(id) as StackRow | undefined;
    return row && row.count > 0 ? this.toDto(row) : null;
  }

  private requireStack(id: number): StackDto {
    const s = this.getStack(id);
    if (!s) throw new StackError(404, "Stack not found");
    return s;
  }

  getMembers(stackId: number): MediaRow[] {
    return this.db
      .prepare("SELECT media.* FROM stack_members sm JOIN media ON media.id = sm.media_id WHERE sm.stack_id = ? AND media.id NOT IN (SELECT media_id FROM deletion_marks) ORDER BY sm.position, media.id")
      .all(stackId) as MediaRow[];
  }

  // Mutates and returns `items` with `.stack` set - call on every list of
  // MediaDto before sending it (see api/decorate-media.ts).
  attachStacks<T extends { id: number; stack: StackRefDto | null }>(items: T[]): T[] {
    if (items.length === 0) return items;
    const placeholders = items.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT sm.media_id, s.id, s.cover_media_id, (SELECT COUNT(*) FROM stack_members m2 WHERE m2.stack_id = s.id AND m2.media_id NOT IN (SELECT media_id FROM deletion_marks)) AS count
         FROM stack_members sm JOIN stacks s ON s.id = sm.stack_id WHERE sm.media_id IN (${placeholders})`,
      )
      .all(...items.map((i) => i.id)) as { media_id: number; id: number; cover_media_id: number; count: number }[];
    const byMedia = new Map(rows.map((r) => [r.media_id, r]));
    for (const item of items) {
      const r = byMedia.get(item.id);
      item.stack = r ? { id: r.id, count: r.count, isCover: r.cover_media_id === item.id } : null;
    }
    return items;
  }

  // ---- user operations -----------------------------------------------------

  private insertStack(kind: StackKind, folderId: number, ids: number[], ruleVersion: string | null, userModified: boolean): number {
    const info = this.db
      .prepare("INSERT INTO stacks (kind, cover_media_id, parent_folder_id, rule_version, user_modified) VALUES (?, ?, ?, ?, ?)")
      .run(kind, ids[0], folderId, ruleVersion, userModified ? 1 : 0);
    const stackId = Number(info.lastInsertRowid);
    const member = this.db.prepare("INSERT INTO stack_members (stack_id, media_id, position) VALUES (?, ?, ?)");
    ids.forEach((id, i) => member.run(stackId, id, i));
    return stackId;
  }

  private touch(stackId: number): void {
    this.db.prepare(`UPDATE stacks SET user_modified = 1, updated_at = ${NOW} WHERE id = ?`).run(stackId);
  }

  private memberIds(stackId: number): number[] {
    return (this.db.prepare("SELECT media_id FROM stack_members WHERE stack_id = ? ORDER BY position, media_id").all(stackId) as { media_id: number }[]).map(
      (r) => r.media_id,
    );
  }

  // Deletes the stack if fewer than two members remain, otherwise makes sure
  // the cover still points at a member. Returns the surviving stack, or null.
  private settle(stackId: number): StackDto | null {
    const ids = this.memberIds(stackId);
    if (ids.length < 2) {
      this.db.prepare("DELETE FROM stacks WHERE id = ?").run(stackId);
      return null;
    }
    const s = this.requireStack(stackId);
    if (!ids.includes(s.coverMediaId)) {
      this.db.prepare("UPDATE stacks SET cover_media_id = ? WHERE id = ?").run(ids[0], stackId);
    }
    this.touch(stackId);
    return this.requireStack(stackId);
  }

  createManual(mediaIds: number[]): StackDto {
    const ids = [...new Set(mediaIds)];
    if (ids.length < 2) throw new StackError(400, "A stack needs at least two photos");
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, parent_folder_id, media_type FROM media WHERE id IN (${placeholders}) AND status = 'active' AND media_type IN ('image', 'raw')`,
      )
      .all(...ids) as { id: number; parent_folder_id: number }[];
    if (rows.length !== ids.length) throw new StackError(400, "Every photo must exist and be an active still image");
    const folders = new Set(rows.map((r) => r.parent_folder_id));
    if (folders.size !== 1) throw new StackError(400, "Stacked photos must be in the same folder");
    const stacked = this.db.prepare(`SELECT media_id FROM stack_members WHERE media_id IN (${placeholders})`).all(...ids) as { media_id: number }[];
    if (stacked.length > 0) throw new StackError(400, "One or more photos are already in a stack");

    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM stack_exclusions WHERE media_id IN (${placeholders})`).run(...ids);
      return this.insertStack("manual", [...folders][0], ids, null, true);
    });
    return this.requireStack(tx());
  }

  setCover(stackId: number, mediaId: number): StackDto {
    this.requireStack(stackId);
    if (!this.memberIds(stackId).includes(mediaId)) throw new StackError(400, "Photo is not in this stack");
    this.db.prepare("UPDATE stacks SET cover_media_id = ? WHERE id = ?").run(mediaId, stackId);
    this.touch(stackId);
    return this.requireStack(stackId);
  }

  // Moves the given members out into a new (user-modified) stack.
  split(stackId: number, mediaIds: number[]): StackDto {
    const s = this.requireStack(stackId);
    const members = this.memberIds(stackId);
    const moving = [...new Set(mediaIds)].filter((id) => members.includes(id));
    if (moving.length < 2) throw new StackError(400, "Select at least two photos from this stack to split off");
    if (moving.length === members.length) throw new StackError(400, "Cannot split off every photo - delete the stack instead");
    const tx = this.db.transaction(() => {
      const placeholders = moving.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM stack_members WHERE stack_id = ? AND media_id IN (${placeholders})`).run(stackId, ...moving);
      const newId = this.insertStack("manual", s.parentFolderId, moving, null, true);
      this.settle(stackId);
      return newId;
    });
    return this.requireStack(tx());
  }

  merge(intoId: number, fromId: number): StackDto {
    const into = this.requireStack(intoId);
    const from = this.requireStack(fromId);
    if (intoId === fromId) throw new StackError(400, "Cannot merge a stack into itself");
    if (into.parentFolderId !== from.parentFolderId) throw new StackError(400, "Stacks must be in the same folder");
    const tx = this.db.transaction(() => {
      const max = (this.db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM stack_members WHERE stack_id = ?").get(intoId) as { m: number }).m;
      const moving = this.memberIds(fromId);
      this.db.prepare("DELETE FROM stacks WHERE id = ?").run(fromId); // cascades its members
      const ins = this.db.prepare("INSERT INTO stack_members (stack_id, media_id, position) VALUES (?, ?, ?)");
      moving.forEach((id, i) => ins.run(intoId, id, max + 1 + i));
      this.touch(intoId);
    });
    tx();
    return this.requireStack(intoId);
  }

  // Removes one photo and excludes it from future auto-stacking. Returns the
  // surviving stack, or null if it dissolved.
  removeMember(stackId: number, mediaId: number): StackDto | null {
    this.requireStack(stackId);
    if (!this.memberIds(stackId).includes(mediaId)) throw new StackError(400, "Photo is not in this stack");
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM stack_members WHERE stack_id = ? AND media_id = ?").run(stackId, mediaId);
      this.db.prepare("INSERT OR IGNORE INTO stack_exclusions (media_id) VALUES (?)").run(mediaId);
      return this.settle(stackId);
    });
    return tx();
  }

  // Unstacks everything and excludes every member so a recompute doesn't
  // simply recreate the stack the user just removed.
  deleteStack(stackId: number): void {
    this.requireStack(stackId);
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO stack_exclusions (media_id) SELECT media_id FROM stack_members WHERE stack_id = ?").run(stackId);
      this.db.prepare("DELETE FROM stacks WHERE id = ?").run(stackId);
    });
    tx();
  }
}
