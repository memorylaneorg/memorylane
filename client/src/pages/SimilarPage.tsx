import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SimilarResultDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import MediaGrid from "../components/MediaGrid";
import Viewer from "../components/Viewer";
import { useTranslation } from "react-i18next";

// "Find similar": nearest neighbours of one photo in CLIP space. Needs the
// AI sidecar; the two failure modes get plain explanations, not a spinner.
export default function SimilarPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const mediaId = Number(id);
  const [result, setResult] = useState<SimilarResultDto | null>(null);
  const [problem, setProblem] = useState<{ status: number; message: string } | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setProblem(null);
    api.media
      .similar(mediaId)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (cancelled) return;
        setProblem(err instanceof ApiError ? { status: err.status, message: err.message } : { status: 0, message: "Something went wrong" });
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  const items = result?.items.map((i) => i.media) ?? [];
  const captions = Object.fromEntries((result?.items ?? []).map((i) => [i.media.id, `${Math.round(i.score * 100)}%`]));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-4">
        {result && (
          <img
            src={api.media.thumbnailUrl(result.source.id, result.source.thumbnailVersion)}
            alt=""
            className="size-20 rounded-lg object-cover ring-1 ring-border"
          />
        )}
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-semibold text-ink">{t("pages.similar")}</h1>
          <p className="truncate text-sm text-muted">
            {result ? `Photos that look like ${result.source.filename}` : problem ? "" : "Looking…"}
          </p>
          {result && (
            <Link to={`/folder/${result.source.parentFolderId}`} className="text-xs text-accent underline">
              Open its folder
            </Link>
          )}
        </div>
      </div>

      {problem && (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-ink">
          {problem.status === 503 && (
            <>
              <p className="font-medium">AI features aren't available right now.</p>
              <p className="mt-1 text-muted">
                Start the <code>memorylane-ai</code> sidecar (see its README) and check the connection under{" "}
                <Link to="/settings" className="text-accent underline">Settings › AI</Link>.
              </p>
            </>
          )}
          {problem.status === 409 && (
            <>
              <p className="font-medium">This photo hasn't been analysed yet.</p>
              <p className="mt-1 text-muted">
                The AI queue is still working through your library - progress is under{" "}
                <Link to="/settings" className="text-accent underline">Settings › Analysis</Link>. Try again in a bit.
              </p>
            </>
          )}
          {problem.status !== 503 && problem.status !== 409 && <p>{problem.message}</p>}
        </div>
      )}

      {result && items.length === 0 && <p className="text-sm text-muted">No other analysed photos yet.</p>}
      {items.length > 0 && <MediaGrid items={items} onOpen={setViewerIndex} captions={captions} />}
      {viewerIndex !== null && <Viewer items={items} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />}
    </div>
  );
}
