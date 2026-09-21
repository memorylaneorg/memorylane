import type Database from "better-sqlite3";

interface Box { x: number; y: number; w: number; h: number }
interface NamedBox extends Box { name: string }
interface FaceBox extends Box { id: number; person_id: number | null; assigned_by: string | null; dismissed: number }

function overlap(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w), bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

export function applyApplePersonSuggestions(db: Database.Database, mediaId: number): number {
  const asset = db.prepare("SELECT faces_json FROM apple_photos_assets WHERE media_id = ?").get(mediaId) as { faces_json: string | null } | undefined;
  if (!asset?.faces_json) return 0;
  let suggestions: NamedBox[];
  try { suggestions = JSON.parse(asset.faces_json) as NamedBox[]; }
  catch { return 0; }
  if (!Array.isArray(suggestions) || suggestions.length === 0) return 0;
  const faces = db.prepare("SELECT id, bbox_x AS x, bbox_y AS y, bbox_w AS w, bbox_h AS h, person_id, assigned_by, dismissed FROM faces WHERE media_id = ?")
    .all(mediaId) as FaceBox[];
  let applied = 0;
  const tx = db.transaction(() => {
    for (const suggestion of suggestions) {
      const name = typeof suggestion.name === "string" ? suggestion.name.trim() : "";
      if (!name || ![suggestion.x, suggestion.y, suggestion.w, suggestion.h].every(Number.isFinite)) continue;
      if (suggestion.w <= 0 || suggestion.h <= 0) continue;
      const dismissed = db.prepare("SELECT 1 FROM apple_photos_dismissed_people WHERE name_key = ?")
        .get(name.toLocaleLowerCase());
      if (dismissed) continue;
      let best: FaceBox | null = null;
      let score = 0.4;
      for (const face of faces) {
        if (face.dismissed || face.person_id !== null) continue;
        const value = overlap(face, suggestion);
        if (value >= score) { best = face; score = value; }
      }
      if (!best) continue;
      let person = db.prepare("SELECT id FROM persons WHERE lower(name) = ? AND merged_into IS NULL ORDER BY id LIMIT 1")
        .get(name.toLocaleLowerCase()) as { id: number } | undefined;
      if (person) {
        const rejection = db.prepare("SELECT 1 FROM face_person_rejections WHERE face_id = ? AND person_id = ?")
          .get(best.id, person.id);
        if (rejection) continue;
      } else {
        const next = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM persons").get() as { n: number }).n;
        const info = db.prepare("INSERT INTO persons (name, auto_label, cover_face_id) VALUES (?, ?, ?)")
          .run(name, `Person ${next}`, best.id);
        person = { id: Number(info.lastInsertRowid) };
      }
      db.prepare("UPDATE faces SET person_id = ?, assigned_by = 'apple', assign_score = ? WHERE id = ?")
        .run(person.id, score, best.id);
      db.prepare("UPDATE persons SET cover_face_id = COALESCE(cover_face_id, ?) WHERE id = ?").run(best.id, person.id);
      best.person_id = person.id;
      best.assigned_by = "apple";
      applied++;
    }
  });
  tx();
  return applied;
}
