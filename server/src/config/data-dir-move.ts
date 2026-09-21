import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

import { DATA_LOCATION_FILE, platformDefaultDataDir, type AppPaths } from "./paths.js";
import { getDirectorySize } from "../util/dir-size.js";

export class DataDirMoveError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const COPIED_DIRS: (keyof AppPaths)[] = ["thumbnailsDir", "previewsDir", "vectorsDir", "facesDir", "transcodingDir"];

// Copies everything MemoryLane owns to `target` and records it as the data
// location for the next start. The live database is copied with SQLite's
// online backup (consistent under WAL); folders are plain recursive copies.
// The old location is deliberately left in place for the user to delete
// once the restarted app has been verified.
export async function moveDataDir(
  db: Database.Database,
  paths: AppPaths,
  target: string,
  logger: { info: (obj: object, msg: string) => void },
  opts: { pause: () => Promise<void>; resume: () => void },
): Promise<{ copiedBytes: number }> {
  if (paths.dataDirSource === "env") {
    throw new DataDirMoveError(400, "MEMORYLANE_DATA_DIR is set in the environment - change it there instead");
  }
  if (!path.isAbsolute(target)) throw new DataDirMoveError(400, "Enter an absolute path");
  const resolved = path.resolve(target);
  if (resolved === path.resolve(paths.dataDir)) throw new DataDirMoveError(400, "That is already the data directory");
  if (resolved.startsWith(path.resolve(paths.dataDir) + path.sep)) throw new DataDirMoveError(400, "The new location can't be inside the current one");
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    throw new DataDirMoveError(400, `Can't create ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const existing = fs.readdirSync(resolved).filter((n) => !n.startsWith("."));
  if (existing.length > 0) throw new DataDirMoveError(400, "Choose an empty folder (it will hold MemoryLane's cache and index)");
  try {
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch {
    throw new DataDirMoveError(400, `${resolved} is not writable`);
  }

  await opts.pause();
  try {
    logger.info({ from: paths.dataDir, to: resolved }, "Moving data directory");
    await db.backup(path.join(resolved, path.basename(paths.dbPath)));
    for (const key of COPIED_DIRS) {
      const src = paths[key] as string;
      if (fs.existsSync(src)) fs.cpSync(src, path.join(resolved, path.basename(src)), { recursive: true });
    }
    fs.mkdirSync(path.join(resolved, "logs"), { recursive: true });
    const pointerDir = platformDefaultDataDir();
    fs.mkdirSync(pointerDir, { recursive: true });
    fs.writeFileSync(path.join(pointerDir, DATA_LOCATION_FILE), resolved + "\n");
    const copiedBytes = await getDirectorySize(resolved);
    logger.info({ to: resolved, copiedBytes }, "Data directory copied - restart to use it");
    return { copiedBytes };
  } finally {
    opts.resume();
  }
}

export function pendingMoveTarget(paths: AppPaths): string | null {
  try {
    const target = fs.readFileSync(path.join(platformDefaultDataDir(), DATA_LOCATION_FILE), "utf8").trim();
    return target && path.resolve(target) !== path.resolve(paths.dataDir) ? target : null;
  } catch {
    return null;
  }
}
