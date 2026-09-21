import type Database from "better-sqlite3";
import type { FaceDetection } from "../providers/types.js";
import { blobToVector, vectorToBlob, VECTOR_READ_PAGE_SIZE, type EmbeddingRow } from "../vectors/embedding-repo.js";
import { ACTIVE_SOURCE_SQL, UNMARKED_MEDIA_SQL } from "../query/media-query.js";

export interface FaceRow {
  id: number;
  media_id: number;
  model: string;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  landmarks_json: string | null;
  det_score: number;
  quality: number;
  embedding: Buffer;
  person_id: number | null;
  assigned_by: string | null;
  assign_score: number | null;
  discovered_at: string | null;
  dismissed: number;
  created_at: string;
}

// Faces smaller than this fraction of the image's long edge (or blurry,
// low-confidence detections) never seed a person - a crowd of tiny heads
// must not spawn forty "Person N"s. They can still be *assigned* to one.
export const QUALITY_FACE_MIN = 0.5;

export function faceQuality(detScore: number, bboxW: number, bboxH: number): number {
  return detScore * Math.min(1, Math.max(bboxW, bboxH) / 0.05);
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export class FaceRepo {
  constructor(private db: Database.Database) {}

  *iterateVectors(model: string): Generator<EmbeddingRow> {
    const stmt = this.db.prepare(
      "SELECT id, embedding FROM faces WHERE model = ? AND id > ? ORDER BY id LIMIT ?",
    );
    let lastId = 0;
    while (true) {
      const page = stmt.all(model, lastId, VECTOR_READ_PAGE_SIZE) as { id: number; embedding: Buffer }[];
      if (page.length === 0) return;
      for (const row of page) {
        lastId = row.id;
        yield { id: row.id, vector: blobToVector(row.embedding) };
      }
    }
  }

  // Replaces a media item's faces for `model`, carrying *every* assignment
  // (user and automatic) plus rejections over to the best-overlapping new
  // face (IoU >= 0.5): same photo, same box means the same person, so a
  // re-run - e.g. after a face-model switch - keeps people populated and
  // named instead of rediscovering everyone as new "Person N"s. Person
  // covers follow their replaced face too.
  replaceForMedia(mediaId: number, model: string, dets: FaceDetection[]): { ids: number[]; removed: number[] } {
    const tx = this.db.transaction(() => {
      const old = this.db.prepare("SELECT * FROM faces WHERE media_id = ?").all(mediaId) as FaceRow[];
      const oldAssigned = old.filter((f) => f.person_id !== null);
      const oldRejections = old.length
        ? (this.db
            .prepare(`SELECT face_id, person_id FROM face_person_rejections WHERE face_id IN (${old.map(() => "?").join(",")})`)
            .all(...old.map((f) => f.id)) as { face_id: number; person_id: number }[])
        : [];
      this.db.prepare("DELETE FROM faces WHERE media_id = ?").run(mediaId);

      const insert = this.db.prepare(
        `INSERT INTO faces (media_id, model, bbox_x, bbox_y, bbox_w, bbox_h, landmarks_json, det_score, quality, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ids: number[] = [];
      for (const d of dets) {
        const [x, y, w, h] = d.bbox;
        const info = insert.run(mediaId, model, x, y, w, h, JSON.stringify(d.landmarks), d.detScore, faceQuality(d.detScore, w, h), vectorToBlob(d.embedding));
        ids.push(Number(info.lastInsertRowid));
      }

      const iou = (a: FaceRow, b: FaceDetection) => {
        const [bx, by, bw, bh] = b.bbox;
        const ix1 = Math.max(a.bbox_x, bx), iy1 = Math.max(a.bbox_y, by);
        const ix2 = Math.min(a.bbox_x + a.bbox_w, bx + bw), iy2 = Math.min(a.bbox_y + a.bbox_h, by + bh);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
        const union = a.bbox_w * a.bbox_h + bw * bh - inter;
        return union > 0 ? inter / union : 0;
      };
      const carry = (oldFace: FaceRow): number | null => {
        let best = -1, bestIou = 0.5;
        dets.forEach((d, i) => {
          const v = iou(oldFace, d);
          if (v >= bestIou) { best = i; bestIou = v; }
        });
        return best >= 0 ? ids[best] : null;
      };
      const coverUpdate = this.db.prepare("UPDATE persons SET cover_face_id = ? WHERE cover_face_id = ?");
      for (const f of oldAssigned) {
        const target = carry(f);
        if (target !== null) {
          this.db
            .prepare("UPDATE faces SET person_id = ?, assigned_by = ?, assign_score = ? WHERE id = ?")
            .run(f.person_id, f.assigned_by ?? "auto", f.assign_score, target);
          coverUpdate.run(target, f.id);
        }
      }
      const oldDismissed = old.filter((f) => f.dismissed === 1);
      const dismiss = this.db.prepare("UPDATE faces SET dismissed = 1, discovered_at = ? WHERE id = ?");
      for (const f of oldDismissed) {
        const target = carry(f);
        if (target !== null) dismiss.run(f.discovered_at ?? new Date().toISOString(), target);
      }
      // Covers pointing at faces that vanished without a replacement get re-picked by PersonService.fixCover later.
      if (old.length) this.db.prepare(`UPDATE persons SET cover_face_id = NULL WHERE cover_face_id IN (${old.map(() => "?").join(",")})`).run(...old.map((f) => f.id));
      const byOldId = new Map(old.map((f) => [f.id, f]));
      const rej = this.db.prepare("INSERT OR IGNORE INTO face_person_rejections (face_id, person_id) VALUES (?, ?)");
      for (const r of oldRejections) {
        const target = carry(byOldId.get(r.face_id)!);
        if (target !== null) rej.run(target, r.person_id);
      }
      return { ids, removed: old.map((f) => f.id) };
    });
    return tx();
  }

  get(faceId: number): FaceRow | null {
    return (this.db.prepare("SELECT * FROM faces WHERE id = ?").get(faceId) as FaceRow | undefined) ?? null;
  }

  vector(row: FaceRow): Float32Array {
    return blobToVector(row.embedding);
  }

  listForMedia(mediaId: number): FaceRow[] {
    return this.db.prepare("SELECT * FROM faces WHERE media_id = ? ORDER BY bbox_x").all(mediaId) as FaceRow[];
  }

  listForPerson(personId: number, limit: number, offset: number): FaceRow[] {
    return this.db
      .prepare(`SELECT faces.* FROM faces JOIN media ON media.id = faces.media_id
        WHERE faces.person_id = ? AND media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}
        ORDER BY faces.quality DESC, faces.id LIMIT ? OFFSET ?`)
      .all(personId, limit, offset) as FaceRow[];
  }

  listByIds(ids: number[]): FaceRow[] {
    if (ids.length === 0) return [];
    return this.db.prepare(`SELECT * FROM faces WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as FaceRow[];
  }

  unassignedQuality(model: string): FaceRow[] {
    return this.db
      .prepare(`SELECT faces.* FROM faces JOIN media ON media.id = faces.media_id
        WHERE faces.model = ? AND faces.person_id IS NULL AND faces.dismissed = 0 AND faces.quality >= ?
        AND media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} ORDER BY faces.id`)
      .all(model, QUALITY_FACE_MIN) as FaceRow[];
  }

  hasUndiscovered(model: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM faces JOIN media ON media.id = faces.media_id
        WHERE faces.model = ? AND faces.person_id IS NULL AND faces.dismissed = 0 AND faces.quality >= ?
        AND faces.discovered_at IS NULL AND media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} LIMIT 1`)
      .get(model, QUALITY_FACE_MIN);
  }

  // face id -> person id for every assigned face (drives kNN assignment).
  assignedMap(model: string): Map<number, number> {
    const rows = this.db.prepare(`SELECT faces.id, faces.person_id FROM faces JOIN media ON media.id = faces.media_id
      WHERE faces.model = ? AND faces.person_id IS NOT NULL AND media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`)
      .all(model) as { id: number; person_id: number }[];
    return new Map(rows.map((r) => [r.id, r.person_id]));
  }

  rejectionsFor(faceId: number): Set<number> {
    const rows = this.db.prepare("SELECT person_id FROM face_person_rejections WHERE face_id = ?").all(faceId) as { person_id: number }[];
    return new Set(rows.map((r) => r.person_id));
  }

  setAssignment(faceId: number, personId: number | null, by: "auto" | "user" | "apple" | null, score: number | null): void {
    this.db.prepare("UPDATE faces SET person_id = ?, assigned_by = ?, assign_score = ? WHERE id = ?").run(personId, personId === null ? null : by, score, faceId);
  }

  restoreDismissed(faceId: number): void {
    this.db.prepare("UPDATE faces SET dismissed = 0 WHERE id = ?").run(faceId);
  }

  addRejection(faceId: number, personId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO face_person_rejections (face_id, person_id) VALUES (?, ?)").run(faceId, personId);
  }

  markDiscovered(faceIds: number[]): void {
    if (faceIds.length === 0) return;
    const stmt = this.db.prepare(`UPDATE faces SET discovered_at = ${NOW} WHERE id = ?`);
    const tx = this.db.transaction((ids: number[]) => ids.forEach((id) => stmt.run(id)));
    tx(faceIds);
  }

  // A person's face vectors for one model (vectors from different models
  // never mix - during a model switch a person briefly has both).
  personVectors(personId: number, model: string): Float32Array[] {
    return (this.db.prepare(`SELECT faces.embedding FROM faces JOIN media ON media.id = faces.media_id
      WHERE faces.person_id = ? AND faces.model = ? AND media.status = 'active' AND ${ACTIVE_SOURCE_SQL}`)
      .all(personId, model) as { embedding: Buffer }[]).map((r) =>
      blobToVector(r.embedding),
    );
  }

  deleteAll(): void {
    this.db.exec("DELETE FROM face_person_rejections; DELETE FROM faces; DELETE FROM persons;");
  }
}
