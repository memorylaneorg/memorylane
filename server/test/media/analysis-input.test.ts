import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { renderAnalysisJpeg } from "../../src/media/analysis-input.js";
import type { AppPaths } from "../../src/config/paths.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-ai-input-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("renderAnalysisJpeg", () => {
  it("renders an oriented JPEG capped at 1600px, returns null for video/missing", async () => {
    const big = path.join(dir, "big.jpg");
    await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toFile(big);
    const paths = { previewsDir: dir, thumbnailsDir: dir } as AppPaths;
    const out = await renderAnalysisJpeg(paths, { id: 1, parent_folder_id: 1, absolute_path: big, media_type: "image" });
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1067);
    expect(await renderAnalysisJpeg(paths, { id: 2, parent_folder_id: 1, absolute_path: big, media_type: "video" })).toBeNull();
    expect(await renderAnalysisJpeg(paths, { id: 3, parent_folder_id: 1, absolute_path: path.join(dir, "nope.jpg"), media_type: "image" })).toBeNull();
  });
});
