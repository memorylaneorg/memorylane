import { useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import type { ScanRootDto, ScanStatusDto, ScanRunDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import { useConfirm } from "./ConfirmDialog";
import TranscodeCandidatesPanel from "./TranscodeCandidatesPanel";

const inputClass = "rounded-lg border border-border bg-page px-3.5 py-2.5 text-ink outline-none focus:border-accent";
const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";
const accentButtonClass = "rounded-lg bg-accent px-5 py-2.5 font-semibold text-page hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

function scanRootSummary(root: ScanRootDto): string {
  const { stats } = root;
  if (stats.mediaCount === 0) return "No media indexed yet";
  const parts: string[] = [];
  if (stats.photoCount) parts.push(`${stats.photoCount.toLocaleString()} photos`);
  if (stats.rawCount) parts.push(`${stats.rawCount.toLocaleString()} RAW`);
  if (stats.videoCount) parts.push(`${stats.videoCount.toLocaleString()} videos`);
  parts.push(`${stats.folderCount.toLocaleString()} folders`);
  let summary = parts.join(" · ");
  if (stats.pendingThumbnails) summary += ` · ${stats.pendingThumbnails.toLocaleString()} pending`;
  if (stats.failedThumbnails) summary += ` · ${stats.failedThumbnails.toLocaleString()} failed`;
  return summary;
}

// Live progress for one scan run, shown directly under the folder it's
// currently working on rather than as one undifferentiated block elsewhere.
export function ScanProgress({ run }: { run: ScanRunDto }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2.5 text-xs text-muted">
      <p>
        {run.filesScanned.toLocaleString()} files scanned, {run.filesNew.toLocaleString()} new,{" "}
        {run.errorCount.toLocaleString()} errors so far.
      </p>
      {run.thumbnailsQueued > 0 && (
        <div className="flex flex-col gap-1">
          <p>
            {run.thumbnailsProcessed < run.thumbnailsQueued ? "Generating thumbnails: " : "Thumbnails done: "}
            {run.thumbnailsProcessed.toLocaleString()} of {run.thumbnailsQueued.toLocaleString()}
          </p>
          <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.min(100, (run.thumbnailsProcessed / run.thumbnailsQueued) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Full folder add/list/reorder/enable/remove/scan-now management, extracted
// so it can be used both in Settings > Folders & Exclusions and on the
// welcome flow's first step - self-contained (owns its own scanRoots/status
// state and polling, and the video-modernization nudge/panel) rather than
// threading a large slice of SettingsPage's state down as props. The
// scan-schedule controls stay Settings-only (not essential for a first look);
// showTranscodeNudge lets the welcome flow opt out of that one piece too,
// since "you have videos to modernize" isn't a first-run concern.
export default function ScanFoldersManager({
  onRootsChange,
  showTranscodeNudge = true,
}: { onRootsChange?: (roots: ScanRootDto[]) => void; showTranscodeNudge?: boolean } = {}) {
  const [scanRoots, setScanRoots] = useState<ScanRootDto[]>([]);
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ScanStatusDto | null>(null);
  const [openTranscodeRootId, setOpenTranscodeRootId] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { confirm } = useConfirm();

  useEffect(() => {
    void (async () => {
      const [roots, st] = await Promise.all([api.scanRoots.list(), api.scans.status()]);
      setScanRoots(roots);
      onRootsChange?.(roots);
      setStatus(st);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status?.running && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const st = await api.scans.status();
        setStatus(st);
        if (!st.running && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          const roots = await api.scanRoots.list();
          setScanRoots(roots);
          onRootsChange?.(roots);
        }
      }, 2000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running]);

  const addScanRoot = async () => {
    if (!newPath.trim()) return;
    setError(null);
    try {
      const root = await api.scanRoots.create({ path: newPath.trim() });
      setScanRoots((prev) => {
        const next = [...prev, root];
        onRootsChange?.(next);
        return next;
      });
      setNewPath("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add folder");
    }
  };

  const toggleRoot = async (root: ScanRootDto) => {
    const updated = await api.scanRoots.update(root.id, { enabled: !root.enabled });
    setScanRoots((prev) => prev.map((r) => (r.id === root.id ? updated : r)));
  };

  const removeRoot = async (root: ScanRootDto) => {
    const ok = await confirm({
      title: "Remove this folder from MemoryLane?",
      message: (
        <>
          <code className="text-ink">{root.path}</code> is removed from the library. Original files are never touched - this only removes
          MemoryLane's index for the folder.
        </>
      ),
      confirmLabel: "Remove folder",
      danger: true,
    });
    if (!ok) return;
    await api.scanRoots.remove(root.id);
    setScanRoots((prev) => {
      const next = prev.filter((r) => r.id !== root.id);
      onRootsChange?.(next);
      return next;
    });
  };

  const moveRoot = async (id: number, direction: "up" | "down") => {
    setScanRoots(await api.scanRoots.move(id, direction));
  };

  const runScanNow = async (scanRootId?: number) => {
    setError(null);
    try {
      await api.scans.run(scanRootId);
      setStatus(await api.scans.status());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start scan");
    }
  };

  const activeScanRootId = status?.running
    ? (status.currentRun?.scanRootId ?? status.currentRun?.currentScanRootId ?? null)
    : null;

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void addScanRoot(); }}
          placeholder={"e.g. D:\\Photos or /mnt/photos"}
          className={`flex-1 ${inputClass}`}
        />
        <button onClick={() => void addScanRoot()} className={accentButtonClass}>
          Add Folder
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
      {scanRoots.length > 0 && <p className="mb-2 text-xs text-muted">Order here also sets the order folders appear in on the Home page.</p>}
      <ul className="flex flex-col gap-2">
        {scanRoots.map((root, i) => (
          <li key={root.id} className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex shrink-0 flex-col">
                <button
                  onClick={() => void moveRoot(root.id, "up")}
                  disabled={i === 0}
                  aria-label="Move up"
                  title="Move up"
                  className="grid h-5 w-5 place-items-center rounded text-muted hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronUp size={14} strokeWidth={2} />
                </button>
                <button
                  onClick={() => void moveRoot(root.id, "down")}
                  disabled={i === scanRoots.length - 1}
                  aria-label="Move down"
                  title="Move down"
                  className="grid h-5 w-5 place-items-center rounded text-muted hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronDown size={14} strokeWidth={2} />
                </button>
              </div>
              <div className="mr-auto flex min-w-0 flex-col gap-0.5">
                <span className={`truncate ${root.enabled ? "text-ink" : "text-muted"}`}>{root.path}</span>
                <span className="text-xs text-muted">{scanRootSummary(root)}</span>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => void runScanNow(root.id)}
                  disabled={!root.enabled || status?.running}
                  title={!root.enabled ? "Enable this folder to scan it" : undefined}
                  className={buttonClass}
                >
                  {status?.running && status.currentRun?.scanRootId === root.id ? "Scanning..." : "Scan Now"}
                </button>
                <button onClick={() => void toggleRoot(root)} className={buttonClass}>
                  {root.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={() => void removeRoot(root)} className={buttonClass}>
                  Remove
                </button>
              </span>
            </div>
            {status?.running && status.currentRun && activeScanRootId === root.id && <ScanProgress run={status.currentRun} />}
            {showTranscodeNudge && root.stats.transcodeCandidateCount > 0 && (
              <div className="border-t border-border pt-2.5">
                <button onClick={() => setOpenTranscodeRootId(root.id)} className="text-xs font-medium text-accent hover:underline">
                  {root.stats.transcodeCandidateCount.toLocaleString()} video
                  {root.stats.transcodeCandidateCount === 1 ? "" : "s"} could be modernized →
                </button>
              </div>
            )}
          </li>
        ))}
        {scanRoots.length === 0 && <li className="text-sm text-muted">No folders added yet.</li>}
      </ul>
      {openTranscodeRootId != null && (
        <TranscodeCandidatesPanel
          scanRootId={openTranscodeRootId}
          onClose={() => setOpenTranscodeRootId(null)}
          onCountChange={(count) => {
            const rootId = openTranscodeRootId;
            setScanRoots((prev) => prev.map((r) => (r.id === rootId ? { ...r, stats: { ...r.stats, transcodeCandidateCount: count } } : r)));
          }}
        />
      )}
    </div>
  );
}
