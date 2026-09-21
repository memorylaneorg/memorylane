import { useEffect, useState } from "react";
import type { MediaTagDto } from "@memorylane/shared";
import { api } from "../api/client";

export default function TagEditor({ mediaId }: { mediaId: number }) {
  const [tags, setTags] = useState<MediaTagDto[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setTags([]); setError(null);
    void api.tags.forMedia(mediaId).then((items) => { if (active) setTags(items); }).catch(() => {});
    return () => { active = false; };
  }, [mediaId]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    try { const tag = await api.tags.add(mediaId, name); setTags((old) => [...old.filter((item) => !(item.id === tag.id && item.source === "user")), tag].sort((a, b) => a.name.localeCompare(b.name))); setName(""); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add tag"); }
  };
  const remove = async (tag: MediaTagDto) => {
    if (tag.source === "imported") return;
    try { await api.tags.remove(mediaId, tag.id, tag.source); setTags((old) => old.filter((item) => item.id !== tag.id || item.source !== tag.source)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove tag"); }
  };

  return <div className="flex max-w-[360px] flex-col gap-2">
    <span>Tags</span>
    <div className="flex flex-wrap gap-1">{tags.map((tag) => <span key={`${tag.id}:${tag.source}`} className="rounded-full border border-white/30 px-2 py-0.5 text-xs">
      {tag.name} <span className="text-white/60">{tag.source}</span>
      {tag.source !== "imported" && <button type="button" onClick={() => void remove(tag)} aria-label={`Remove ${tag.name} tag`} className="ml-1 text-white/70 hover:text-white">×</button>}
    </span>)}</div>
    <form onSubmit={(event) => void add(event)} className="flex gap-1">
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Add a tag" aria-label="Add a tag" className="min-w-0 flex-1 rounded bg-white/15 px-2 py-1 text-white placeholder:text-white/50" />
      <button disabled={!name.trim()} className="rounded bg-white/20 px-2 py-1 disabled:opacity-50">Add</button>
    </form>
    {error && <span role="alert" className="text-red-300">{error}</span>}
  </div>;
}
