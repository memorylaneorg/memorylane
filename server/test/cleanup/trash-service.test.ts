import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { computeFingerprint } from "../../src/scanner/fingerprint.js";
import { TrashService } from "../../src/cleanup/trash-service.js";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-trash-test-"));
  const db = await createTestDb();
  const root = seedScanRoot(db, dir);
  const folder = seedFolder(db, root, dir);
  const image = seedMedia(db, folder, root, { filename: "photo.jpg" });
  const raw = seedMedia(db, folder, root, { filename: "photo.cr3", media_type: "raw" });
  const files = [path.join(dir, "photo.jpg"), path.join(dir, "photo.cr3"), path.join(dir, "photo.xmp")];
  for (const file of files) fs.writeFileSync(file, file);
  for (const [id, file] of [[image, files[0]], [raw, files[1]]] as const) {
    const stat = fs.statSync(file);
    db.prepare("UPDATE media SET absolute_path = ?, fingerprint = ?, file_size = ? WHERE id = ?")
      .run(file, computeFingerprint(stat.size, stat.mtimeMs), stat.size, id);
  }
  db.prepare("UPDATE media SET raw_pair_id = ? WHERE id = ?").run(raw, image);
  db.prepare("INSERT INTO deletion_marks (media_id) VALUES (?)").run(image);
  return { db, dir, image, raw, files, service: new TrashService(db, () => false),
    close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

it("moves a marked photo, RAW companion, and sidecar to visible trash and restores them", async () => {
  const f = await fixture();
  try {
    await f.service.move(f.image);
    expect(f.files.every((file) => !fs.existsSync(file))).toBe(true);
    expect(f.files.every((file) => fs.existsSync(path.join(f.dir, "_MemoryLane-Trash", String(f.image), path.basename(file))))).toBe(true);
    expect((f.db.prepare("SELECT status FROM trash_entries WHERE media_id = ?").get(f.image) as { status: string }).status).toBe("trashed");
    await f.service.restore(f.image);
    expect(f.files.every((file) => fs.existsSync(file))).toBe(true);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM deletion_marks").get() as { c: number }).c).toBe(0);
  } finally { f.close(); }
});

it("refuses a changed source file without moving anything", async () => {
  const f = await fixture();
  try {
    fs.appendFileSync(f.files[0], "changed");
    await expect(f.service.move(f.image)).rejects.toThrow(/changed/i);
    expect(f.files.every((file) => fs.existsSync(file))).toBe(true);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM trash_entries").get() as { c: number }).c).toBe(0);
  } finally { f.close(); }
});

it("refuses to overwrite a file that appeared after moving to trash", async () => {
  const f = await fixture();
  try {
    await f.service.move(f.image);
    fs.writeFileSync(f.files[0], "new file");
    await expect(f.service.restore(f.image)).rejects.toThrow(/occupied/i);
    expect(fs.readFileSync(f.files[0], "utf8")).toBe("new file");
    expect(fs.existsSync(path.join(f.dir, "_MemoryLane-Trash", String(f.image), "photo.jpg"))).toBe(true);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM trash_entries").get() as { c: number }).c).toBe(1);
  } finally { f.close(); }
});

it("permanently deletes only a previously trashed group", async () => {
  const f = await fixture();
  try {
    await expect(f.service.empty(f.image)).rejects.toThrow();
    await f.service.move(f.image);
    await f.service.empty(f.image);
    expect(fs.existsSync(path.join(f.dir, "_MemoryLane-Trash", String(f.image), "photo.jpg"))).toBe(false);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM media WHERE id IN (?, ?)").get(f.image, f.raw) as { c: number }).c).toBe(0);
  } finally { f.close(); }
});

it("rejects a preexisting trash group and a tampered manifest", async () => {
  const f = await fixture();
  try {
    const group = path.join(f.dir, "_MemoryLane-Trash", String(f.image));
    fs.mkdirSync(path.dirname(group), { recursive: true });
    fs.symlinkSync(f.dir, group);
    await expect(f.service.move(f.image)).rejects.toThrow(/trash/i);
    fs.unlinkSync(group);
    await f.service.move(f.image);
    f.db.prepare("UPDATE trash_entries SET files_json = ? WHERE media_id = ?")
      .run(JSON.stringify([{ original: f.files[0], trashed: path.join(f.dir, "unrelated.txt"), mediaId: f.image }]), f.image);
    await expect(f.service.empty(f.image)).rejects.toThrow(/manifest|trash path/i);
  } finally { f.close(); }
});

it("recovers a move interrupted before the trash directory was created", async () => {
  const f = await fixture();
  try {
    const manifest = f.files.map((original, index) => ({
      original,
      trashed: path.join(f.dir, "_MemoryLane-Trash", String(f.image), path.basename(original)),
      mediaId: index === 0 ? f.image : index === 1 ? f.raw : null,
    }));
    f.db.prepare("INSERT INTO trash_entries (media_id, status, files_json) VALUES (?, 'moving', ?)")
      .run(f.image, JSON.stringify(manifest));
    await f.service.restore(f.image);
    expect(f.files.every((file) => fs.existsSync(file))).toBe(true);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM trash_entries").get() as { c: number }).c).toBe(0);
  } finally { f.close(); }
});

it("restores the original stack cover when trashed files are restored", async () => {
  const f = await fixture();
  try {
    const other = seedMedia(f.db, (f.db.prepare("SELECT parent_folder_id AS id FROM media WHERE id = ?").get(f.image) as { id: number }).id,
      (f.db.prepare("SELECT scan_root_id AS id FROM media WHERE id = ?").get(f.image) as { id: number }).id,
      { filename: "other.jpg" });
    const folder = (f.db.prepare("SELECT parent_folder_id AS id FROM media WHERE id = ?").get(f.image) as { id: number }).id;
    const stack = Number(f.db.prepare("INSERT INTO stacks (kind, cover_media_id, parent_folder_id, user_modified) VALUES ('manual', ?, ?, 1)").run(f.image, folder).lastInsertRowid);
    f.db.prepare("INSERT INTO stack_members (stack_id, media_id, position) VALUES (?, ?, ?)").run(stack, f.image, 0);
    f.db.prepare("INSERT INTO stack_members (stack_id, media_id, position) VALUES (?, ?, ?)").run(stack, other, 1);
    f.db.prepare("UPDATE stacks SET cover_media_id = ? WHERE id = ?").run(other, stack);
    f.db.prepare("UPDATE deletion_marks SET original_cover_stack_id = ?, replacement_cover_media_id = ? WHERE media_id = ?").run(stack, other, f.image);
    await f.service.move(f.image);
    await f.service.restore(f.image);
    expect((f.db.prepare("SELECT cover_media_id AS id FROM stacks WHERE id = ?").get(stack) as { id: number }).id).toBe(f.image);
  } finally { f.close(); }
});
