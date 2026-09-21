import type { PluginManifest, PluginCatalogRelease } from "./schemas.js";
import type { PluginPlatform } from "./constants.js";
import { PLUGIN_API_VERSION } from "./constants.js";
import { coreVersionSatisfies } from "./version.js";

export interface PluginCompatibilityTarget {
  coreVersion: string;
  pluginApi?: number;
  platform: PluginPlatform;
}

export type PluginCompatibility =
  | { compatible: true }
  | { compatible: false; reason: "platform" | "plugin-api" | "core-version" };

export function checkPluginCompatibility(
  manifest: PluginManifest,
  target: PluginCompatibilityTarget,
): PluginCompatibility {
  if (manifest.platform !== target.platform) return { compatible: false, reason: "platform" };
  if (manifest.pluginApi !== (target.pluginApi ?? PLUGIN_API_VERSION)) return { compatible: false, reason: "plugin-api" };
  if (!coreVersionSatisfies(target.coreVersion, manifest.requiresCore)) return { compatible: false, reason: "core-version" };
  return { compatible: true };
}

export function compatibleCatalogReleases(
  releases: readonly PluginCatalogRelease[],
  target: PluginCompatibilityTarget,
): PluginCatalogRelease[] {
  return releases.filter((release) => checkPluginCompatibility(release.manifest, target).compatible);
}
