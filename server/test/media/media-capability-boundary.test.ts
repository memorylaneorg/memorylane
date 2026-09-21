import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { processMediaItem } from "../../src/media/media-processor.js";
import type { AppPaths } from "../../src/config/paths.js";
import type { MediaToolCapabilities } from "../../src/capabilities/media-tools.js";

const logger = { info() {}, warn() {}, error() {} } as unknown as import("pino").Logger;
const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("media capability boundary", () => {
  it("preserves video metadata and poster behavior through an injected provider", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/library/a");
    const mediaId = seedMedia(db, folder, root, { filename: "clip.mov", media_type: "video", thumbnail_status: "pending" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-capability-")); cleanup.push(dir);
    const paths = { thumbnailsDir: path.join(dir, "thumbs"), previewsDir: path.join(dir, "previews") } as AppPaths;
    fs.mkdirSync(paths.thumbnailsDir, { recursive: true }); fs.mkdirSync(paths.previewsDir, { recursive: true });
    const poster = await sharp({ create: { width: 32, height: 18, channels: 3, background: "navy" } }).jpeg().toBuffer();
    const calls: string[] = [];
    const tools: MediaToolCapabilities = {
      metadata: { available: () => false, read: async () => null, version: () => "fixture" },
      rawPreview: { extract: async () => null },
      video: {
        available: () => true,
        probe: async () => { calls.push("probe"); return { width: 1920, height: 1080, durationSeconds: 12.5, codec: "h264", audioCodec: "aac" }; },
        poster: async () => { calls.push("poster"); return poster; },
        transcode: async () => false,
      },
    };
    await processMediaItem(db, paths, logger, { id: mediaId, parent_folder_id: folder, absolute_path: "/core/resolved/source", media_type: "video" }, tools);
    expect(calls).toEqual(["probe", "poster"]);
    expect(db.prepare("SELECT width, height, duration_seconds, codec, audio_codec, thumbnail_status FROM media WHERE id=?").get(mediaId))
      .toEqual({ width: 1920, height: 1080, duration_seconds: 12.5, codec: "h264", audio_codec: "aac", thumbnail_status: "done" });
  });
});
