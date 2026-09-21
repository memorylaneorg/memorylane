import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginManifest } from "@memorylane/plugin-sdk";

const execFileAsync = promisify(execFile);

export class PluginCommandRunner {
  async run(
    manifest: PluginManifest,
    pluginDir: string,
    command: string,
    args: string[],
    environment: Record<string, string>,
    timeoutMs = 5 * 60_000,
  ): Promise<{ stdout: string; stderr: string }> {
    if (manifest.entry.kind !== "command") throw new Error("Plugin does not expose commands");
    const relative = manifest.entry.commands[command];
    if (!relative) throw new Error(`Unknown plugin command: ${command}`);
    const executable = path.resolve(pluginDir, relative);
    if (!executable.startsWith(path.resolve(pluginDir) + path.sep)) throw new Error("Command executable escapes its plugin directory");
    return execFileAsync(executable, args, {
      cwd: pluginDir,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...environment },
    });
  }
}
