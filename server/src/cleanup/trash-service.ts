import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { computeFingerprint } from "../scanner/fingerprint.js";

interface FileMove { original: string; trashed: string; mediaId: number | null }
interface TrashEntry { status: "moving" | "trashed"; files_json: string }
interface SourceRow {
  id: number; scan_root_id: number; absolute_path: string; fingerprint: string;
  raw_pair_id: number | null; live_photo_video_id: number | null;
  root_path: string; root_kind: string; root_enabled: number; source_kind: string | null;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function insideOrSame(root: string, candidate: string): boolean {
  return root === candidate || inside(root, candidate);
}

export class TrashService {
  constructor(private db: Database.Database, private isScanRunning: () => boolean) {}

  private source(id: number): SourceRow {
    const row = this.db.prepare(`SELECT m.*, r.path AS root_path, r.kind AS root_kind, r.enabled AS root_enabled
      FROM media m JOIN scan_roots r ON r.id = m.scan_root_id
      JOIN deletion_marks dm ON dm.media_id = m.id WHERE m.id = ?`).get(id) as SourceRow | undefined;
    if (!row || row.root_kind !== "folder" || !row.root_enabled || row.source_kind === "apple-photos") {
      throw new Error("Only marked files in enabled folder roots can be moved to trash");
    }
    return row;
  }

  private movesFor(row: SourceRow): FileMove[] {
    const rootReal = fs.realpathSync(row.root_path);
    const ids = [row.id, row.raw_pair_id, row.live_photo_video_id].filter((id): id is number => id !== null);
    const moves: FileMove[] = [];
    for (const id of ids) {
      const item = this.db.prepare("SELECT id, absolute_path, fingerprint FROM media WHERE id = ? AND scan_root_id = ?")
        .get(id, row.scan_root_id) as { id: number; absolute_path: string; fingerprint: string } | undefined;
      if (!item) throw new Error("A paired file is no longer indexed in this root");
      const source = path.resolve(item.absolute_path);
      if (source.split(path.sep).some((part) => part.toLowerCase().endsWith(".photoslibrary"))) {
        throw new Error("Apple Photos library packages cannot be moved to trash");
      }
      if (!inside(rootReal, fs.realpathSync(source))) throw new Error("File lies outside its scan root");
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source is not a regular file");
      if (computeFingerprint(stat.size, stat.mtimeMs) !== item.fingerprint) throw new Error("Source file changed since the last scan");
      const trashDir = path.join(path.dirname(source), "_MemoryLane-Trash");
      if (fs.existsSync(trashDir) && (!fs.lstatSync(trashDir).isDirectory() || fs.lstatSync(trashDir).isSymbolicLink())) throw new Error("Trash path is unsafe");
      const trashed = path.join(trashDir, String(row.id), path.basename(source));
      if (fs.existsSync(path.dirname(trashed))) throw new Error("Trash group already exists");
      if (fs.existsSync(trashed)) throw new Error("Trash destination already exists");
      moves.push({ original: source, trashed, mediaId: id });
      const stem = source.slice(0, source.lastIndexOf("."));
      for (const suffix of [".xmp", ".XMP"]) {
        const sidecar = stem + suffix;
        if (!fs.existsSync(sidecar)) continue;
        const sidecarStat = fs.lstatSync(sidecar);
        if (moves.some((move) => {
          const prior = fs.lstatSync(move.original);
          return prior.dev === sidecarStat.dev && prior.ino === sidecarStat.ino;
        })) continue;
        if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink() || !inside(rootReal, fs.realpathSync(sidecar))) throw new Error("Sidecar path is unsafe");
        const sidecarTrash = path.join(trashDir, String(row.id), path.basename(sidecar));
        if (fs.existsSync(sidecarTrash)) throw new Error("Sidecar trash destination already exists");
        moves.push({ original: sidecar, trashed: sidecarTrash, mediaId: null });
      }
    }
    return moves;
  }

  async move(id: number): Promise<void> {
    if (this.isScanRunning()) throw new Error("Wait for the current scan to finish");
    const row = this.source(id);
    if (this.db.prepare("SELECT 1 FROM trash_entries WHERE media_id = ?").get(id)) throw new Error("Item is already in trash");
    const moves = this.movesFor(row);
    this.db.prepare("INSERT INTO trash_entries (media_id, status, files_json) VALUES (?, 'moving', ?)").run(id, JSON.stringify(moves));
    const moved: FileMove[] = [];
    try {
      for (const file of moves) {
        const trashDir = path.dirname(file.trashed);
        fs.mkdirSync(trashDir, { recursive: true });
        this.db.prepare("INSERT OR IGNORE INTO ignored_paths (path) VALUES (?)").run(path.dirname(trashDir));
        fs.renameSync(file.original, file.trashed);
        moved.push(file);
      }
      this.db.prepare("UPDATE trash_entries SET status = 'trashed' WHERE media_id = ?").run(id);
    } catch (error) {
      let rolledBack = true;
      for (const file of moved.reverse()) {
        try { fs.renameSync(file.trashed, file.original); }
        catch { rolledBack = false; }
      }
      if (rolledBack) this.db.prepare("DELETE FROM trash_entries WHERE media_id = ?").run(id);
      throw error;
    }
  }

  private entry(id: number): { status: TrashEntry["status"]; files: FileMove[] } {
    const row = this.db.prepare("SELECT status, files_json FROM trash_entries WHERE media_id = ?").get(id) as TrashEntry | undefined;
    if (!row) throw new Error("Item is not in trash");
    const files = JSON.parse(row.files_json) as FileMove[];
    if (!Array.isArray(files) || files.length === 0) throw new Error("Invalid trash manifest");
    const root = this.db.prepare(`SELECT r.path FROM media m JOIN scan_roots r ON r.id = m.scan_root_id WHERE m.id = ? AND r.kind = 'folder'`)
      .get(id) as { path: string } | undefined;
    if (!root) throw new Error("Trash source is unavailable");
    const rootReal = fs.realpathSync(root.path);
    const sourcePaths = new Set(files.filter((file) => file.mediaId !== null).map((file) => file.original));
    for (const file of files) {
      if (typeof file.original !== "string" || typeof file.trashed !== "string" || !path.isAbsolute(file.original)) throw new Error("Invalid trash manifest");
      const parentReal = fs.realpathSync(path.dirname(file.original));
      if (!insideOrSame(rootReal, parentReal)) throw new Error("Trash manifest leaves scan root");
      const expected = path.join(path.dirname(file.original), "_MemoryLane-Trash", String(id), path.basename(file.original));
      if (file.trashed !== expected) throw new Error("Trash path does not match manifest");
      if (file.mediaId !== null) {
        const indexed = this.db.prepare("SELECT absolute_path FROM media WHERE id = ?").get(file.mediaId) as { absolute_path: string } | undefined;
        if (!indexed || indexed.absolute_path !== file.original) throw new Error("Trash manifest media path mismatch");
      } else {
        const stem = file.original.replace(/\.xmp$/i, "");
        if (!/\.xmp$/i.test(file.original) || ![...sourcePaths].some((source) => source.slice(0, source.lastIndexOf(".")) === stem)) throw new Error("Trash manifest sidecar mismatch");
      }
      const groupDir = path.dirname(file.trashed);
      if (fs.existsSync(groupDir) && (!fs.lstatSync(groupDir).isDirectory() || fs.lstatSync(groupDir).isSymbolicLink())) throw new Error("Trash path is unsafe");
      if (!fs.existsSync(groupDir) && row.status !== "moving") throw new Error("Trash path is unsafe");
      if (fs.existsSync(file.trashed) && (!fs.lstatSync(file.trashed).isFile() || fs.lstatSync(file.trashed).isSymbolicLink())) throw new Error("Trash file is unsafe");
    }
    return { status: row.status, files };
  }

  async restore(id: number): Promise<void> {
    if (this.isScanRunning()) throw new Error("Wait for the current scan to finish");
    const { files } = this.entry(id);
    // Check every destination before the first move; a collision cannot leave a partial restore.
    for (const file of files) {
      if (fs.existsSync(file.original) && fs.existsSync(file.trashed)) throw new Error("Original path is occupied");
      if (!fs.existsSync(file.original) && !fs.existsSync(file.trashed)) throw new Error("A trash file is missing");
    }
    for (const file of files) if (fs.existsSync(file.trashed)) fs.renameSync(file.trashed, file.original);
    this.db.transaction(() => {
      const ids = [...new Set(files.flatMap((file) => file.mediaId === null ? [] : [file.mediaId]))];
      const update = this.db.prepare("UPDATE media SET status = 'active' WHERE id = ?");
      for (const mediaId of ids) update.run(mediaId);
      this.db.prepare("DELETE FROM trash_entries WHERE media_id = ?").run(id);
      const prior = this.db.prepare("SELECT original_cover_stack_id AS stackId, replacement_cover_media_id AS replacementId FROM deletion_marks WHERE media_id = ?")
        .get(id) as { stackId: number | null; replacementId: number | null } | undefined;
      this.db.prepare("DELETE FROM deletion_marks WHERE media_id = ?").run(id);
      if (prior?.stackId != null && prior.replacementId != null) {
        this.db.prepare(`UPDATE stacks SET cover_media_id = ? WHERE id = ? AND cover_media_id = ?
          AND EXISTS (SELECT 1 FROM stack_members WHERE stack_id = ? AND media_id = ?)`)
          .run(id, prior.stackId, prior.replacementId, prior.stackId, id);
      }
    })();
    for (const group of new Set(files.map((file) => path.dirname(file.trashed)))) {
      if (fs.existsSync(group) && fs.readdirSync(group).length === 0) fs.rmdirSync(group);
    }
  }

  async empty(id: number): Promise<void> {
    if (this.isScanRunning()) throw new Error("Wait for the current scan to finish");
    const { status, files } = this.entry(id);
    if (status !== "trashed") throw new Error("Trash move has not completed");
    for (const file of files) if (fs.existsSync(file.original)) throw new Error("Original path is occupied");
    for (const file of files) if (fs.existsSync(file.trashed)) fs.unlinkSync(file.trashed);
    this.db.transaction(() => {
      const ids = [...new Set(files.flatMap((file) => file.mediaId === null ? [] : [file.mediaId]))];
      const remove = this.db.prepare("DELETE FROM media WHERE id = ?");
      for (const mediaId of ids) remove.run(mediaId);
    })();
    for (const group of new Set(files.map((file) => path.dirname(file.trashed)))) {
      if (fs.existsSync(group) && fs.readdirSync(group).length === 0) fs.rmdirSync(group);
    }
  }
}
