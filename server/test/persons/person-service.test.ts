import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { startFakeSidecar, type FakeSidecar } from "../helpers/fake-sidecar.js";
import { SidecarProvider } from "../../src/providers/sidecar-provider.js";
import { SettingsRepo } from "../../src/db/settings-repo.js";
import { MemoryVectorIndex } from "../../src/vectors/memory-vector-index.js";
import { spaceFor } from "../../src/vectors/vector-index.js";
import { FaceRepo } from "../../src/persons/face-repo.js";
import { PersonService, PersonError } from "../../src/persons/person-service.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as import("pino").Logger;
let fake: FakeSidecar;
let dir: string;
beforeAll(async () => {
  fake = await startFakeSidecar();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-persons-"));
});
afterAll(async () => {
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 8-d unit vectors: identity A near e0, identity B near e1, noise near e2.
const vec = (axis: number, wobble: number): Float32Array => {
  const v = new Float32Array(8);
  v[axis] = 1;
  v[(axis + 3) % 8] = wobble;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

async function setup() {
  const db = await createTestDb();
  const root = seedScanRoot(db), folder = seedFolder(db, root, "/lib");
  const settings = new SettingsRepo(db);
  settings.update({ personsEnabled: true, faceMinClusterSize: 2 });
  const provider = new SidecarProvider(fake.url, { expectedModel: fake.model, healthTtlMs: 0 });
  const index = new MemoryVectorIndex();
  const faces = new FaceRepo(db);
  const svc = new PersonService(db, logger, settings, () => provider, index, path.join(dir, "faces"));
  const space = spaceFor("faces", "yunet-sface@1");
  const addFace = async (vector: Float32Array, quality = 0.9) => {
    const media = seedMedia(db, folder, root);
    const { ids } = faces.replaceForMedia(media, "yunet-sface@1", [{ bbox: [0.1, 0.1, 0.3, 0.3], landmarks: [], detScore: quality, embedding: vector }]);
    await index.upsert(space, [{ id: ids[0], vector }]);
    return ids[0];
  };
  return { db, settings, svc, faces, index, addFace };
}

describe("PersonService discovery + assignment", () => {
  it("remembers the Photos identity when a renamed Apple person is dismissed", async () => {
    const S = await setup();
    const faceId = await S.addFace(vec(0, 0.1));
    const mediaId = S.faces.get(faceId)!.media_id;
    const rootId = (S.db.prepare("SELECT scan_root_id FROM media WHERE id = ?").get(mediaId) as { scan_root_id: number }).scan_root_id;
    S.db.prepare("INSERT INTO plugin_settings (id, enabled) VALUES ('apple-photos', 1)").run();
    S.db.prepare("UPDATE media SET source_kind = 'apple-photos' WHERE id = ?").run(mediaId);
    S.db.prepare("INSERT INTO apple_photos_assets (scan_root_id, uuid, media_id, faces_json) VALUES (?, 'apple-person', ?, ?)")
      .run(rootId, mediaId, JSON.stringify([{ name: "Maya", x: 0.1, y: 0.1, w: 0.3, h: 0.3 }]));
    const personId = Number(S.db.prepare("INSERT INTO persons (name, auto_label) VALUES ('Maya', 'Person 1')").run().lastInsertRowid);
    S.faces.setAssignment(faceId, personId, "apple", 1);
    S.svc.rename(personId, "Renamed");
    S.svc.dismiss(personId);
    expect(S.db.prepare("SELECT name_key FROM apple_photos_dismissed_people WHERE name_key = 'maya'").get())
      .toEqual({ name_key: "maya" });
  });

  it("discovers two people from two tight groups, leaves a singleton, then assigns new faces incrementally", async () => {
    const S = await setup();
    const a1 = await S.addFace(vec(0, 0.1)), a2 = await S.addFace(vec(0, 0.15)), a3 = await S.addFace(vec(0, 0.2));
    const b1 = await S.addFace(vec(1, 0.1)), b2 = await S.addFace(vec(1, 0.12));
    const lone = await S.addFace(vec(2, 0.1));
    expect(S.svc.needsDiscovery()).toBe(true);
    const r = await S.svc.discover();
    expect(r.persons).toBe(2);
    expect(r.assigned).toBe(5);
    expect(S.svc.needsDiscovery()).toBe(false);
    const persons = S.svc.listPersons(false);
    expect(persons.map((p) => [p.autoLabel, p.faceCount])).toEqual([["Person 1", 3], ["Person 2", 2]]);
    expect(persons[0].coverFaceId).not.toBeNull();
    expect(S.faces.get(lone)!.person_id).toBeNull();
    // A later face near identity A joins Person 1 without re-clustering.
    const a4 = await S.addFace(vec(0, 0.05));
    expect(await S.svc.assignNewFaces([a4])).toBe(1);
    expect(S.faces.get(a4)).toMatchObject({ person_id: persons[0].id, assigned_by: "auto" });
    void [a1, a2, a3, b1, b2];
  });

  it("respects rejections and user assignments across discovery", async () => {
    const S = await setup();
    const a1 = await S.addFace(vec(0, 0.1)), a2 = await S.addFace(vec(0, 0.15));
    await S.svc.discover();
    const person = S.svc.listPersons(false)[0];
    // User says a2 is NOT this person -> unassigned + rejected; discovery must not re-add it.
    // Make a2 the cover first so the cover has to move to a remaining face.
    S.db.prepare("UPDATE persons SET cover_face_id = ? WHERE id = ?").run(a2, person.id);
    S.svc.rejectFace(a2, person.id);
    expect(S.faces.get(a2)!.person_id).toBeNull();
    expect(S.svc.getPerson(person.id)!.coverFaceId).toBe(a1);
    const a3 = await S.addFace(vec(0, 0.12));
    await S.svc.discover();
    expect(S.faces.get(a2)!.person_id).toBeNull();
    expect(S.faces.get(a3)!.person_id).toBe(person.id);
    // A user assignment to a second person survives merge direction and later discovery.
    const b1 = await S.addFace(vec(1, 0.1));
    const other = S.svc.listPersons(true).find((p) => p.id !== person.id) ?? null;
    expect(other).toBeNull();
    const assigned = S.svc.assignFace(b1, person.id);
    expect(assigned.assignedBy).toBe("user");
    await S.svc.discover();
    expect(S.faces.get(b1)).toMatchObject({ person_id: person.id, assigned_by: "user" });
    void a1;
  });

  it("rename, hide, merge, list ordering and delete-all", async () => {
    const S = await setup();
    await S.addFace(vec(0, 0.1)); await S.addFace(vec(0, 0.15));
    await S.addFace(vec(1, 0.1)); await S.addFace(vec(1, 0.15));
    await S.svc.discover();
    const [p1, p2] = S.svc.listPersons(false);
    expect(S.svc.rename(p1.id, "Maya").displayName).toBe("Maya");
    expect(S.svc.listPersons(false)[0].id).toBe(p1.id); // naming does not change count-based order
    expect(S.svc.setHidden(p2.id, true).hidden).toBe(true);
    expect(S.svc.listPersons(false)).toHaveLength(1);
    expect(S.svc.listPersons(true)).toHaveLength(2);
    S.svc.setHidden(p2.id, false);
    const merged = S.svc.merge(p1.id, p2.id);
    expect(merged.faceCount).toBe(4);
    expect(S.svc.getPerson(p2.id)!.id).toBe(p1.id); // merged persons resolve to their target
    expect(S.svc.listPersons(true)).toHaveLength(1);
    expect(() => S.svc.merge(p1.id, p1.id)).toThrow(PersonError);
    await S.svc.deleteAllFaceData();
    expect(S.svc.listPersons(true)).toHaveLength(0);
    expect(await S.index.count(spaceFor("faces", "yunet-sface@1"))).toBe(0);
  });

  it("does nothing while People is off", async () => {
    const S = await setup();
    S.settings.update({ personsEnabled: false });
    await S.addFace(vec(0, 0.1)); await S.addFace(vec(0, 0.15));
    expect(S.svc.needsDiscovery()).toBe(false);
    expect(await S.svc.discover()).toEqual({ persons: 0, assigned: 0 });
  });
});

describe("PersonService.regroup", () => {
  it("redoes automatic groupings but keeps names, confirmed faces and rejections", async () => {
    const S = await setup();
    const a1 = await S.addFace(vec(0, 0.1)), a2 = await S.addFace(vec(0, 0.15)), b1 = await S.addFace(vec(1, 0.1)), b2 = await S.addFace(vec(1, 0.15));
    await S.svc.discover();
    const [pA, pB] = S.svc.listPersons(false);
    S.svc.rename(pA.id, "Maya");
    S.svc.assignFace(a1, pA.id); // user-confirmed
    S.svc.rejectFace(b2, pA.id);
    const r = await S.svc.regroup();
    expect(r.assigned).toBeGreaterThanOrEqual(3);
    const maya = S.svc.listPersons(true).find((p) => p.name === "Maya")!;
    expect(maya).toBeDefined();
    expect(S.faces.get(a1)).toMatchObject({ person_id: maya.id, assigned_by: "user" });
    expect(S.faces.get(a2)!.person_id).toBe(maya.id);
    expect(S.faces.get(b1)!.person_id).not.toBe(maya.id);
    expect(S.faces.rejectionsFor(b2).has(maya.id)).toBe(true);
    expect(S.svc.getPerson(pB.id)).toBeNull(); // unnamed auto person was rebuilt under a new id
  });
});

describe("model switch keeps people populated", () => {
  it("carries automatic assignments to the re-detected faces and hides emptied unnamed persons", async () => {
    const S = await setup();
    const a1 = await S.addFace(vec(0, 0.1)), a2 = await S.addFace(vec(0, 0.15));
    await S.svc.discover();
    const person = S.svc.listPersons(false)[0];
    // Re-detect a1's photo under a new model with an overlapping box: the auto assignment must survive.
    const media = S.faces.get(a1)!.media_id;
    const { ids } = S.faces.replaceForMedia(media, "other@1", [{ bbox: [0.12, 0.1, 0.3, 0.3], landmarks: [], detScore: 0.9, embedding: vec(0, 0.1) }]);
    expect(S.faces.get(ids[0])).toMatchObject({ person_id: person.id, assigned_by: "auto", model: "other@1" });
    expect(S.svc.getPerson(person.id)!.faceCount).toBe(2);
    // Re-detect a2's photo with no face at all: the person keeps a1's replacement, cover re-picked.
    S.faces.replaceForMedia(S.faces.get(a2)!.media_id, "other@1", []);
    expect(S.svc.getPerson(person.id)!.faceCount).toBe(1);
    // A person that loses every face and has no name disappears from the list.
    S.faces.replaceForMedia(media, "other@1", []);
    expect(S.svc.listPersons(true)).toHaveLength(0);
  });
});
