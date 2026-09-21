import type { PluginManager } from "../plugin-platform/manager.js";
import { SidecarProvider } from "./sidecar-provider.js";
import { ProviderUnavailableError, type AiProvider, type EmbeddingBatch, type FaceBatch, type ProviderInfo } from "./types.js";

export const AI_RUNTIME_PLUGIN_ID = "com.memorylane.ai-runtime";
export const AI_SEARCH_PLUGIN_ID = "com.memorylane.ai-search";
export const PEOPLE_PLUGIN_ID = "com.memorylane.people";
export const DEFAULT_AI_MODEL = "clip-vit-base-patch32@1";

export class PluginAiProvider implements AiProvider {
  readonly id = "plugin-ai-runtime";
  readonly expectedModel: string;
  private current: { key: string; provider: SidecarProvider } | null = null;
  constructor(private manager: PluginManager, expectedModel = DEFAULT_AI_MODEL) { this.expectedModel = expectedModel; }

  private provider(): SidecarProvider {
    const instance = this.manager.supervisor.get(AI_RUNTIME_PLUGIN_ID);
    if (!instance) throw new ProviderUnavailableError("AI Runtime plugin is not installed or running");
    const key = `${instance.port}:${instance.token}`;
    if (this.current?.key !== key) this.current = { key, provider: new SidecarProvider(`http://127.0.0.1:${instance.port}`, { token: instance.token, expectedModel: this.expectedModel }) };
    return this.current.provider;
  }
  async health(force = false): Promise<ProviderInfo> {
    try { return await this.provider().health(force); }
    catch (error) { return { url: "plugin://ai-runtime", reachable: false, model: null, dim: null, faceModel: null, faceModels: [], device: null, lastError: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() }; }
  }
  getInfo(): ProviderInfo { try { return this.provider().getInfo(); } catch (error) { return { url: "plugin://ai-runtime", reachable: false, model: null, dim: null, faceModel: null, faceModels: [], device: null, lastError: error instanceof Error ? error.message : String(error), checkedAt: null }; } }
  embedImages(images: Buffer[]): Promise<EmbeddingBatch> { this.requireFeature(AI_SEARCH_PLUGIN_ID); return this.provider().embedImages(images); }
  embedText(texts: string[]): Promise<EmbeddingBatch> { this.requireFeature(AI_SEARCH_PLUGIN_ID); return this.provider().embedText(texts); }
  detectFaces(images: Buffer[], model: string): Promise<FaceBatch> { this.requireFeature(PEOPLE_PLUGIN_ID); return this.provider().detectFaces(images, model); }
  cluster(vectors: Float32Array[], opts: { threshold: number; minClusterSize: number }): Promise<number[]> { this.requireFeature(PEOPLE_PLUGIN_ID); return this.provider().cluster(vectors, opts); }
  private requireFeature(pluginId: string): void { if(!this.manager.isEnabled(pluginId)) throw new ProviderUnavailableError(`${pluginId} is not installed or enabled`); }
}
