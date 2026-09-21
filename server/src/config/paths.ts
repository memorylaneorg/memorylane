import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// The OS-standard location. Also where the "data lives elsewhere" pointer
// file is kept, so it can be found without any configuration.
export function platformDefaultDataDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "MemoryLane");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "MemoryLane");
  }
  // linux and other posix
  const xdgDataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdgDataHome, "MemoryLane");
}

// Repository root - server/src/config (dev, tsx) or server/dist/config
// (built) is always three levels below it (config -> src|dist -> server -> root).
export const repoRootDir = path.resolve(import.meta.dirname, "..", "..", "..");

// Resolves a path-shaped env var (MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY,
// MEMORYLANE_PLUGIN_PUBLIC_KEY) against the repository root rather than
// process.cwd() - `npm run dev`/`npm start` run with cwd inside server/, so a
// relative value from .env or the shell would otherwise resolve against the
// wrong directory.
export function resolveRepoPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRootDir, value);
}

export const DATA_LOCATION_FILE = "data-location.txt";

export type DataDirSource = "env" | "pointer" | "default";

// Resolves MemoryLane's application-data directory (database, thumbnails, logs).
// Precedence: MEMORYLANE_DATA_DIR env var > pointer file written by
// Settings › Storage › Move (lives in the platform default dir) > default.
// This directory is entirely disposable/rebuildable from the source media.
export function resolveAppDataDir(): { dataDir: string; source: DataDirSource } {
  const override = process.env.MEMORYLANE_DATA_DIR;
  if (override) return { dataDir: path.resolve(override), source: "env" };
  const defaultDir = platformDefaultDataDir();
  const pointer = path.join(defaultDir, DATA_LOCATION_FILE);
  try {
    const target = fs.readFileSync(pointer, "utf8").trim();
    if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) return { dataDir: target, source: "pointer" };
  } catch {
    // no pointer - use the default
  }
  return { dataDir: defaultDir, source: "default" };
}

export interface AppPaths {
  dataDir: string;
  dataDirSource: DataDirSource;
  dbPath: string;
  thumbnailsDir: string;
  previewsDir: string;
  // Working space for in-progress video transcodes - see media/transcode-worker.ts.
  // Fully disposable: a finished output only ever becomes durable once
  // Archive copies it into the actual library folder.
  transcodingDir: string;
  // Rebuildable vector-index cache over media_embeddings, never the source of truth.
  vectorsDir: string;
  // Face crop cache (People pages) - regenerated on demand.
  facesDir: string;
  logsDir: string;
  clientDistDir: string;
}

export function resolveAppPaths(): AppPaths {
  const { dataDir, source } = resolveAppDataDir();
  const paths: AppPaths = {
    dataDir,
    dataDirSource: source,
    dbPath: path.join(dataDir, "memorylane.sqlite"),
    thumbnailsDir: path.join(dataDir, "thumbnails"),
    // Larger RAW-only previews live separately from grid thumbnails - see
    // media/thumbnail-generator.ts PREVIEW_LONG_EDGE.
    previewsDir: path.join(dataDir, "previews"),
    transcodingDir: path.join(dataDir, "transcoding"),
    vectorsDir: path.join(dataDir, "vectors"),
    facesDir: path.join(dataDir, "faces"),
    logsDir: path.join(dataDir, "logs"),
    // import.meta.dirname is server/src/config (dev, tsx) or server/dist/config
    // (built) - either way, two levels up is the server package root, where
    // the Vite client build outputs directly (see client/vite.config.ts).
    clientDistDir: path.resolve(import.meta.dirname, "..", "..", "public"),
  };
  for (const dir of [paths.dataDir, paths.thumbnailsDir, paths.previewsDir, paths.transcodingDir, paths.vectorsDir, paths.facesDir, paths.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

// Shards a numeric media id into a nested path so no single directory
// accumulates hundreds of thousands of files (NTFS/ext4 large-directory slowdown).
function shardedMediaPath(baseDir: string, mediaId: number): string {
  const idStr = String(mediaId).padStart(6, "0");
  const shard1 = idStr.slice(-6, -4);
  const shard2 = idStr.slice(-4, -2);
  return path.join(baseDir, shard1, shard2, `${mediaId}.jpg`);
}

export function thumbnailPathForMediaId(thumbnailsDir: string, mediaId: number): string {
  return shardedMediaPath(thumbnailsDir, mediaId);
}

export function previewPathForMediaId(previewsDir: string, mediaId: number): string {
  return shardedMediaPath(previewsDir, mediaId);
}

// No sharding needed here - transcode jobs are rare (a handful of old-camera
// videos at a time), nothing like the volume thumbnails/previews see.
export function transcodingPathForMediaId(transcodingDir: string, mediaId: number): string {
  return path.join(transcodingDir, `${mediaId}.mp4`);
}

// Poster-frame preview for a transcode's local-cache output - lets the
// candidates panel show a static thumbnail per row instead of eagerly
// mounting a real <video> element for every row at once.
export function transcodingThumbnailPathForMediaId(transcodingDir: string, mediaId: number): string {
  return path.join(transcodingDir, `${mediaId}.jpg`);
}

export function faceCropPath(facesDir: string, faceId: number): string {
  return shardedMediaPath(facesDir, faceId);
}
