import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "@memorylane/plugin-sdk";
import { PluginServiceSupervisor } from "../../src/plugin-platform/service-supervisor.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");

describe("AI Runtime plugin service", () => {
  it("starts quickly and provides authenticated vector storage", async () => {
    const pluginDir = path.join(repositoryRoot, "plugins", "optional", "com.memorylane.ai-runtime");
    const { buildPlatforms: _buildPlatforms, ...template } = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.template.json"), "utf8"));
    const manifest = PluginManifestSchema.parse({ ...template, platform: `${process.platform}-${process.arch}` });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-ai-runtime-"));
    const supervisor = new PluginServiceSupervisor({ coreVersion: "0.2.0", dataDirFor: () => dataDir, logDirFor: () => dataDir });
    try {
      const instance = await supervisor.start(manifest, pluginDir);
      const headers = { authorization: `Bearer ${instance.token}`, "content-type": "application/json" };
      expect((await fetch(`http://127.0.0.1:${instance.port}/v1/health`)).status).toBe(401);
      expect(await (await fetch(`http://127.0.0.1:${instance.port}/v1/health`, { headers })).json()).toMatchObject({ status: "ready", pluginId: manifest.id });
      await fetch(`http://127.0.0.1:${instance.port}/v1/vectors/upsert`, { method: "POST", headers, body: JSON.stringify({ space: "test", rows: [{ id: 1, vector: [1, 0] }] }) });
      const result = await (await fetch(`http://127.0.0.1:${instance.port}/v1/vectors/search`, { method: "POST", headers, body: JSON.stringify({ space: "test", vector: [1, 0], limit: 1 }) })).json() as { hits: Array<{ id: number }> };
      expect(result.hits[0].id).toBe(1);
    } finally {
      await supervisor.stopAll();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
});
