import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { FaceDto, PersonDto } from "@memorylane/shared";
import type { SettingsRepo } from "../db/settings-repo.js";
import { FACE_MODEL_IDS, type AiProvider } from "../providers/types.js";
import { spaceFor, type VectorIndex } from "../vectors/vector-index.js";
import { FaceRepo, type FaceRow } from "./face-repo.js";
import { ACTIVE_SOURCE_SQL, UNMARKED_MEDIA_SQL } from "../query/media-query.js";
import { isMediaSourceVisible } from "../plugins/registry.js";

export class PersonError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface PersonRow {
  id: number;
  name: string | null;
  auto_label: string;
  cover_face_id: number | null;
  hidden: number;
  merged_into: number | null;
  face_count: number;
  media_count: number;
  apple_face_count: number;
}

const KNN = 20;
// A single look-alike frame must not pull a face into a person: besides the
// nearest assigned face, the person's average face has to be at least this
// close too (a little below the assign threshold to allow pose variety).
const CENTROID_MARGIN = 0.08;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function centroid(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return normalize(out);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const PERSON_SELECT = `
  WITH person_face_stats AS (
    SELECT f.person_id,
      SUM(CASE WHEN media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} THEN 1 ELSE 0 END) AS face_count,
      COUNT(DISTINCT CASE WHEN media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} THEN f.media_id END) AS media_count,
      SUM(CASE WHEN media.source_kind = 'apple-photos' AND ${UNMARKED_MEDIA_SQL} THEN 1 ELSE 0 END) AS apple_face_count
    FROM faces f
    JOIN media ON media.id = f.media_id
    WHERE f.person_id IS NOT NULL
    GROUP BY f.person_id
  )
  SELECT p.*,
    COALESCE(s.face_count, 0) AS face_count,
    COALESCE(s.media_count, 0) AS media_count,
    COALESCE(s.apple_face_count, 0) AS apple_face_count
  FROM persons p
  LEFT JOIN person_face_stats s ON s.person_id = p.id`;

// Identity management (design doc §10.2/10.3). Two automatic paths -
// incremental kNN assignment for each new face, and periodic discovery over
// unassigned faces - plus user corrections that both paths must respect:
// assigned_by='user' rows are never touched, rejections are never crossed.
export class PersonService {
  private faces: FaceRepo;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private settings: SettingsRepo,
    private provider: () => AiProvider | null,
    private index: VectorIndex,
    private facesDir: string,
  ) {
    this.faces = new FaceRepo(db);
  }

  private model(): string | null {
    if (!this.provider()) return null;
    const name = this.settings.getAll().faceModel;
    return FACE_MODEL_IDS[name] ?? name;
  }

  private enabled(): boolean {
    const s = this.settings.getAll();
    return s.personsEnabled && s.aiEnabled && this.model() !== null;
  }

  // ---- automatic ------------------------------------------------------------

  async assignNewFaces(faceIds: number[]): Promise<number> {
    const model = this.model();
    if (!model || faceIds.length === 0 || !this.enabled()) return 0;
    const assigned = this.faces.assignedMap(model);
    if (assigned.size === 0) return 0;
    const threshold = this.settings.getAll().faceAssignThreshold;
    const space = spaceFor("faces", model);
    const centroids = new Map<number, Float32Array | null>();
    const centroidOf = (personId: number) => {
      if (!centroids.has(personId)) {
        const vs = this.faces.personVectors(personId, model);
        centroids.set(personId, vs.length ? centroid(vs) : null);
      }
      return centroids.get(personId) ?? null;
    };
    let count = 0;
    for (const row of this.faces.listByIds(faceIds)) {
      if (row.person_id !== null || row.dismissed === 1) continue;
      const rejected = this.faces.rejectionsFor(row.id);
      const vector = this.faces.vector(row);
      const hits = await this.index.search(space, vector, KNN, { excludeIds: [row.id] });
      const best = hits.find((h) => assigned.has(h.id) && !rejected.has(assigned.get(h.id) as number));
      if (!best || best.score < threshold) continue;
      const personId = assigned.get(best.id) as number;
      const c = centroidOf(personId);
      if (c && cosine(vector, c) < threshold - CENTROID_MARGIN) continue;
      this.faces.setAssignment(row.id, personId, "auto", best.score);
      count++;
    }
    return count;
  }

  needsDiscovery(): boolean {
    const model = this.model();
    return !!model && this.enabled() && this.faces.hasUndiscovered(model);
  }

  // Clusters every unassigned quality face; each cluster either joins an
  // existing person (centroid match) or becomes a new "Person N".
  async discover(): Promise<{ persons: number; assigned: number }> {
    const model = this.model();
    const provider = this.provider();
    if (!model || !provider || !this.enabled()) return { persons: 0, assigned: 0 };
    const { faceMinClusterSize, faceAssignThreshold, faceLinkThreshold } = this.settings.getAll();
    const rows = this.faces.unassignedQuality(model);
    if (rows.length === 0) return { persons: 0, assigned: 0 };
    const vectors = rows.map((r) => this.faces.vector(r));
    const labels = await provider.cluster(vectors, { threshold: faceLinkThreshold, minClusterSize: faceMinClusterSize });

    const existing = (this.db.prepare("SELECT id FROM persons WHERE merged_into IS NULL").all() as { id: number }[]).map((p) => ({
      id: p.id,
      centroid: (() => {
        const vs = this.faces.personVectors(p.id, model);
        return vs.length ? centroid(vs) : null;
      })(),
    }));

    const clusters = new Map<number, number[]>();
    labels.forEach((l, i) => {
      if (l >= 0) clusters.set(l, [...(clusters.get(l) ?? []), i]);
    });

    let persons = 0, assigned = 0;
    const tx = this.db.transaction(() => {
      for (const members of clusters.values()) {
        const c = centroid(members.map((i) => vectors[i]));
        let personId: number | null = null;
        let bestScore = faceAssignThreshold;
        for (const e of existing) {
          if (!e.centroid) continue;
          const s = cosine(c, e.centroid);
          if (s >= bestScore) { bestScore = s; personId = e.id; }
        }
        if (personId === null) {
          personId = this.createPerson(rows[members[0]].id);
          persons++;
          existing.push({ id: personId, centroid: c });
        }
        // Cover = highest-quality member when the person is new.
        const cover = members.map((i) => rows[i]).sort((a, b) => b.quality - a.quality)[0];
        for (const i of members) {
          const row = rows[i];
          if (this.faces.rejectionsFor(row.id).has(personId)) continue;
          this.faces.setAssignment(row.id, personId, "auto", cosine(vectors[i], c));
          assigned++;
        }
        const p = this.db.prepare("SELECT cover_face_id FROM persons WHERE id = ?").get(personId) as { cover_face_id: number | null };
        if (p.cover_face_id === null) this.db.prepare("UPDATE persons SET cover_face_id = ? WHERE id = ?").run(cover.id, personId);
      }
      this.faces.markDiscovered(rows.map((r) => r.id));
      this.db.prepare("DELETE FROM persons WHERE merged_into IS NULL AND name IS NULL AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = persons.id)").run();
    });
    tx();
    for (const p of this.listPersons(true)) this.fixCover(p.id);
    if (persons || assigned) this.logger.info({ persons, assigned, considered: rows.length }, "Person discovery finished");
    return { persons, assigned };
  }

  // Throws away every *automatic* grouping decision and regroups with the
  // current thresholds. Names, user-confirmed faces and rejections survive;
  // persons left with no user-confirmed face are removed (their label was
  // never chosen by the user). Used to tune strictness without re-detecting.
  async regroup(): Promise<{ persons: number; assigned: number }> {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE faces SET person_id = NULL, assigned_by = NULL, assign_score = NULL, discovered_at = NULL WHERE assigned_by = 'auto'").run();
      this.db.prepare("UPDATE faces SET discovered_at = NULL WHERE person_id IS NULL AND dismissed = 0").run();
      this.db
        .prepare(
          `DELETE FROM persons WHERE merged_into IS NULL
             AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = persons.id)
             AND name IS NULL`,
        )
        .run();
      this.db.prepare("UPDATE persons SET cover_face_id = NULL WHERE cover_face_id IS NOT NULL AND cover_face_id NOT IN (SELECT id FROM faces WHERE person_id = persons.id)").run();
    });
    tx();
    const model = this.model();
    let reattached = 0;
    if (model) {
      // Faces the user confirmed stay; re-attach the rest to them first, then discover the remainder.
      const unassigned = this.faces.unassignedQuality(model).map((f) => f.id);
      reattached = await this.assignNewFaces(unassigned);
    }
    const d = await this.discover();
    for (const p of this.listPersons(true)) this.fixCover(p.id);
    const r = { persons: d.persons, assigned: d.assigned + reattached };
    this.logger.info(r, "Regrouped persons");
    return r;
  }

  // Called from the worker's idle hook; cheap when there's nothing to do.
  async discoverIfNeeded(): Promise<number> {
    if (!this.needsDiscovery()) return 0;
    const r = await this.discover();
    return r.persons + r.assigned + 1;
  }

  // Keeps cover_face_id pointing at one of the person's own faces (highest
  // quality) after a face is unassigned/rejected/moved.
  private fixCover(personId: number): void {
    const p = this.db.prepare("SELECT cover_face_id FROM persons WHERE id = ?").get(personId) as { cover_face_id: number | null } | undefined;
    if (!p) return;
    const owner = p.cover_face_id === null ? null : (this.db.prepare("SELECT person_id FROM faces WHERE id = ?").get(p.cover_face_id) as { person_id: number | null } | undefined);
    if (owner && owner.person_id === personId) return;
    const best = this.db.prepare("SELECT id FROM faces WHERE person_id = ? ORDER BY quality DESC, id LIMIT 1").get(personId) as { id: number } | undefined;
    this.db.prepare("UPDATE persons SET cover_face_id = ? WHERE id = ?").run(best?.id ?? null, personId);
  }

  private createPerson(coverFaceId: number | null): number {
    const next = ((this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM persons").get() as { m: number }).m ?? 0) + 1;
    const info = this.db.prepare("INSERT INTO persons (auto_label, cover_face_id) VALUES (?, ?)").run(`Person ${next}`, coverFaceId);
    return Number(info.lastInsertRowid);
  }

  // ---- reads ------------------------------------------------------------------

  private toPerson(row: PersonRow): PersonDto {
    return {
      id: row.id,
      name: row.name,
      autoLabel: row.auto_label,
      displayName: row.name ?? row.auto_label,
      coverFaceId: row.cover_face_id && this.getFace(row.cover_face_id) ? row.cover_face_id : (this.faces.listForPerson(row.id, 1, 0)[0]?.id ?? null),
      faceCount: row.face_count,
      mediaCount: row.media_count,
      hidden: row.hidden === 1,
    };
  }

  toFace(row: FaceRow): FaceDto {
    return {
      id: row.id,
      mediaId: row.media_id,
      bbox: [row.bbox_x, row.bbox_y, row.bbox_w, row.bbox_h],
      detScore: row.det_score,
      quality: row.quality,
      personId: row.person_id,
      assignedBy: row.assigned_by as FaceDto["assignedBy"],
    };
  }

  listPersons(includeHidden: boolean): PersonDto[] {
    const rows = this.db
      .prepare(`${PERSON_SELECT} WHERE p.merged_into IS NULL ${includeHidden ? "" : "AND p.hidden = 0"} ORDER BY media_count DESC, face_count DESC, p.id`)
      .all() as PersonRow[];
    // An unnamed person with no faces left (all rejected, or lost in a
    // re-detection) is noise; named ones stay visible so the name isn't lost.
    return rows.filter((r) => r.face_count > 0 || (r.name !== null && r.apple_face_count === 0)).map((r) => this.toPerson(r));
  }

  getPerson(id: number): PersonDto | null {
    const row = this.db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(id) as PersonRow | undefined;
    if (!row) return null;
    if (row.merged_into !== null) return this.getPerson(row.merged_into);
    if (row.face_count === 0 && row.apple_face_count > 0) return null;
    return this.toPerson(row);
  }

  private requirePerson(id: number): PersonDto {
    const p = this.getPerson(id);
    if (!p) throw new PersonError(404, "Person not found");
    return p;
  }

  listFaces(personId: number, limit: number, offset: number): FaceDto[] {
    return this.faces.listForPerson(personId, limit, offset).map((r) => this.toFace(r));
  }

  facesForMedia(mediaId: number): FaceDto[] {
    if (!isMediaSourceVisible(this.db, mediaId)) return [];
    return this.faces.listForMedia(mediaId).map((r) => this.toFace(r));
  }

  getFace(faceId: number): FaceRow | null {
    const face = this.faces.get(faceId);
    return face && isMediaSourceVisible(this.db, face.media_id) ? face : null;
  }

  // ---- user corrections --------------------------------------------------------

  rename(id: number, name: string | null): PersonDto {
    this.requirePerson(id);
    this.db.prepare(`UPDATE persons SET name = ?, updated_at = ${NOW} WHERE id = ?`).run(name, id);
    return this.requirePerson(id);
  }

  setHidden(id: number, hidden: boolean): PersonDto {
    this.requirePerson(id);
    this.db.prepare(`UPDATE persons SET hidden = ?, updated_at = ${NOW} WHERE id = ?`).run(hidden ? 1 : 0, id);
    return this.requirePerson(id);
  }

  dismiss(id: number): void {
    const canonicalId = this.requirePerson(id).id;
    const identityIds = (
      this.db
        .prepare(
          `WITH RECURSIVE identity(id) AS (
             SELECT id FROM persons WHERE id = ?
             UNION ALL
             SELECT p.id FROM persons p JOIN identity i ON p.merged_into = i.id
           ) SELECT id FROM identity`,
        )
        .all(canonicalId) as { id: number }[]
    ).map((row) => row.id);
    const placeholders = identityIds.map(() => "?").join(",");
    const tx = this.db.transaction(() => {
      const appleName = this.db.prepare(`SELECT p.name FROM persons p
        WHERE p.id = ? AND p.name IS NOT NULL AND EXISTS (
          SELECT 1 FROM faces f JOIN media m ON m.id = f.media_id
          WHERE f.person_id = p.id AND m.source_kind = 'apple-photos')`)
        .get(canonicalId) as { name: string } | undefined;
      if (appleName) {
        this.db.prepare("INSERT OR IGNORE INTO apple_photos_dismissed_people (name_key) VALUES (?)")
          .run(appleName.name.trim().toLocaleLowerCase());
      }
      const appleFaces = this.db.prepare(`SELECT f.bbox_x AS x, f.bbox_y AS y, f.bbox_w AS w, f.bbox_h AS h, a.faces_json
        FROM faces f JOIN apple_photos_assets a ON a.media_id = f.media_id
        WHERE f.person_id IN (${placeholders}) AND a.faces_json IS NOT NULL`)
        .all(...identityIds) as { x: number; y: number; w: number; h: number; faces_json: string }[];
      const rememberName = this.db.prepare("INSERT OR IGNORE INTO apple_photos_dismissed_people (name_key) VALUES (?)");
      for (const face of appleFaces) {
        let names: { name?: string; x?: number; y?: number; w?: number; h?: number }[];
        try { names = JSON.parse(face.faces_json) as typeof names; } catch { continue; }
        if (!Array.isArray(names)) continue;
        for (const named of names) {
          if (!named.name?.trim() || ![named.x, named.y, named.w, named.h].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
          const left = Math.max(face.x, named.x!), top = Math.max(face.y, named.y!);
          const right = Math.min(face.x + face.w, named.x! + named.w!), bottom = Math.min(face.y + face.h, named.y! + named.h!);
          const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
          const union = face.w * face.h + named.w! * named.h! - intersection;
          if (union > 0 && intersection / union >= 0.4) rememberName.run(named.name.trim().toLocaleLowerCase());
        }
      }
      this.db
        .prepare(`UPDATE faces SET person_id = NULL, assigned_by = NULL, assign_score = NULL, dismissed = 1, discovered_at = ${NOW} WHERE person_id IN (${placeholders})`)
        .run(...identityIds);
      this.db.prepare(`UPDATE persons SET merged_into = NULL WHERE id IN (${placeholders})`).run(...identityIds);
      this.db.prepare(`DELETE FROM persons WHERE id IN (${placeholders})`).run(...identityIds);
    });
    tx();
  }

  merge(intoId: number, fromId: number): PersonDto {
    if (intoId === fromId) throw new PersonError(400, "Cannot merge a person into themselves");
    this.requirePerson(intoId);
    this.requirePerson(fromId);
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE faces SET person_id = ? WHERE person_id = ?").run(intoId, fromId);
      this.db.prepare("INSERT OR IGNORE INTO face_person_rejections (face_id, person_id) SELECT face_id, ? FROM face_person_rejections WHERE person_id = ?").run(intoId, fromId);
      this.db.prepare("DELETE FROM face_person_rejections WHERE person_id = ?").run(fromId);
      this.db.prepare(`UPDATE persons SET merged_into = ?, hidden = 1, updated_at = ${NOW} WHERE id = ?`).run(intoId, fromId);
      this.fixCover(intoId);
    });
    tx();
    return this.requirePerson(intoId);
  }

  // Explicit user decision: this face IS that person (or nobody).
  assignFace(faceId: number, personId: number | null): FaceDto {
    const face = this.faces.get(faceId);
    if (!face) throw new PersonError(404, "Face not found");
    if (personId !== null) this.requirePerson(personId);
    const tx = this.db.transaction(() => {
      if (personId === null && face.person_id !== null) this.faces.addRejection(faceId, face.person_id);
      if (personId !== null) this.db.prepare("DELETE FROM face_person_rejections WHERE face_id = ? AND person_id = ?").run(faceId, personId);
      if (personId !== null) this.faces.restoreDismissed(faceId);
      this.faces.setAssignment(faceId, personId, personId === null ? null : "user", personId === null ? null : 1);
      if (face.person_id !== null) this.fixCover(face.person_id);
      if (personId !== null) this.fixCover(personId);
    });
    tx();
    return this.toFace(this.faces.get(faceId) as FaceRow);
  }

  // "Not this person": unassign if that's who they are, remember the rejection.
  rejectFace(faceId: number, personId: number): FaceDto {
    const face = this.faces.get(faceId);
    if (!face) throw new PersonError(404, "Face not found");
    const tx = this.db.transaction(() => {
      this.faces.addRejection(faceId, personId);
      if (face.person_id === personId) {
        this.faces.setAssignment(faceId, null, null, null);
        this.fixCover(personId);
      }
    });
    tx();
    return this.toFace(this.faces.get(faceId) as FaceRow);
  }

  // One action, everything gone: rows, vectors, crops. Analysis rows go back
  // to pending so re-enabling People re-detects from scratch.
  async deleteAllFaceData(): Promise<void> {
    const model = this.model();
    this.faces.deleteAll();
    this.db.prepare("UPDATE media_analysis SET status = 'pending', attempts = 0, error = NULL WHERE analyzer = 'faces'").run();
    if (model) await this.index.rebuild(spaceFor("faces", model), [], 0);
    fs.rmSync(this.facesDir, { recursive: true, force: true });
    fs.mkdirSync(this.facesDir, { recursive: true });
    this.logger.info("Deleted all face data");
  }
}
