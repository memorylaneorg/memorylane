import { z } from "zod";
import { PLUGIN_API_VERSION, PLUGIN_CATALOG_FORMAT_VERSION, PLUGIN_PLATFORMS } from "./constants.js";
import { isSafePluginRelativePath } from "./paths.js";
import { isValidCoreRange, isValidPluginVersion } from "./version.js";

const pluginId = z.string().regex(/^com\.memorylane(?:\.[a-z][a-z0-9-]*)+$/, "Expected a com.memorylane.* plugin ID");
const version = z.string().refine(isValidPluginVersion, "Expected a semantic version such as 1.2.3");
const packagePath = z.string().refine(isSafePluginRelativePath, "Expected a normalized relative package path");
const routePath = z.string().regex(/^\/[A-Za-z0-9/_-]*$/, "Expected an absolute URL path without a query or fragment");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");
const signature = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "Expected a base64 signature");

export const PluginCapabilitySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(100);

const ModuleEntrySchema = z.object({
  kind: z.literal("module"),
  script: packagePath,
});

const ServiceEntrySchema = z.object({
  kind: z.literal("service"),
  executable: packagePath,
  args: z.array(z.string().max(1_000)).max(100).default([]),
  // Dev-catalog mode only: a fixed port the plugin author's own
  // independently-run process listens on, so core can health-check it
  // instead of spawning/owning it. Ignored outside dev-catalog mode, where
  // the supervisor always assigns a random loopback port itself.
  devPort: z.number().int().min(1024).max(65535).optional(),
});

const CommandEntrySchema = z.object({
  kind: z.literal("command"),
  commands: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), packagePath).refine(
    (commands) => Object.keys(commands).length > 0,
    "At least one command is required",
  ),
});

export const PluginEntrySchema = z.discriminatedUnion("kind", [ModuleEntrySchema, ServiceEntrySchema, CommandEntrySchema]);

export const PluginManifestSchema = z.object({
  id: pluginId,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  version,
  pluginApi: z.literal(PLUGIN_API_VERSION),
  requiresCore: z.string().refine(isValidCoreRange, "Expected a supported core version range"),
  platform: z.enum(PLUGIN_PLATFORMS),
  required: z.boolean(),
  // Pure infrastructure with no capability a user benefits from directly
  // (e.g. a shared inference runtime other plugins call into) - never shown
  // in any install/manage list, regardless of the current dependency graph.
  // This is a property of the plugin itself, not something derived from
  // who happens to depend on it today - a plugin that's a real, independently
  // useful feature could become a dependency of something else in the future
  // without becoming any less worth showing to users.
  infra: z.boolean().default(false),
  entry: PluginEntrySchema,
  capabilities: z.array(PluginCapabilitySchema).max(100).refine(
    (items) => new Set(items).size === items.length,
    "Capabilities must be unique",
  ),
  dependencies: z.array(z.object({
    id: pluginId,
    version: z.string().refine(isValidCoreRange, "Expected a supported plugin version range"),
  })).max(50).default([]),
  health: z.object({
    path: routePath,
    timeoutSeconds: z.number().int().min(1).max(300),
  }).optional(),
  restart: z.object({
    policy: z.enum(["never", "on-failure", "always"]),
    maxAttempts: z.number().int().min(0).max(100),
  }).optional(),
  licenseFiles: z.array(packagePath).min(1).max(100),
}).strict().superRefine((manifest, context) => {
  if (manifest.entry.kind === "service" && !manifest.health) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["health"], message: "Service plugins require a health endpoint" });
  }
  if (manifest.entry.kind !== "service" && (manifest.health || manifest.restart)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["entry"], message: "Health and restart settings apply only to service plugins" });
  }
  if (manifest.dependencies.some((dependency) => dependency.id === manifest.id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies"], message: "A plugin cannot depend on itself" });
  }
});

export const PluginArtifactSchema = z.object({
  url: z.string().url().or(packagePath),
  size: z.number().int().nonnegative(),
  installedSize: z.number().int().nonnegative(),
  sha256,
  signature,
}).strict();

export const PluginCatalogReleaseSchema = z.object({
  manifest: PluginManifestSchema,
  artifact: PluginArtifactSchema,
  releaseNotes: z.string().max(20_000).default(""),
  mandatory: z.boolean().default(false),
}).strict();

export const PluginCatalogSchema = z.object({
  formatVersion: z.literal(PLUGIN_CATALOG_FORMAT_VERSION),
  channel: z.enum(["stable", "beta"]),
  generatedAt: z.string().datetime({ offset: true }),
  revoked: z.array(z.object({ id: pluginId, version, reason: z.string().min(1).max(500) }).strict()).max(10_000).default([]),
  releases: z.array(PluginCatalogReleaseSchema).max(10_000),
}).strict().superRefine((catalog, context) => {
  const seen = new Set<string>();
  catalog.releases.forEach((release, index) => {
    const key = `${release.manifest.id}\0${release.manifest.version}\0${release.manifest.platform}`;
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["releases", index], message: "Duplicate plugin version and platform" });
    }
    seen.add(key);
  });
});

export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;
export type PluginEntry = z.infer<typeof PluginEntrySchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginCatalogRelease = z.infer<typeof PluginCatalogReleaseSchema>;
export type PluginCatalog = z.infer<typeof PluginCatalogSchema>;
