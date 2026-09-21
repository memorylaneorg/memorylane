import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import type { StackRefDto } from "@memorylane/shared";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { StackService, StackError } from "../../src/stacks/stack-service.js";
import { SettingsRepo } from "../../src/db/settings-repo.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as import("pino").Logger;
const H0 = "0000000000000000";
const H1 = "0000000000000001";
const HFAR = "ffffffffffffffff";
const t = (ms: number) => new Date(Date.UTC(2024, 4, 12, 10, 31, 44, 0) + ms).toISOString().slice(0, 23);

async function setup() {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const folder = seedFolder(db, root, "/library/burst");
  const svc = new StackService(db, logger, new SettingsRepo(db));
  const exif = db.prepare(
    "INSERT INTO media_exif (media_id, captured_at_precise, camera_serial, burst_id, tags_json, exiftool_version) VALUES (?, ?, ?, ?, '{}', 't')",
  );
  const hash = db.prepare("INSERT INTO media_phash (media_id, phash, version) VALUES (?, ?, 'v')");
  const shot = (ms: number, phash: string | null = H0, body = "R5", burst: string | null = null) => {
    const id = seedMedia(db, folder, root);
    exif.run(id, t(ms), body, burst);
    if (phash) hash.run(id, phash);
    return id;
  };
  return { db, root, folder, svc, shot };
}
const stackOf = (db: Database.Database, mediaId: number) =>
  (db.prepare("SELECT stack_id FROM stack_members WHERE media_id = ?").get(mediaId) as { stack_id: number } | undefined)?.stack_id ?? null;

describe("StackService.recomputeFolder", () => {
  it("creates burst stacks with the first shot as cover and leaves singles", async () => {
    const { db, folder, svc, shot } = await setup();
    const a = shot(0), b = shot(100, H1), c = shot(200), d = shot(10_000, HFAR);
    expect(svc.recomputeFolder(folder)).toBe(1);
    const s = svc.getStack(stackOf(db, a)!)!;
    expect(s).toMatchObject({ kind: "burst", coverMediaId: a, count: 3, userModified: false });
    expect(stackOf(db, d)).toBeNull();
    expect(svc.getMembers(s.id).map((m) => m.id)).toEqual([a, b, c]);
  });
  it("is idempotent and replaces stale auto stacks", async () => {
    const { db, folder, svc, shot } = await setup();
    const a = shot(0), b = shot(100);
    svc.recomputeFolder(folder);
    const first = stackOf(db, a);
    db.prepare("DELETE FROM media_phash WHERE media_id = ?").run(b);
    db.prepare("INSERT INTO media_phash (media_id, phash, version) VALUES (?, ?, 'v')").run(b, HFAR);
    expect(svc.recomputeFolder(folder)).toBe(0);
    expect(stackOf(db, a)).toBeNull();
    expect(first).not.toBeNull();
  });
  it("never rewrites a user-modified stack and skips excluded photos", async () => {
    const { db, folder, svc, shot } = await setup();
    const a = shot(0), b = shot(100), c = shot(200), d = shot(300);
    svc.recomputeFolder(folder);
    const s = stackOf(db, a)!;
    svc.setCover(s, b); // marks user_modified
    svc.removeMember(s, d); // d excluded, stack now a,b,c
    svc.recomputeFolder(folder);
    expect(svc.getStack(s)).toMatchObject({ coverMediaId: b, count: 3, userModified: true });
    expect(stackOf(db, d)).toBeNull();
  });
  it("recomputeDirty processes marked folders and clears them", async () => {
    const { db, folder, svc, shot } = await setup();
    shot(0);
    shot(100);
    db.prepare("INSERT INTO stack_dirty_folders (folder_id) VALUES (?)").run(folder);
    expect(svc.recomputeDirty()).toBe(1);
    expect(svc.recomputeDirty()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM stacks").get() as { c: number }).c).toBe(1);
  });
});

describe("StackService v2 candidates", () => {
  it("uses embeddings for the configured model", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/library/burst");
    const svc = new StackService(db, logger, new SettingsRepo(db), () => "m@1");
    const exif = db.prepare("INSERT INTO media_exif (media_id, captured_at_precise, camera_serial, tags_json, exiftool_version) VALUES (?, ?, 'R5', '{}', 't')");
    const emb = db.prepare("INSERT INTO media_embeddings (media_id, model, dim, vector) VALUES (?, 'm@1', 2, ?)");
    const a = seedMedia(db, folder, root), b = seedMedia(db, folder, root);
    exif.run(a, t(0)); exif.run(b, t(100));
    // No hashes at all - only the embedding rule can group these.
    emb.run(a, Buffer.from(new Float32Array([1, 0]).buffer)); emb.run(b, Buffer.from(new Float32Array([0.99, 0.14]).buffer));
    expect(svc.recomputeFolder(folder)).toBe(1);
    expect(svc.getStack(stackOf(db, a)!)!.count).toBe(2);
    const noModel = new StackService(db, logger, new SettingsRepo(db));
    expect(noModel.recomputeFolder(folder)).toBe(0);
    expect(svc.hasStaleAutoStacks()).toBe(false);
  });
});

describe("StackService user operations", () => {
  it("createManual, setCover, split, merge, removeMember, deleteStack", async () => {
    const { db, svc, shot } = await setup();
    const a = shot(0, null), b = shot(60_000, null), c = shot(120_000, null), d = shot(180_000, null);
    const s = svc.createManual([a, b, c, d]);
    expect(s).toMatchObject({ kind: "manual", coverMediaId: a, count: 4, userModified: true });
    expect(() => svc.createManual([a, b])).toThrow(StackError); // already stacked
    expect(svc.setCover(s.id, c).coverMediaId).toBe(c);
    expect(() => svc.setCover(s.id, 9999)).toThrow(StackError);
    const s2 = svc.split(s.id, [c, d]);
    expect(s2.count).toBe(2);
    expect(svc.getStack(s.id)).toMatchObject({ count: 2, coverMediaId: a }); // cover moved out -> first remaining
    const merged = svc.merge(s.id, s2.id);
    expect(merged).toMatchObject({ id: s.id, count: 4 });
    expect(svc.getStack(s2.id)).toBeNull();
    expect(svc.removeMember(s.id, d)!.count).toBe(3);
    expect((db.prepare("SELECT COUNT(*) c FROM stack_exclusions WHERE media_id = ?").get(d) as { c: number }).c).toBe(1);
    svc.deleteStack(s.id);
    expect(svc.getStack(s.id)).toBeNull();
    expect((db.prepare("SELECT COUNT(*) c FROM stack_exclusions").get() as { c: number }).c).toBe(4);
  });
  it("dissolves a stack that drops below two members", async () => {
    const { svc, shot } = await setup();
    const a = shot(0, null), b = shot(1000, null);
    const s = svc.createManual([a, b]);
    expect(svc.removeMember(s.id, a)).toBeNull();
    expect(svc.getStack(s.id)).toBeNull();
  });
  it("rejects cross-folder manual stacks", async () => {
    const { db, root, svc, shot } = await setup();
    const other = seedFolder(db, root, "/library/other");
    const a = shot(0, null);
    const b = seedMedia(db, other, root);
    expect(() => svc.createManual([a, b])).toThrow(/same folder/);
  });
  it("attachStacks decorates DTO-like items", async () => {
    const { svc, shot } = await setup();
    const a = shot(0, null), b = shot(1000, null), c = shot(5000, null);
    const s = svc.createManual([a, b]);
    const items: { id: number; stack: StackRefDto | null }[] = [{ id: a, stack: null }, { id: b, stack: null }, { id: c, stack: null }];
    svc.attachStacks(items);
    expect(items[0].stack).toEqual({ id: s.id, count: 2, isCover: true });
    expect(items[1].stack).toEqual({ id: s.id, count: 2, isCover: false });
    expect(items[2].stack).toBeNull();
  });
});
