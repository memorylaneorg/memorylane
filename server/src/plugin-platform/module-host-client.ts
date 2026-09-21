import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import type { PluginManifest } from "@memorylane/plugin-sdk";

export class PluginModuleHost {
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private readonly loaded = new Set<string>();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly dataDirFor: (pluginId: string) => string,
    private readonly hostEntry: URL = new URL("./module-host.js", import.meta.url),
    private readonly hostExecArgv: string[] | undefined = undefined,
  ) {}

  async load(manifest: PluginManifest, pluginDir: string): Promise<void> {
    if (manifest.entry.kind !== "module") throw new Error("Plugin is not a module");
    const entry = path.resolve(pluginDir, manifest.entry.script);
    if (!entry.startsWith(path.resolve(pluginDir) + path.sep)) throw new Error("Module entry escapes its plugin directory");
    await this.request({ type: "load", pluginId: manifest.id, version: manifest.version, entry, dataDir: this.dataDirFor(manifest.id) });
    this.loaded.add(manifest.id);
  }

  async call(pluginId: string, method: string, payload: unknown): Promise<unknown> {
    return this.request({ type: "call", pluginId, method, payload });
  }

  async unload(pluginId: string): Promise<void> {
    if (!this.loaded.has(pluginId)) return;
    await this.request({ type: "unload", pluginId });
    this.loaded.delete(pluginId);
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try { await this.request({ type: "shutdown" }, 5_000); } finally { this.child?.kill(); this.child = null; this.loaded.clear(); }
  }

  private ensureChild(): ChildProcess {
    if (this.child?.connected) return this.child;
    const child = fork(this.hostEntry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: this.hostExecArgv });
    child.on("message", (raw) => {
      const response = raw as { requestId?: number; ok?: boolean; result?: unknown; error?: string };
      if (!response.requestId) return;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? "Module host request failed"));
    });
    child.once("exit", () => {
      this.child = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Plugin module host exited"));
      }
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  private request(message: object, timeoutMs = 30_000): Promise<unknown> {
    const child = this.ensureChild();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Plugin module host request timed out"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      child.send({ requestId, ...message }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }
}
