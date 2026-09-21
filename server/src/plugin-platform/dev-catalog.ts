import fs from "node:fs";
import path from "node:path";
import { PLUGIN_PLATFORMS, PluginManifestSchema, type PluginManifest, type PluginPlatform } from "@memorylane/plugin-sdk";

export interface DevPluginEntry {
  manifest: PluginManifest;
  sourceDir: string;
}

// Dev-catalog mode: when nothing points the server at a real signed catalog
// (MEMORYLANE_PLUGIN_CATALOG_URL) or a signed local build
// (MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY), plugins load straight from their
// source under plugins/optional/ (and plugins/required/, if that ever comes
// back - no first-party plugin is required today) - no zip, no signing,
// no catalog.json. This deliberately does not go through PluginCatalogSchema
// (which requires sha256/signature/size fields with no escape hatch, by
// design - see the plan) or PluginInstaller; it's a parallel, much simpler
// path that PluginManager consumes directly. See scripts/build-plugin-repository.mjs's
// findPluginRoots for the production equivalent this mirrors (same directory
// layout, same manifest.template.json source of truth, no zipping here).
export function scanDevPlugins(pluginsRoot: string, platform: PluginPlatform): Map<string, DevPluginEntry> {
  const found = new Map<string, DevPluginEntry>();
  for (const group of ["required", "optional"]) {
    const groupDir = path.join(pluginsRoot, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = path.join(groupDir, entry.name);
      const manifestPath = path.join(sourceDir, "manifest.template.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        // manifest.template.json omits `platform` (and optionally declares
        // `buildPlatforms`) since one template covers every target platform -
        // same shape scripts/build-plugin-repository.mjs reads, just resolved
        // against the platform this dev server is actually running on
        // instead of every platform a release build would produce.
        const { buildPlatforms = [...PLUGIN_PLATFORMS] as string[], ...template } = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { buildPlatforms?: string[] };
        const allowedPlatforms = buildPlatforms.includes("host") ? [platform] : buildPlatforms;
        if (!allowedPlatforms.includes(platform)) continue;
        const manifest = PluginManifestSchema.parse({ ...template, platform });
        found.set(manifest.id, { manifest, sourceDir });
      } catch {
        // A plugin mid-edit with an invalid manifest just doesn't show up -
        // no reason to crash the whole dev server over it.
      }
    }
  }
  return found;
}
