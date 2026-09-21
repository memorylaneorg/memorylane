import { describe, it, expect } from "vitest";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { FaceRepo, faceQuality } from "../../src/persons/face-repo.js";
import type { FaceDetection } from "../../src/providers/types.js";

const det = (x: number, y: number, w: number, h: number, score = 0.9, seed = 1): FaceDetection => ({
  bbox: [x, y, w, h],
  landmarks: [[x, y], [x + w, y], [x + w / 2, y + h / 2], [x, y + h], [x + w, y + h]],
  detScore: score,
  embedding: Float32Array.from([seed, 1 - seed, 0, 0]),
});

describe("FaceRepo", () => {
  it("scores quality by size and confidence", () => {
    expect(faceQuality(0.9, 0.2, 0.3)).toBeCloseTo(0.9);
    expect(faceQuality(0.9, 0.02, 0.02)).toBeCloseTo(0.36);
  });

  it("allows database writes while face vectors are read for an index rebuild", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/lib");
    const media = seedMedia(db, folder, root);
    const repo = new FaceRepo(db);
    const { ids } = repo.replaceForMedia(media, "m@1", [det(0.1, 0.1, 0.2, 0.2), det(0.6, 0.6, 0.2, 0.2)]);

    const rows = repo.iterateVectors("m@1");
    expect(rows.next().value?.id).toBe(ids[0]);
    await Promise.resolve();
    expect(() => db.prepare("UPDATE media SET filename = ? WHERE id = ?").run("kept.jpg", media)).not.toThrow();
    expect(rows.next().value?.id).toBe(ids[1]);
    expect(rows.next().done).toBe(true);
  });

  it("replaces faces per media and carries user assignments/rejections across by overlap", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/lib");
    const media = seedMedia(db, folder, root);
    const repo = new FaceRepo(db);
    const first = repo.replaceForMedia(media, "m@1", [det(0.1, 0.1, 0.2, 0.3), det(0.6, 0.1, 0.2, 0.3)]);
    expect(first.ids).toHaveLength(2);
    expect(first.removed).toEqual([]);
    const person = Number(db.prepare("INSERT INTO persons (auto_label) VALUES ('Person 1')").run().lastInsertRowid);
    const other = Number(db.prepare("INSERT INTO persons (auto_label) VALUES ('Person 2')").run().lastInsertRowid);
    repo.setAssignment(first.ids[0], person, "user", 1);
    repo.setAssignment(first.ids[1], other, "auto", 0.7);
    repo.addRejection(first.ids[1], other);
    db.prepare("UPDATE persons SET cover_face_id = ? WHERE id = ?").run(first.ids[0], person);
    db.prepare("UPDATE persons SET cover_face_id = ? WHERE id = ?").run(first.ids[1], other);

    // Re-detect: first face moved slightly (overlaps), second vanished, a new one appeared elsewhere.
    const second = repo.replaceForMedia(media, "m@2", [det(0.12, 0.11, 0.2, 0.3), det(0.3, 0.6, 0.2, 0.2)]);
    expect(second.removed.sort()).toEqual(first.ids.sort());
    const rows = repo.listByIds(second.ids).sort((a, b) => a.id - b.id);
    expect(rows[0]).toMatchObject({ person_id: person, assigned_by: "user", model: "m@2" });
    expect(rows[1].person_id).toBeNull(); // the auto-assigned face had no overlapping replacement
    expect(repo.rejectionsFor(second.ids[0]).size).toBe(0);
    // Covers follow the replacement (user face) or are cleared (vanished face).
    expect((db.prepare("SELECT cover_face_id c FROM persons WHERE id = ?").get(person) as { c: number }).c).toBe(second.ids[0]);
    expect((db.prepare("SELECT cover_face_id c FROM persons WHERE id = ?").get(other) as { c: number | null }).c).toBeNull();
    expect((db.prepare("SELECT COUNT(*) c FROM faces").get() as { c: number }).c).toBe(2);
    expect(repo.assignedMap("m@2").get(second.ids[0])).toBe(person);
    expect(repo.unassignedQuality("m@2").map((f) => f.id)).toEqual([second.ids[1]]);
    expect(repo.hasUndiscovered("m@2")).toBe(true);
    repo.markDiscovered([second.ids[1]]);
    expect(repo.hasUndiscovered("m@2")).toBe(false);
    repo.deleteAll();
    expect((db.prepare("SELECT COUNT(*) c FROM persons").get() as { c: number }).c).toBe(0);
  });
});
