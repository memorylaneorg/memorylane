import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { MediaDto, SearchMode, SearchResultDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import FolderCard from "../components/FolderCard";
import MediaGrid from "../components/MediaGrid";
import Viewer from "../components/Viewer";

const MODES: { value: SearchMode; label: string; placeholder: string }[] = [
  { value: "text", label: "Names", placeholder: "Search folders, filenames, camera, lens..." },
  { value: "semantic", label: "Describe it (AI)", placeholder: "a bird taking off from water, a red car at night, snow on mountains..." },
];

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("text");
  const [results, setResults] = useState<SearchResultDto[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setProblem(null);
    try {
      const res = await api.search(q.trim(), 0, 60, mode);
      setResults(res.items);
    } catch (err) {
      setResults(null);
      setProblem(err instanceof ApiError && err.status === 503 ? err.message : "Search failed");
    }
  };

  // Ranked by CLIP text->image similarity. The raw cosine values sit around
  // 0.2-0.3 even for good matches, so they're deliberately not shown as
  // percentages - the order is the signal.
  const semanticMedia: MediaDto[] = mode === "semantic" ? (results ?? []).flatMap((r) => (r.media ? [r.media] : [])) : [];

  // Text search has no meaningful cross-type relevance score to preserve
  // (SearchResultDto.score is only ever set for semantic results), so
  // grouping by type reads better than trying to interleave folders and
  // media in one list - same as most other search UIs.
  const textFolders = mode === "text" ? (results ?? []).flatMap((r) => (r.type === "folder" && r.folder ? [r.folder] : [])) : [];
  const textMedia: MediaDto[] = mode === "text" ? (results ?? []).flatMap((r) => (r.type !== "folder" && r.media ? [r.media] : [])) : [];

  return (
    <div>
      <div className="mb-3 flex items-center gap-1 rounded-md border border-border p-0.5 text-sm w-fit" role="group" aria-label="Search mode">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => {
              setMode(m.value);
              setResults(null);
              setProblem(null);
            }}
            aria-pressed={mode === m.value}
            className={`rounded px-3 py-1 transition-colors ${mode === m.value ? "bg-accent text-page" : "text-muted hover:bg-hover hover:text-ink"}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="mb-5 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={MODES.find((m) => m.value === mode)?.placeholder}
          autoFocus
          className="flex-1 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-ink outline-none focus:border-accent"
        />
        <button type="submit" className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-page hover:opacity-90">
          Search
        </button>
      </form>

      {problem && (
        <div className="mb-4 rounded-lg border border-border bg-surface p-4 text-sm text-ink">
          <p className="font-medium">AI search isn't available right now.</p>
          <p className="mt-1 text-muted">
            {problem} - see{" "}
            <Link to="/settings" className="text-accent underline">
              Settings › AI
            </Link>
            .
          </p>
        </div>
      )}

      {mode === "semantic" && results && (
        <>
          {semanticMedia.length === 0 && <p className="text-sm text-muted">Nothing analysed yet matches that description.</p>}
          {semanticMedia.length > 0 && <MediaGrid items={semanticMedia} onOpen={setViewerIndex} />}
          {viewerIndex !== null && <Viewer items={semanticMedia} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />}
        </>
      )}

      {mode === "text" && results && (
        <>
          {textFolders.length === 0 && textMedia.length === 0 && <p className="text-sm text-muted">No results.</p>}
          {textFolders.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold text-muted">Folders</h2>
              <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
                {textFolders.map((folder) => (
                  <FolderCard key={folder.id} folder={folder} />
                ))}
              </div>
            </section>
          )}
          {textMedia.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-muted">Photos &amp; Videos</h2>
              <MediaGrid items={textMedia} onOpen={setViewerIndex} />
            </section>
          )}
          {viewerIndex !== null && <Viewer items={textMedia} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />}
        </>
      )}
    </div>
  );
}
