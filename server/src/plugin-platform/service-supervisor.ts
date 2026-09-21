import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { DEV_SERVICE_TOKEN, PluginManifestSchema, type PluginManifest } from "@memorylane/plugin-sdk";

export interface ServiceInstance {
  manifest: PluginManifest & { entry: { kind: "service"; executable: string; args: string[] } };
  // Absent for a dev-catalog instance (manifest.entry.devPort set) - core
  // never spawned it, so there's nothing here to own or kill, only a port to
  // health-check.
  process?: ChildProcess;
  port: number;
  token: string;
  stopping: boolean;
  spawnError: Error | null;
}

export interface ServiceSupervisorOptions {
  coreVersion: string;
  dataDirFor(pluginId: string): string;
  logDirFor(pluginId: string): string;
  onOutput?: (pluginId: string, stream: "stdout" | "stderr", text: string) => void;
}

export class PluginServiceSupervisor {
  private readonly instances = new Map<string, ServiceInstance>();
  private readonly definitions = new Map<string, { manifest: PluginManifest; pluginDir: string; attempts: number; timer?: NodeJS.Timeout }>();

  constructor(private readonly options: ServiceSupervisorOptions) {}

  async start(rawManifest: PluginManifest, pluginDir: string): Promise<ServiceInstance> {
    const manifest = PluginManifestSchema.parse(rawManifest);
    if (manifest.entry.kind !== "service") throw new Error("Only service plugins can be supervised");
    if (this.instances.has(manifest.id)) throw new Error(`${manifest.id} is already running`);
    if (manifest.entry.devPort) return this.startDev(manifest as ServiceInstance["manifest"], manifest.entry.devPort);
    const definition = this.definitions.get(manifest.id) ?? { manifest, pluginDir, attempts: 0 };
    definition.manifest = manifest;
    definition.pluginDir = pluginDir;
    this.definitions.set(manifest.id, definition);
    const port = await reserveLoopbackPort();
    const token = randomBytes(32).toString("base64url");
    let executable = path.resolve(pluginDir, manifest.entry.executable);
    if (!executable.startsWith(path.resolve(pluginDir) + path.sep)) throw new Error("Service executable escapes its plugin directory");
    if (process.platform === "win32" && !fs.existsSync(executable) && fs.existsSync(`${executable}.exe`)) executable += ".exe";
    const isNodeModule = executable.endsWith(".mjs") || executable.endsWith(".js");
    const pluginDataDir = this.options.dataDirFor(manifest.id);
    const child = spawn(isNodeModule ? process.execPath : executable, isNodeModule ? [executable, ...manifest.entry.args] : manifest.entry.args, {
      cwd: pluginDir,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MEMORYLANE_PLUGIN_ID: manifest.id,
        MEMORYLANE_PLUGIN_VERSION: manifest.version,
        MEMORYLANE_PLUGIN_API: String(manifest.pluginApi),
        MEMORYLANE_PLUGIN_PORT: String(port),
        MEMORYLANE_PLUGIN_TOKEN: token,
        MEMORYLANE_PLUGIN_DATA_DIR: pluginDataDir,
        MEMORYLANE_PLUGIN_LOG_DIR: this.options.logDirFor(manifest.id),
        MEMORYLANE_MODEL_CACHE_DIR: path.join(pluginDataDir, "models"),
        HF_HOME: path.join(pluginDataDir, "models", "huggingface"),
        MEMORYLANE_CORE_VERSION: this.options.coreVersion,
      },
    });
    const instance: ServiceInstance = { manifest: manifest as ServiceInstance["manifest"], process: child, port, token, stopping: false, spawnError: null };
    this.instances.set(manifest.id, instance);
    child.stdout?.on("data", (chunk) => this.options.onOutput?.(manifest.id, "stdout", String(chunk)));
    child.stderr?.on("data", (chunk) => this.options.onOutput?.(manifest.id, "stderr", String(chunk)));
    child.once("error", (error) => { instance.spawnError = error; });
    child.once("exit", (code) => {
      this.instances.delete(manifest.id);
      if (!instance.stopping) this.scheduleRestart(definition, code);
    });
    try {
      await this.waitUntilReady(instance);
      return instance;
    } catch (error) {
      instance.stopping = true;
      await this.forceStop(instance);
      throw error;
    }
  }

  get(pluginId: string): ServiceInstance | undefined { return this.instances.get(pluginId); }

  // Dev-catalog noop lifecycle: the plugin author runs this process
  // themselves (their own `npm run dev` or equivalent) on a fixed,
  // manifest-declared port - core only health-checks it, never spawns or
  // kills it. waitUntilReady is exactly the same poll a spawned instance
  // uses; it only cares that something answers on the port, not who started it.
  private async startDev(manifest: ServiceInstance["manifest"], port: number): Promise<ServiceInstance> {
    const instance: ServiceInstance = { manifest, port, token: DEV_SERVICE_TOKEN, stopping: false, spawnError: null };
    this.instances.set(manifest.id, instance);
    try {
      await this.waitUntilReady(instance);
      return instance;
    } catch (error) {
      this.instances.delete(manifest.id);
      throw error;
    }
  }

  async stop(pluginId: string): Promise<void> {
    const instance = this.instances.get(pluginId);
    if (!instance) return;
    instance.stopping = true;
    const definition = this.definitions.get(pluginId);
    if (definition?.timer) clearTimeout(definition.timer);
    this.definitions.delete(pluginId);
    const child = instance.process;
    if (!child) { this.instances.delete(pluginId); return; }
    try {
      await fetch(`http://127.0.0.1:${instance.port}/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${instance.token}` },
        signal: AbortSignal.timeout(2_000),
      });
    } catch { /* process termination below is authoritative */ }
    if (child.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (child.exitCode === null) await this.forceStop(instance);
    this.instances.delete(pluginId);
  }

  async stopAll(): Promise<void> { await Promise.all([...this.instances.keys()].map((id) => this.stop(id))); }

  private async waitUntilReady(instance: ServiceInstance): Promise<void> {
    const health = instance.manifest.health!;
    const deadline = Date.now() + health.timeoutSeconds * 1_000;
    let lastError = "service did not respond";
    while (Date.now() < deadline) {
      if (instance.process && instance.process.exitCode !== null) throw new Error(`Plugin exited before it became ready (${instance.process.exitCode})`);
      if (instance.spawnError) throw instance.spawnError;
      try {
        const response = await fetch(`http://127.0.0.1:${instance.port}${health.path}`, {
          headers: { authorization: `Bearer ${instance.token}` },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          const body = await response.json() as Record<string, unknown>;
          if (body.status === "ready" && body.pluginId === instance.manifest.id && body.version === instance.manifest.version && body.pluginApi === instance.manifest.pluginApi) return;
          lastError = "health identity did not match the manifest";
        } else lastError = `health returned HTTP ${response.status}`;
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Plugin health check timed out: ${lastError}`);
  }

  // Only ever called on a supervisor-spawned instance (start()'s own catch
  // block, and stop() after its `!instance.process` dev-lifecycle early
  // return) - never on a dev-catalog noop instance, but guard anyway.
  private async forceStop(instance: ServiceInstance): Promise<void> {
    const child = instance.process;
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        shell: false, windowsHide: true, stdio: "ignore",
      });
      await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
    } else if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
    } else child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* already stopped */ }
        resolve();
      }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private scheduleRestart(definition: { manifest: PluginManifest; pluginDir: string; attempts: number; timer?: NodeJS.Timeout }, code: number | null): void {
    const restart = definition.manifest.restart;
    if (!restart || restart.policy === "never" || (restart.policy === "on-failure" && code === 0)) return;
    if (definition.attempts >= restart.maxAttempts) return;
    const delay = Math.min(30_000, 500 * 2 ** definition.attempts++);
    definition.timer = setTimeout(() => {
      definition.timer = undefined;
      void this.start(definition.manifest, definition.pluginDir).catch(() => {
        this.scheduleRestart(definition, 1);
      });
    }, delay);
    definition.timer.unref();
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("Could not allocate a plugin port")));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
