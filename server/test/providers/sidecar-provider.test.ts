import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { startFakeSidecar, type FakeSidecar } from "../helpers/fake-sidecar.js";
import { SidecarProvider } from "../../src/providers/sidecar-provider.js";
import { ProviderUnavailableError } from "../../src/providers/types.js";
import { createProvider } from "../../src/providers/index.js";

let fake: FakeSidecar;
beforeAll(async () => {
  fake = await startFakeSidecar();
});
afterAll(() => fake.close());

describe("SidecarProvider", () => {
  it("reports health and caches it", async () => {
    const p = new SidecarProvider(fake.url, { expectedModel: fake.model, healthTtlMs: 60_000 });
    const info = await p.health();
    expect(info).toMatchObject({ reachable: true, model: fake.model, dim: 8, device: "fake" });
    fake.setFailing(500);
    expect((await p.health()).reachable).toBe(true); // cached
    expect((await p.health(true)).reachable).toBe(false);
    fake.setFailing(null);
  });

  it("flags a model mismatch as unreachable", async () => {
    const p = new SidecarProvider(fake.url, { expectedModel: "other-model@9" });
    const info = await p.health(true);
    expect(info.reachable).toBe(false);
    expect(info.lastError).toContain("does not match");
  });

  it("embeds images and text in order", async () => {
    const p = new SidecarProvider(fake.url, { expectedModel: fake.model });
    const a = Buffer.from("aaaa"), b = Buffer.from("bbbbbbbb");
    const res = await p.embedImages([a, b]);
    expect(res.model).toBe(fake.model);
    expect(res.vectors).toHaveLength(2);
    expect(res.vectors[0]).toBeInstanceOf(Float32Array);
    expect(res.vectors[0].length).toBe(8);
    const again = await p.embedImages([a]);
    expect(Array.from(again.vectors[0])).toEqual(Array.from(res.vectors[0])); // deterministic
    const t = await p.embedText(["red bird", "blue sky"]);
    expect(t.vectors).toHaveLength(2);
  });

  it("classifies failures: outages back off, bad requests fail", async () => {
    const p = new SidecarProvider(fake.url, { expectedModel: fake.model });
    fake.setFailing(503);
    await expect(p.embedImages([Buffer.from("x")])).rejects.toBeInstanceOf(ProviderUnavailableError);
    fake.setFailing(null);
    await expect(p.embedText([])).rejects.toThrow(/rejected request \(422\)/);
    const down = new SidecarProvider("http://127.0.0.1:1", { expectedModel: fake.model, requestTimeoutMs: 2_000 });
    await expect(down.embedImages([Buffer.from("x")])).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect((await down.health(true)).reachable).toBe(false);
  });

  it("createProvider honours env", () => {
    expect(createProvider({ MEMORYLANE_AI_PROVIDER: "none" })).toBeNull();
    const p = createProvider({ MEMORYLANE_AI_URL: "http://x:1", MEMORYLANE_AI_MODEL: "m@2" })!;
    expect(p.expectedModel).toBe("m@2");
    expect(p.getInfo().url).toBe("http://x:1");
    expect(() => createProvider({ MEMORYLANE_AI_PROVIDER: "cloud" })).toThrow();
  });
});

describe("SidecarProvider faces", () => {
  it("detects faces and clusters through the sidecar", async () => {
    const p = new SidecarProvider(fake.url, { expectedModel: fake.model });
    expect((await p.health(true)).faceModel).toBe("yunet-sface@1");
    expect(p.facesAvailable("yunet-sface")).toBe(true);
    expect(p.facesAvailable("buffalo_l")).toBe(true);
    const twoFaces = Buffer.from([2, 10, 20, 30]); // first byte % 3 = 2 faces
    const noFaces = Buffer.from([3, 1, 1, 1]);
    const res = await p.detectFaces([twoFaces, noFaces], "yunet-sface");
    expect(res.model).toBe("yunet-sface@1");
    expect((await p.detectFaces([twoFaces], "buffalo_l")).model).toBe("buffalo_l@1");
    expect(res.images[0]).toHaveLength(2);
    expect(res.images[1]).toHaveLength(0);
    expect(res.images[0][0].embedding).toBeInstanceOf(Float32Array);
    expect(res.images[0][0].bbox).toHaveLength(4);
    const v = res.images[0].map((f) => f.embedding);
    const labels = await p.cluster([v[0], v[0], v[1]], { threshold: 0.99, minClusterSize: 2 });
    expect(labels).toEqual([0, 0, -1]);
    await expect(p.detectFaces([twoFaces], "other-model")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
