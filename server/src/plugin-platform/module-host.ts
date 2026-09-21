import { pathToFileURL } from "node:url";

interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface PluginModule {
  activate?: (context: {
    pluginId: string;
    dataDir: string;
    logger: PluginLogger;
    plugin: { id: string; version: string };
  }) => Promise<PluginModuleInstance> | PluginModuleInstance;
}

interface PluginModuleInstance {
  call?: (method: string, payload: unknown) => Promise<unknown> | unknown;
  stop?: () => Promise<void> | void;
}

const loaded = new Map<string, PluginModuleInstance>();

process.on("message", async (message: unknown) => {
  const request = message as { requestId: number; type: string; pluginId?: string; version?: string; entry?: string; dataDir?: string; method?: string; payload?: unknown };
  const respond = (response: object) => process.send?.({ requestId: request.requestId, ...response });
  try {
    if (request.type === "load" && request.pluginId && request.version && request.entry && request.dataDir) {
      const pluginId = request.pluginId;
      const logger: PluginLogger = {
        info: (message, ...args) => console.log(`[${pluginId}]`, message, ...args),
        warn: (message, ...args) => console.warn(`[${pluginId}]`, message, ...args),
        error: (message, ...args) => console.error(`[${pluginId}]`, message, ...args),
      };
      // Node's ESM loader caches by exact URL for the lifetime of this
      // process - re-importing the same plugin (e.g. disable then enable
      // again from Settings, without a full server restart) would otherwise
      // silently keep running the code from the first load, even after the
      // file on disk changed. A cache-busting query string forces a genuine
      // re-read every time; harmless for a real install too, since an
      // installed version's files never change after the fact anyway.
      const plugin = await import(`${pathToFileURL(request.entry).href}?t=${Date.now()}`) as PluginModule;
      const instance = await plugin.activate?.({ pluginId, dataDir: request.dataDir, logger, plugin: { id: pluginId, version: request.version } }) ?? {};
      loaded.set(pluginId, instance);
      return respond({ ok: true });
    }
    if (request.type === "call" && request.pluginId && request.method) {
      const instance = loaded.get(request.pluginId);
      if (!instance?.call) throw new Error("Plugin does not expose a call handler");
      return respond({ ok: true, result: await instance.call(request.method, request.payload) });
    }
    if (request.type === "unload" && request.pluginId) {
      await loaded.get(request.pluginId)?.stop?.();
      loaded.delete(request.pluginId);
      return respond({ ok: true });
    }
    if (request.type === "shutdown") {
      for (const instance of loaded.values()) await instance.stop?.();
      respond({ ok: true });
      return process.disconnect?.();
    }
    throw new Error("Unknown module-host request");
  } catch (error) {
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
