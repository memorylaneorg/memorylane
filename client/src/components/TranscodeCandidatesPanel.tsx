import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscodeCandidateDto, VideoTranscodeQuality } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import { formatBytes, formatDuration } from "../utils/format";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import Modal from "./Modal";

const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 2000;

interface TranscodeCandidatesPanelProps {
  scanRootId: number;
  onClose: () => void;
  // Called with the true server-side total whenever it changes, so the
  // parent's "N videos could be modernized" count stays in sync without its
  // own poll - independent of how many rows happen to be loaded/paginated.
  onCountChange?: (count: number) => void;
}

const buttonClass =
  "rounded-md border border-border px-3 py-1.5 text-xs text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";
const accentButtonClass =
  "rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-page hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export default function TranscodeCandidatesPanel({ scanRootId, onClose, onCountChange }: TranscodeCandidatesPanelProps) {
  const [items, setItems] = useState<TranscodeCandidateDto[]>([]);
  const [total, setTotal] = useState(0);
  const [verifiedTotal, setVerifiedTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [quality, setQuality] = useState<VideoTranscodeQuality>("standard");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lightboxMediaId, setLightboxMediaId] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadingMoreRef = useRef(false);

  const loadFirstPage = useCallback(async () => {
    setInitialLoading(true);
    try {
      const res = await api.transcode.candidates(scanRootId, 0, PAGE_SIZE);
      setItems(res.items);
      setTotal(res.total);
      setVerifiedTotal(res.verifiedTotal);
      onCountChange?.(res.total);
    } finally {
      setInitialLoading(false);
    }
  }, [scanRootId, onCountChange]);

  useEffect(() => {
    void loadFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRootId]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await api.transcode.candidates(scanRootId, items.length, PAGE_SIZE);
      setItems((prev) => [...prev, ...res.items]);
      setTotal(res.total);
      setVerifiedTotal(res.verifiedTotal);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [scanRootId, items.length]);

  const hasMore = items.length < total;
  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore, bodyRef);

  // Refreshes job status for whatever's currently loaded (cheap - job rows
  // only, no media join needed beyond scan root) without disturbing
  // pagination or scroll position. Archived rows drop out of view. This
  // deliberately does NOT recompute total/verifiedTotal - those come from
  // loadFirstPage/loadMore's own responses (on initial load, "load more",
  // and after any explicit action), so the header counts may lag by up to
  // one poll tick during an active batch rather than round-tripping a full
  // recount every 2s.
  const refreshJobStatuses = useCallback(async () => {
    const jobs = await api.transcode.status(scanRootId);
    const jobsByMediaId = new Map(jobs.map((j) => [j.mediaId, j]));
    setItems((prev) =>
      prev
        .map((c) => (jobsByMediaId.has(c.media.id) ? { ...c, job: jobsByMediaId.get(c.media.id)! } : c))
        .filter((c) => c.job?.status !== "archived"),
    );
  }, [scanRootId]);

  useEffect(() => {
    const active = items.some((c) => c.job?.status === "pending" || c.job?.status === "transcoding");
    if (active && !pollRef.current) {
      pollRef.current = setInterval(() => void refreshJobStatuses(), POLL_INTERVAL_MS);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [items, refreshJobStatuses]);

  const runAction = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await Promise.all([loadFirstPage(), refreshJobStatuses()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Videos that could be modernized" onClose={onClose} bodyRef={bodyRef} wide>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Quality
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as VideoTranscodeQuality)}
            className="rounded border border-border bg-page px-1.5 py-1 text-ink outline-none focus:border-accent"
          >
            <option value="standard">Standard (smaller files)</option>
            <option value="high">Higher quality (larger files)</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => void runAction(() => api.transcode.start(scanRootId, { all: true, quality }))}
            disabled={busy || total === 0}
            className={buttonClass}
          >
            Transcode All ({total.toLocaleString()})
          </button>
          <button
            onClick={() => void runAction(() => api.transcode.archive(scanRootId, { all: true }))}
            disabled={busy || verifiedTotal === 0}
            className={accentButtonClass}
          >
            Archive All Verified ({verifiedTotal.toLocaleString()})
          </button>
        </div>
      </div>

      {error && <p className="mb-3 text-xs text-red-500">{error}</p>}

      {initialLoading ? (
        <p className="text-xs text-muted">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted">Nothing left to modernize in this folder.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {items.map((c) => (
              <CandidateRow
                key={c.media.id}
                candidate={c}
                scanRootId={scanRootId}
                quality={quality}
                onAction={runAction}
                onExpandPreview={() => setLightboxMediaId(c.media.id)}
              />
            ))}
          </ul>
          {hasMore && (
            <div ref={sentinelRef} className="flex min-h-[40px] items-center justify-center text-xs text-muted">
              {loadingMore && `Loading more (${items.length} / ${total})...`}
            </div>
          )}
        </>
      )}

      {lightboxMediaId != null && (
        <Modal title="Preview" onClose={() => setLightboxMediaId(null)}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={api.transcode.previewUrl(lightboxMediaId)}
            controls
            autoPlay
            className="max-h-[70vh] w-full rounded"
          />
        </Modal>
      )}
    </Modal>
  );
}

function CandidateRow({
  candidate,
  scanRootId,
  quality,
  onAction,
  onExpandPreview,
}: {
  candidate: TranscodeCandidateDto;
  scanRootId: number;
  quality: VideoTranscodeQuality;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onExpandPreview: () => void;
}) {
  const { media, job } = candidate;
  // Lazy: a poster thumbnail by default, a real <video> only once this
  // specific row is clicked - mounting a live player per row unconditionally
  // doesn't scale once more than a handful are verified at once.
  const [playingInline, setPlayingInline] = useState(false);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-page px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{media.filename}</div>
          <div className="text-muted">
            {media.durationSeconds != null ? formatDuration(media.durationSeconds) : "unknown length"} ·{" "}
            {formatBytes(media.fileSize)} · {media.codec ?? "unknown codec"}
            {media.audioCodec ? ` + ${media.audioCodec}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!job && (
            <button
              onClick={() => void onAction(() => api.transcode.start(scanRootId, { mediaIds: [media.id], quality }))}
              className={buttonClass}
            >
              Transcode
            </button>
          )}
          {job?.status === "pending" && <span className="text-muted">Queued...</span>}
          {job?.status === "transcoding" && <span className="text-muted">Transcoding...</span>}
          {job?.status === "failed" && (
            <button
              onClick={() => void onAction(() => api.transcode.start(scanRootId, { mediaIds: [media.id], quality }))}
              className={buttonClass}
            >
              Retry
            </button>
          )}
          {job?.status === "done" && job.verified && (
            <button
              onClick={() => void onAction(() => api.transcode.archive(scanRootId, { mediaIds: [media.id] }))}
              className={accentButtonClass}
            >
              Archive
            </button>
          )}
        </div>
      </div>

      {job?.status === "failed" && job.error && <p className="text-red-500">{job.error}</p>}

      {job?.status === "done" && job.verified && (
        <div className="flex items-center gap-3 border-t border-border pt-2">
          {playingInline ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={api.transcode.previewUrl(media.id)}
              controls
              autoPlay
              className="h-24 w-40 shrink-0 rounded bg-black object-contain"
            />
          ) : (
            <button
              onClick={() => setPlayingInline(true)}
              className="relative h-24 w-40 shrink-0 overflow-hidden rounded bg-black"
              aria-label="Play preview"
            >
              <img
                src={api.transcode.previewThumbnailUrl(media.id)}
                alt=""
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
                className="h-full w-full object-contain"
              />
              <span className="absolute inset-0 grid place-items-center text-2xl text-white/90">▶</span>
            </button>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-muted">
              New file: {job.outputDurationSeconds != null ? formatDuration(job.outputDurationSeconds) : "?"} ·{" "}
              {job.outputSizeBytes != null ? formatBytes(job.outputSizeBytes) : "?"}
            </p>
            <p className="text-muted">✓ duration match · ✓ playable</p>
            <button onClick={onExpandPreview} className="self-start text-accent hover:underline">
              Expand preview
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
