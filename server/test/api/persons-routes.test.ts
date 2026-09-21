import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { startFakeSidecar, type FakeSidecar } from "../helpers/fake-sidecar.js";
import { SidecarProvider } from "../../src/providers/sidecar-provider.js";
import { SettingsRepo } from "../../src/db/settings-repo.js";
import { FaceRepo } from "../../src/persons/face-repo.js";
import { spaceFor } from "../../src/vectors/vector-index.js";

let fake: FakeSidecar;
beforeAll(async () => {
  fake = await startFakeSidecar();
});
afterAll(() => fake.close());

const vec = (axis: number, wobble: number): Float32Array => {
  const v = new Float32Array(8);
  v[axis] = 1;
  v[(axis + 3) % 8] = wobble;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

async function seeded() {
  const provider = new SidecarProvider(fake.url, { expectedModel: fake.model, healthTtlMs: 0 });
  const t = await createTestApp({ provider });
  new SettingsRepo(t.db).update({ personsEnabled: true, faceMinClusterSize: 2 });
  const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, "/lib");
  const faces = new FaceRepo(t.db);
  const space = spaceFor("faces", "yunet-sface@1");
  const media: number[] = [];
  const faceIds: number[] = [];
  for (const v of [vec(0, 0.1), vec(0, 0.15), vec(1, 0.1), vec(1, 0.12)]) {
    const m = seedMedia(t.db, folder, root);
    const { ids } = faces.replaceForMedia(m, "yunet-sface@1", [{ bbox: [0.2, 0.2, 0.3, 0.3], landmarks: [], detScore: 0.9, embedding: v }]);
    await t.ctx.vectorIndex.upsert(space, [{ id: ids[0], vector: v }]);
    media.push(m);
    faceIds.push(ids[0]);
  }
  await t.ctx.persons.discover();
  return { t, media, faceIds, faces };
}
type T = Awaited<ReturnType<typeof createTestApp>>;
const call = (t: T, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie: t.cookie }, payload });

describe("people routes", () => {
  it("dismisses the canonical group when removal uses a merged alias", async () => {
    const S = await seeded();
    try {
      const [canonical, alias] = (await call(S.t, "GET", "/api/persons")).json();
      expect((await call(S.t, "POST", `/api/persons/${canonical.id}/merge`, { personId: alias.id })).statusCode).toBe(200);

      const removed = await call(S.t, "DELETE", `/api/persons/${alias.id}`);
      expect(removed.statusCode).toBe(204);
      expect((await call(S.t, "GET", "/api/persons?includeHidden=true")).json()).toEqual([]);
      expect(S.t.db.prepare("SELECT COUNT(*) AS n FROM persons").get()).toEqual({ n: 0 });
      expect(S.t.db.prepare("SELECT COUNT(*) AS n FROM faces WHERE person_id IS NULL AND dismissed = 1").get()).toEqual({ n: 4 });
    } finally {
      await S.t.close();
    }
  });

  it("permanently dismisses a person without deleting face detections", async () => {
    const S = await seeded();
    try {
      const [person] = (await call(S.t, "GET", "/api/persons")).json();
      const removedFaceIds = S.faceIds.slice(0, 2);
      const removedMediaId = S.faces.get(removedFaceIds[0])!.media_id;

      const removed = await call(S.t, "DELETE", `/api/persons/${person.id}`);
      expect(removed.statusCode).toBe(204);
      expect((await call(S.t, "GET", "/api/persons")).json()).toHaveLength(1);
      expect(
        S.t.db.prepare(`SELECT id, person_id, dismissed FROM faces WHERE id IN (${removedFaceIds.map(() => "?").join(",")}) ORDER BY id`).all(...removedFaceIds),
      ).toEqual(removedFaceIds.map((id) => ({ id, person_id: null, dismissed: 1 })));
      expect(S.t.db.prepare("SELECT COUNT(*) AS n FROM media").get()).toEqual({ n: 4 });
      expect(await S.t.ctx.vectorIndex.count(spaceFor("faces", "yunet-sface@1"))).toBe(4);

      await S.t.ctx.persons.discover();
      expect((await call(S.t, "GET", "/api/persons")).json()).toHaveLength(1);

      const replacementVector = vec(1, 0.1);
      const replacement = S.faces.replaceForMedia(removedMediaId, "yunet-sface@1", [
        { bbox: [0.21, 0.2, 0.3, 0.3], landmarks: [], detScore: 0.9, embedding: replacementVector },
      ]);
      await S.t.ctx.vectorIndex.upsert(spaceFor("faces", "yunet-sface@1"), [{ id: replacement.ids[0], vector: replacementVector }]);
      expect(S.t.db.prepare("SELECT dismissed FROM faces WHERE id = ?").get(replacement.ids[0])).toEqual({ dismissed: 1 });
      expect(await S.t.ctx.persons.assignNewFaces(replacement.ids)).toBe(0);
      expect(S.faces.get(replacement.ids[0])!.person_id).toBeNull();
      await S.t.ctx.persons.discover();
      const [remaining] = (await call(S.t, "GET", "/api/persons")).json();
      expect(remaining).toBeDefined();

      const restored = await call(S.t, "POST", `/api/faces/${replacement.ids[0]}/assign`, { personId: remaining.id });
      expect(restored.json()).toMatchObject({ personId: remaining.id, assignedBy: "user" });
      expect(S.t.db.prepare("SELECT dismissed FROM faces WHERE id = ?").get(replacement.ids[0])).toEqual({ dismissed: 0 });
    } finally {
      await S.t.close();
    }
  });

  it("lists, renames, filters media by person, corrects faces, merges, deletes all, and gates on the opt-in", async () => {
    const S = await seeded();
    try {
      let list = (await call(S.t, "GET", "/api/persons")).json();
      expect(list.map((p: { autoLabel: string; faceCount: number }) => [p.autoLabel, p.faceCount])).toEqual([["Person 1", 2], ["Person 2", 2]]);
      const [p1, p2] = list;

      const renamed = await call(S.t, "PATCH", `/api/persons/${p1.id}`, { name: "Maya" });
      expect(renamed.json().displayName).toBe("Maya");
      const detail = await call(S.t, "GET", `/api/persons/${p1.id}`);
      expect(detail.json().faces).toHaveLength(2);

      const photos = await call(S.t, "GET", `/api/media?personIds=${p1.id}`);
      expect(photos.json().items.map((m: { id: number }) => m.id).sort()).toEqual([S.media[0], S.media[1]].sort());
      expect((await call(S.t, "GET", `/api/media/${S.media[0]}/faces`)).json()).toHaveLength(1);

      // "Not Maya" on one of her faces -> unassigned; assign it to Person 2 explicitly.
      const rejected = await call(S.t, "POST", `/api/faces/${S.faceIds[1]}/reject`, { personId: p1.id });
      expect(rejected.json().personId).toBeNull();
      const assigned = await call(S.t, "POST", `/api/faces/${S.faceIds[1]}/assign`, { personId: p2.id });
      expect(assigned.json()).toMatchObject({ personId: p2.id, assignedBy: "user" });

      const merged = await call(S.t, "POST", `/api/persons/${p1.id}/merge`, { personId: p2.id });
      expect(merged.json().faceCount).toBe(4);
      list = (await call(S.t, "GET", "/api/persons")).json();
      expect(list).toHaveLength(1);
      expect((await call(S.t, "GET", `/api/persons/${p2.id}`)).json().person.id).toBe(p1.id);

      expect((await call(S.t, "POST", "/api/persons/9999/merge", { personId: p1.id })).statusCode).toBe(404);
      expect((await call(S.t, "GET", "/api/faces/9999/crop")).statusCode).toBe(404);

      expect((await call(S.t, "DELETE", "/api/persons/data")).statusCode).toBe(204);
      expect((await call(S.t, "GET", "/api/persons")).json()).toEqual([]);

      new SettingsRepo(S.t.db).update({ personsEnabled: false });
      const off = await call(S.t, "GET", "/api/persons");
      expect(off.statusCode).toBe(404);
      expect(off.json().error).toContain("turned off");
    } finally {
      await S.t.close();
    }
  });
});
