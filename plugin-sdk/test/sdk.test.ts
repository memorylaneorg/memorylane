import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PluginCatalogSchema,
  PluginManifestSchema,
  checkPluginCompatibility,
  isSafePluginRelativePath,
  sha256Hex,
  verifyEd25519Signature,
  verifySha256,
  CAPABILITY_CONTRACTS,
  MetadataRequestSchema,
  type PluginManifest,
} from "../src/index.js";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "com.memorylane.video-tools",
    name: "Video Tools",
    description: "Video inspection and modernization tools.",
    version: "1.0.0",
    pluginApi: 1,
    requiresCore: ">=0.2.0 <1.0.0",
    platform: "win32-x64",
    required: true,
    entry: {
      kind: "command",
      commands: {
        ffmpeg: "bin/ffmpeg.exe",
        ffprobe: "bin/ffprobe.exe",
      },
    },
    capabilities: ["video.probe", "video.transcode"],
    dependencies: [],
    licenseFiles: ["licenses/ffmpeg.txt"],
    ...overrides,
  };
}

function release(pluginManifest: PluginManifest) {
  return {
    manifest: pluginManifest,
    artifact: {
      url: "artifacts/com.memorylane.video-tools/1.0.0/win32-x64.mlplugin",
      size: 100,
      installedSize: 200,
      sha256: "a".repeat(64),
      signature: Buffer.alloc(64).toString("base64"),
    },
    releaseNotes: "Initial release",
    mandatory: false,
  };
}

describe("plugin manifest", () => {
  it("accepts a valid command plugin", () => {
    expect(PluginManifestSchema.parse(manifest()).entry.kind).toBe("command");
  });

  it("rejects malformed and unknown fields", () => {
    expect(PluginManifestSchema.safeParse({ ...manifest(), id: "video-tools" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest(), surprise: true }).success).toBe(false);
  });

  it("requires service health configuration", () => {
    const input = manifest({ entry: { kind: "service", executable: "bin/service.exe", args: [] } });
    expect(PluginManifestSchema.safeParse(input).success).toBe(false);
  });

  it.each(["../outside.exe", "bin/../outside.exe", "/absolute.exe", "C:/absolute.exe", "bin\\tool.exe"])(
    "rejects unsafe package path %s",
    (unsafePath) => {
      expect(isSafePluginRelativePath(unsafePath)).toBe(false);
      expect(PluginManifestSchema.safeParse(manifest({
        entry: { kind: "command", commands: { tool: unsafePath } },
      })).success).toBe(false);
    },
  );
});

describe("catalog", () => {
  it("rejects duplicate plugin/version/platform releases", () => {
    const item = release(manifest());
    const result = PluginCatalogSchema.safeParse({
      formatVersion: 1,
      channel: "stable",
      generatedAt: "2026-09-17T12:00:00.000Z",
      releases: [item, item],
    });
    expect(result.success).toBe(false);
  });
});

describe("compatibility", () => {
  it("accepts a matching platform, API and core version", () => {
    expect(checkPluginCompatibility(manifest(), {
      coreVersion: "0.5.0",
      platform: "win32-x64",
    })).toEqual({ compatible: true });
  });

  it("explains unsupported platforms and core versions", () => {
    expect(checkPluginCompatibility(manifest(), {
      coreVersion: "0.5.0",
      platform: "darwin-arm64",
    })).toEqual({ compatible: false, reason: "platform" });
    expect(checkPluginCompatibility(manifest(), {
      coreVersion: "1.0.0",
      platform: "win32-x64",
    })).toEqual({ compatible: false, reason: "core-version" });
  });
});

describe("integrity", () => {
  it("verifies SHA-256 and rejects changed bytes", () => {
    const payload = Buffer.from("plugin artifact");
    const digest = sha256Hex(payload);
    expect(verifySha256(payload, digest)).toBe(true);
    expect(verifySha256(Buffer.from("changed artifact"), digest)).toBe(false);
  });

  it("verifies Ed25519 signatures and rejects changed payloads", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = Buffer.from('{"formatVersion":1}');
    const signature = sign(null, payload, privateKey).toString("base64");
    expect(verifyEd25519Signature(payload, signature, publicKey)).toBe(true);
    expect(verifyEd25519Signature(Buffer.from("changed"), signature, publicKey)).toBe(false);
  });
});

describe("capability contracts", () => {
  it("publishes a versioned contract for every capability", () => {
    expect(Object.keys(CAPABILITY_CONTRACTS)).toHaveLength(10);
    expect(MetadataRequestSchema.parse({ apiVersion: 1, mediaId: 42, sourceToken: "a".repeat(32) })).toEqual({ apiVersion: 1, mediaId: 42, sourceToken: "a".repeat(32) });
  });

  it("rejects unversioned requests and oversized batches", () => {
    expect(MetadataRequestSchema.safeParse({ mediaId: 42, sourceToken: "a".repeat(32) }).success).toBe(false);
    const contract = CAPABILITY_CONTRACTS["ai.image-embedding"].request;
    expect(contract.safeParse({ apiVersion: 1, model: "clip", items: Array.from({ length: 65 }, (_, i) => ({ mediaId: i + 1, imageToken: "x".repeat(32) })) }).success).toBe(false);
  });
});
