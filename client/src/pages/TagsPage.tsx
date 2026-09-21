import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MediaDto, TagFacetDto } from "@memorylane/shared";
import { api } from "../api/client";
import MediaGrid from "../components/MediaGrid";
import Viewer from "../components/Viewer";
import AnalysisProgress from "../components/AnalysisProgress";

const PAGE_SIZE = 100;

export default function TagsPage() {
  const [tags, setTags] = useState<TagFacetDto[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [tagTotal, setTagTotal] = useState(0);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selected, setSelected] = useState<TagFacetDto | null>(null);
  const [items, setItems] = useState<MediaDto[]>([]);
  const [total, setTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [progressKey, setProgressKey] = useState(0);
  const lastTagged = useRef("0:0");
  const tagRequestVersion = useRef(0);
  const mediaRequestVersion = useRef(0);
  const refreshTags = useCallback(() => setRefreshVersion((version) => version + 1), []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const version = ++tagRequestVersion.current;
    setTags([]); setTagTotal(0);
    setTagsLoading(true);
    void api.tags.list(debouncedSearch, 0, PAGE_SIZE).then((result) => {
      if (version !== tagRequestVersion.current) return;
      setTags(result.items); setTagTotal(result.total);
    }).catch((cause: unknown) => {
      if (version === tagRequestVersion.current) setError(cause instanceof Error ? cause.message : "Could not load tags");
    }).finally(() => { if (version === tagRequestVersion.current) setTagsLoading(false); });
  }, [debouncedSearch, refreshVersion]);

  const loadMoreTags = async () => {
    if (tagsLoading) return;
    const version = tagRequestVersion.current;
    setTagsLoading(true);
    try {
      const result = await api.tags.list(debouncedSearch, tags.length, PAGE_SIZE);
      if (version !== tagRequestVersion.current) return;
      setTags((previous) => [...previous, ...result.items]); setTagTotal(result.total);
    } catch (cause) { if (version === tagRequestVersion.current) setError(cause instanceof Error ? cause.message : "Could not load more tags"); }
    finally { if (version === tagRequestVersion.current) setTagsLoading(false); }
  };

  const selectTag = async (tag: TagFacetDto) => {
    const version = ++mediaRequestVersion.current;
    setSelected(tag); setItems([]); setTotal(0); setError(null);
    setMediaLoading(true);
    try {
      const result = await api.tags.media(tag.id, 0, PAGE_SIZE);
      if (version !== mediaRequestVersion.current) return;
      setItems(result.items); setTotal(result.total);
    } catch (cause) { if (version === mediaRequestVersion.current) setError(cause instanceof Error ? cause.message : "Could not load tagged photos"); }
    finally { if (version === mediaRequestVersion.current) setMediaLoading(false); }
  };

  const loadMore = async () => {
    if (!selected || mediaLoading) return;
    const version = mediaRequestVersion.current;
    setMediaLoading(true);
    try {
      const result = await api.tags.media(selected.id, items.length, PAGE_SIZE);
      if (version !== mediaRequestVersion.current) return;
      setItems((previous) => [...previous, ...result.items]); setTotal(result.total);
    } catch (cause) { if (version === mediaRequestVersion.current) setError(cause instanceof Error ? cause.message : "Could not load more photos"); }
    finally { if (version === mediaRequestVersion.current) setMediaLoading(false); }
  };

  const generate = async () => {
    setStarting(true); setError(null); setMessage(null);
    try {
      await api.tags.generate();
      setMessage("Tag backfill scheduled. Progress appears below as the worker queues and processes photos.");
      setProgressKey((key) => key + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start tag generation"); }
    finally { setStarting(false); }
  };

  return <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="font-serif text-3xl font-semibold text-ink">Tags</h1>
        <p className="mt-1 text-sm text-muted">Browse imported, personal, and AI generated tags. AI labels can be removed and never mark or delete photos. <Link to="/settings" className="text-accent underline">AI setup</Link></p></div>
      <button onClick={() => void generate()} disabled={starting} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {starting ? "Starting…" : "Generate AI tags"}
      </button>
    </div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {message && <p role="status" className="text-sm text-muted">{message}</p>}
    <div className="rounded-lg border border-border bg-surface p-4">
      <AnalysisProgress key={progressKey} pollMs={10000} only={["embed_image", "ai_tags", "import_tags"]} onStatus={(status) => {
        const done = ["ai_tags", "import_tags"].map((key) => status.analyzers.find((item) => item.key === key)?.counts.done ?? 0).join(":");
        if (done !== lastTagged.current) { lastTagged.current = done; refreshTags(); }
      }} />
    </div>
    <label className="flex flex-col gap-1 text-sm text-muted">Find a tag
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="e.g. mountain" className="w-full max-w-sm rounded-md border border-border bg-surface px-3 py-2 text-ink" />
    </label>
    <div className="flex flex-wrap gap-2">
      {tags.map((tag) => <button key={tag.id} onClick={() => void selectTag(tag)}
        className={`rounded-full border px-3 py-1.5 text-sm ${selected?.id === tag.id ? "border-accent bg-accent/15 text-accent" : "border-border bg-surface text-ink hover:bg-hover"}`}>
        {tag.name} <span className="text-muted">{tag.count.toLocaleString()}</span>
      </button>)}
      {tags.length === 0 && !tagsLoading && <span className="text-sm text-muted">No matching tags yet.</span>}
    </div>
    {tags.length < tagTotal && <button onClick={() => void loadMoreTags()} disabled={tagsLoading} className="self-start rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">Load more tags</button>}
    {selected && <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3"><h2 className="font-serif text-2xl text-ink">{selected.name} <span className="font-sans text-sm text-muted">{total.toLocaleString()} photos</span></h2>
        <button onClick={() => void selectTag(selected)} className="text-sm text-accent underline">Refresh results</button></div>
      <MediaGrid items={items} onOpen={setViewerIndex} />
      {items.length < total && <button onClick={() => void loadMore()} disabled={mediaLoading} className="self-center rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50">Load more</button>}
    </section>}
    {viewerIndex !== null && <Viewer items={items} startIndex={viewerIndex} total={total} onRequestMore={loadMore} onClose={() => { setViewerIndex(null); if (selected) void selectTag(selected); refreshTags(); }} />}
  </div>;
}
