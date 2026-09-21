import { describe, it, expect } from "vitest";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { applyApplePersonSuggestions } from "../../src/plugins/apple-photos/people.js";

describe("Apple named-person suggestions", () => {
  it("matches overlapping detector faces but preserves explicit user assignments and dismissals", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/library");
    const mediaId = seedMedia(db, folder, root);
    db.prepare("UPDATE media SET source_kind = 'apple-photos' WHERE id = ?").run(mediaId);
    db.prepare(`INSERT INTO apple_photos_assets (scan_root_id, uuid, media_id, faces_json)
      VALUES (?, 'apple-1', ?, ?)`)
      .run(root, mediaId, JSON.stringify([{ name: "Maya", x: 0.4, y: 0.4, w: 0.2, h: 0.2 }]));
    const faceId = Number(db.prepare(`INSERT INTO faces
      (media_id, model, bbox_x, bbox_y, bbox_w, bbox_h, det_score, quality, embedding)
      VALUES (?, 'test', 0.41, 0.41, 0.2, 0.2, 0.9, 0.9, ?)`)
      .run(mediaId, Buffer.alloc(4)).lastInsertRowid);
    try {
      expect(applyApplePersonSuggestions(db, mediaId)).toBe(1);
      const assigned = db.prepare("SELECT p.name, f.assigned_by FROM faces f JOIN persons p ON p.id = f.person_id WHERE f.id = ?").get(faceId);
      expect(assigned).toEqual({ name: "Maya", assigned_by: "apple" });

      const userId = Number(db.prepare("INSERT INTO persons (name, auto_label) VALUES ('User choice', 'Person 99')").run().lastInsertRowid);
      db.prepare("UPDATE faces SET person_id = ?, assigned_by = 'user' WHERE id = ?").run(userId, faceId);
      expect(applyApplePersonSuggestions(db, mediaId)).toBe(0);
      expect(db.prepare("SELECT person_id FROM faces WHERE id = ?").get(faceId)).toEqual({ person_id: userId });

      db.prepare("UPDATE faces SET assigned_by = 'auto' WHERE id = ?").run(faceId);
      expect(applyApplePersonSuggestions(db, mediaId)).toBe(0);
      expect(db.prepare("SELECT person_id FROM faces WHERE id = ?").get(faceId)).toEqual({ person_id: userId });

      db.prepare("UPDATE faces SET person_id = NULL, assigned_by = NULL, dismissed = 1 WHERE id = ?").run(faceId);
      expect(applyApplePersonSuggestions(db, mediaId)).toBe(0);
    } finally { db.close(); }
  });
});
