import type { VectorHit, VectorIndex, VectorRow } from "./vector-index.js";

// Deterministic test implementation. Production uses PluginVectorIndex.
export class MemoryVectorIndex implements VectorIndex {
  private spaces = new Map<string, Map<number, Float32Array>>();
  async upsert(space: string, rows: VectorRow[]): Promise<void> { const table=this.spaces.get(space)??new Map(); this.spaces.set(space,table); for(const row of rows)table.set(row.id,new Float32Array(row.vector)); }
  async remove(space: string, ids: number[]): Promise<void> { const table=this.spaces.get(space); for(const id of ids)table?.delete(id); }
  async search(space: string, query: Float32Array, k: number, opts: { excludeIds?: number[] } = {}): Promise<VectorHit[]> { const excluded=new Set(opts.excludeIds??[]); return [...(this.spaces.get(space)?.entries()??[])].filter(([id])=>!excluded.has(id)).map(([id,v])=>({id,score:cosine(query,v)})).sort((a,b)=>b.score-a.score).slice(0,k); }
  async count(space: string): Promise<number> { return this.spaces.get(space)?.size??0; }
  async rebuild(space: string, rows: Iterable<VectorRow>, _dim: number): Promise<void> { this.spaces.delete(space); await this.upsert(space,[...rows]); }
  async ensureSynced(space: string, expectedCount: number, rows: () => Iterable<VectorRow>, dim: number | null): Promise<"ok"|"rebuilt"> { if(await this.count(space)===expectedCount)return "ok"; await this.rebuild(space,rows(),dim??0); return "rebuilt"; }
}
function cosine(a:Float32Array,b:Float32Array):number{if(a.length!==b.length)return -1;let dot=0,an=0,bn=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];an+=a[i]*a[i];bn+=b[i]*b[i];}return dot/(Math.sqrt(an)*Math.sqrt(bn)||1);}
