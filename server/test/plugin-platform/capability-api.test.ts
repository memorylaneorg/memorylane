import { describe, expect, it } from "vitest";
import type { CapabilityId } from "@memorylane/plugin-sdk";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { CapabilityRegistry } from "../../src/capabilities/registry.js";
import { CapabilityUnavailableError } from "../../src/capabilities/errors.js";
import { CorePluginWriteApi } from "../../src/capabilities/core-write-api.js";
import { SourceAuthority } from "../../src/capabilities/source-authority.js";

async function setup() {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const folder = seedFolder(db, root, "/library/a");
  const mediaId = seedMedia(db, folder, root);
  return { db, mediaId };
}

describe("CapabilityRegistry", () => {
  it("registers one owner and reports stopped capabilities as unavailable", async () => {
    const registry = new CapabilityRegistry();
    const unregister = registry.register("video.probe", { pluginId: "com.memorylane.video", invoke: async (request) => request });
    await expect(registry.invoke("video.probe", { value: 1 })).resolves.toEqual({ value: 1 });
    expect(() => registry.register("video.probe", { pluginId: "other", invoke: async () => null })).toThrow(/already registered/);
    unregister();
    await expect(registry.invoke("video.probe", {})).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });
});

describe("CorePluginWriteApi", () => {
  it("validates capability ownership, media IDs, dimensions and writes existing core tables", async () => {
    const { db, mediaId } = await setup();
    const owned = new Map<string, ReadonlySet<CapabilityId>>([["com.memorylane.ai", new Set(["ai.image-embedding"])]]);
    const api = new CorePluginWriteApi(db, owned);
    api.writeEmbeddings("com.memorylane.ai", { model: "clip@1", dimensions: 3, items: [{ mediaId, vector: [1, 2, 3] }] });
    expect(db.prepare("SELECT dim FROM media_embeddings WHERE media_id=?").get(mediaId)).toEqual({ dim: 3 });
    expect(() => api.writeEmbeddings("com.memorylane.other", { model: "clip@1", dimensions: 3, items: [{ mediaId, vector: [1, 2, 3] }] })).toThrow(/does not own/);
    expect(() => api.writeEmbeddings("com.memorylane.ai", { model: "clip@1", dimensions: 2, items: [{ mediaId, vector: [1, 2, 3] }] })).toThrow(/dimension/);
    expect(() => api.writeEmbeddings("com.memorylane.ai", { model: "clip@1", dimensions: 3, items: [{ mediaId: 999999, vector: [1, 2, 3] }] })).toThrow(/missing or inactive/);
  });
});

describe("SourceAuthority", () => {
  it("binds a single-use source token to its plugin and media item", async () => {
    const { db, mediaId } = await setup();
    const authority = new SourceAuthority(db);
    const token = authority.issue("com.memorylane.metadata", mediaId);
    expect(() => authority.resolve("wrong", token, mediaId)).toThrow(/Invalid or expired/);
    const valid = authority.issue("com.memorylane.metadata", mediaId);
    expect(authority.resolve("com.memorylane.metadata", valid, mediaId)).toContain("library");
    expect(() => authority.resolve("com.memorylane.metadata", valid, mediaId)).toThrow(/Invalid or expired/);
  });
});
