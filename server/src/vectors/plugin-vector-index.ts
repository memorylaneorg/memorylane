import type { PluginManager } from "../plugin-platform/manager.js";
import { AI_RUNTIME_PLUGIN_ID } from "../providers/plugin-ai-provider.js";
import { CapabilityUnavailableError } from "../capabilities/errors.js";
import type { VectorHit, VectorIndex, VectorRow } from "./vector-index.js";

export class PluginVectorIndex implements VectorIndex {
  constructor(private manager: PluginManager) {}
  upsert(space: string, rows: VectorRow[]): Promise<void> { return rows.length ? this.post("/v1/vectors/upsert", { space, rows: rows.map((r) => ({ id: r.id, vector: Array.from(r.vector) })) }).then(() => undefined) : Promise.resolve(); }
  remove(space: string, ids: number[]): Promise<void> { return ids.length ? this.post("/v1/vectors/remove", { space, ids }).then(() => undefined) : Promise.resolve(); }
  async search(space: string, query: Float32Array, k: number, opts: { excludeIds?: number[] } = {}): Promise<VectorHit[]> { return (await this.post<{ hits: VectorHit[] }>("/v1/vectors/search", { space, vector: Array.from(query), limit: k, exclude_ids: opts.excludeIds ?? [] })).hits; }
  async count(space: string): Promise<number> { return (await this.request<{ count: number }>(`/v1/vectors/count?space=${encodeURIComponent(space)}`)).count; }
  async rebuild(space: string, rows: Iterable<VectorRow>, _dim: number): Promise<void> {
    await this.post("/v1/vectors/clear", { space });
    const batch: VectorRow[] = [];
    for (const row of rows) {
      batch.push(row);
      if (batch.length === 500) { await this.upsert(space, batch); batch.length = 0; }
    }
    if (batch.length) await this.upsert(space, batch);
  }
  async ensureSynced(space: string, expectedCount: number, rows: () => Iterable<VectorRow>, dim: number | null): Promise<"ok" | "rebuilt"> { if (await this.count(space) === expectedCount) return "ok"; await this.rebuild(space, rows(), dim ?? 0); return "rebuilt"; }

  private endpoint(): { url: string; token: string } { const i=this.manager.supervisor.get(AI_RUNTIME_PLUGIN_ID); if(!i) throw new CapabilityUnavailableError("vector.store", "AI Runtime plugin is unavailable"); return { url:`http://127.0.0.1:${i.port}`, token:i.token }; }
  private post<T=unknown>(path: string, body: unknown): Promise<T> { return this.request(path, { method:"POST", body:JSON.stringify(body), headers:{"content-type":"application/json"} }); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> { const e=this.endpoint(); let response:Response; try { response=await fetch(e.url+path,{...init,headers:{...init.headers,authorization:`Bearer ${e.token}`},signal:AbortSignal.timeout(120_000)}); } catch { throw new CapabilityUnavailableError("vector.store", "AI Runtime plugin is unreachable"); } const body=await response.json() as T & {detail?:string}; if(!response.ok) throw new Error(body.detail ?? `Vector service returned HTTP ${response.status}`); return body; }
}
