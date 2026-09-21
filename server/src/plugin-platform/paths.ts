import fs from "node:fs";
import path from "node:path";
import { platformDefaultDataDir } from "../config/paths.js";

export interface PluginPlatformPaths {
  rootDir: string;
  versionsDir: string;
  downloadsDir: string;
  stagingDir: string;
  statePath: string;
}

export function resolvePluginPlatformPaths(rootOverride = process.env.MEMORYLANE_PLUGIN_DIR): PluginPlatformPaths {
  const rootDir = path.resolve(rootOverride || path.join(platformDefaultDataDir(), "Plugins"));
  const result = {
    rootDir,
    versionsDir: path.join(rootDir, "installed"),
    downloadsDir: path.join(rootDir, "downloads"),
    stagingDir: path.join(rootDir, "staging"),
    statePath: path.join(rootDir, "plugins-state.json"),
  };
  for (const directory of [result.rootDir, result.versionsDir, result.downloadsDir, result.stagingDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return result;
}

export function pluginVersionDir(paths: PluginPlatformPaths, pluginId: string, version: string): string {
  return path.join(paths.versionsDir, pluginId, version);
}
