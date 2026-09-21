import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import type { SettingsDto, ScanStatusDto, StorageStatsDto, IgnoredPathDto, AnalysisStatusDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { useTheme, type Theme } from "../hooks/useTheme";
import { formatBytes } from "../utils/format";
import AnalysisProgress from "../components/AnalysisProgress";
import PluginsSettings from "../components/PluginsSettings";
import ScanFoldersManager from "../components/ScanFoldersManager";
import ApplePhotosSyncCard from "../components/ApplePhotosSyncCard";
import { useConfirm } from "../components/ConfirmDialog";

const SETTINGS_TABS = [
  { id: "folders", label: "Folders & Exclusions" },
  { id: "analysis", label: "AI & Analysis" },
  { id: "plugins", label: "Plugins" },
  { id: "storage", label: "Storage" },
  { id: "service", label: "Service" },
  { id: "account", label: "Account" },
  { id: "about", label: "About" },
] as const;
const THEME_ORDER: Theme[] = ["light", "dusk", "gallery", "dark"];

const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  dusk: "Dusk",
  gallery: "Gallery",
};

// Small representative swatch colors per theme, just for the picker preview -
// not tied to the live CSS variables since the picker needs to show all four
// themes at once regardless of which one is currently active.
const THEME_SWATCHES: Record<Theme, { page: string; accent: string }> = {
  light: { page: "#ffffff", accent: "#2f6fed" },
  dark: { page: "#08090b", accent: "#8cb5ff" },
  dusk: { page: "#f1ede4", accent: "#426a73" },
  gallery: { page: "#f4f6f7", accent: "#315f8c" },
};

const inputClass = "rounded-lg border border-border bg-page px-3.5 py-2.5 text-ink outline-none focus:border-accent";
const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";
const accentButtonClass = "rounded-lg bg-accent px-5 py-2.5 font-semibold text-page hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

function ChangePasswordForm() {
  const [expanded, setExpanded] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change password");
    } finally {
      setSubmitting(false);
    }
  };

  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)} className="text-sm font-medium text-accent hover:underline">
        Change password
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        required
        className={inputClass}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password (min. 8 characters)"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        minLength={8}
        required
        className={inputClass}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="Confirm new password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        minLength={8}
        required
        className={inputClass}
      />
      {error && <p className="text-sm text-red-500">{error}</p>}
      {success && <p className="text-sm text-green-600">Password changed. You'll stay signed in here; any other signed-in devices have been signed out.</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className={accentButtonClass}>
          {submitting ? "Changing..." : "Change Password"}
        </button>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setError(null);
            setSuccess(false);
          }}
          className="text-sm text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = SETTINGS_TABS.find((tab) => tab.id === searchParams.get("tab"))?.id ?? "folders";
  const selectTab = (id: string) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (id === "folders") next.delete("tab");
      else next.set("tab", id);
      return next;
    });
  };
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [status, setStatus] = useState<ScanStatusDto | null>(null);
  const [storage, setStorage] = useState<StorageStatsDto | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [movePath, setMovePath] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveDone, setMoveDone] = useState<{ from: string; to: string; bytes: number } | null>(null);

  const moveData = async () => {
    const target = movePath.trim();
    if (!target) return;
    const ok = await confirm({
      title: "Move MemoryLane's data?",
      message: (
        <>
          Everything (database, thumbnails, previews, vectors, face crops) is copied to <code className="text-ink">{target}</code> now - about a
          minute per GB, and MemoryLane keeps working meanwhile. Afterwards you restart it to use the new location; the old copy stays until
          you delete it.
        </>
      ),
      confirmLabel: "Copy data",
    });
    if (!ok) return;
    setMoving(true);
    setMoveError(null);
    try {
      const r = await api.settings.moveDataDir(target);
      setMoveDone({ from: r.from, to: r.to, bytes: r.copiedBytes });
      setMovePath("");
      await loadStorage();
    } catch (err) {
      setMoveError(err instanceof ApiError ? err.message : "Move failed");
    } finally {
      setMoving(false);
    }
  };
  const [ignoredPaths, setIgnoredPaths] = useState<IgnoredPathDto[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisStatusDto | null>(null);
  const { theme, setTheme } = useTheme();
  const { confirm, notice } = useConfirm();

  // Live counts come from the AnalysisProgress component (it owns the polling);
  // this copy only drives the provider card and the Retry button.
  const [analysisKey, setAnalysisKey] = useState(0);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);
  const recomputeStacks = async () => {
    const res = await api.stacks.recompute();
    setRecomputeMsg(`Recomputed stacks in ${res.folders} folder(s).`);
  };

  const retryAnalysis = async () => {
    await api.analysis.retryFailed();
    setAnalysisKey((k) => k + 1); // remount the progress view so it polls again
  };

  const loadAll = async () => {
    const [s, st, ip, v] = await Promise.all([
      api.settings.get(),
      api.scans.status(),
      api.ignoredPaths.list(),
      api.settings.version(),
    ]);
    setSettings(s);
    setStatus(st);
    setIgnoredPaths(ip);
    setVersion(v.version);
  };

  const removeIgnoredPath = async (id: number) => {
    await api.ignoredPaths.remove(id);
    setIgnoredPaths((prev) => prev.filter((p) => p.id !== id));
  };

  const loadStorage = async () => {
    setStorageLoading(true);
    try {
      setStorage(await api.settings.storage());
      setStorageError(null);
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : "Could not load storage usage");
    } finally {
      setStorageLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (activeTab === "storage") void loadStorage();
  }, [activeTab]);

  useEffect(() => {
    if (status?.running && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const st = await api.scans.status();
        setStatus(st);
        if (!st.running && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 2000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status?.running]);

  // Scoped to the "Run Scan Now (all folders)" button below - per-folder add/
  // remove/reorder and their own errors now live in ScanFoldersManager.
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const runScanNow = async (scanRootId?: number) => {
    setScheduleError(null);
    try {
      await api.scans.run(scanRootId);
      const st = await api.scans.status();
      setStatus(st);
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : "Could not start scan");
    }
  };

  // The root whose progress should be shown right now - a single-folder
  // "Scan Now" run's own fixed scope, or (for an all-folders run) whichever
  // root the scanner is actively walking at this moment. Either way, this is
  // the id the per-root list below matches against to show progress inline
  // under that specific folder instead of as one undifferentiated block.
  const activeScanRootId = status?.running
    ? (status.currentRun?.scanRootId ?? status.currentRun?.currentScanRootId ?? null)
    : null;

  const updateSchedule = async (patch: Partial<SettingsDto>) => {
    const updated = await api.settings.update(patch);
    setSettings(updated);
    // Toggling AI/People changes what the worker will process next - make the
    // progress view poll again so the bars start moving without a reload.
    if (patch.aiEnabled !== undefined || patch.personsEnabled !== undefined) setAnalysisKey((k) => k + 1);
  };

  if (!settings) return <p className="text-sm text-muted">Loading...</p>;

  return (
    <div className="flex flex-col gap-10">
      <h1 className="font-serif text-2xl font-semibold text-ink">Settings</h1>

      <div className="flex flex-col gap-4 border-b border-border sm:flex-row sm:items-end sm:justify-between">
        <div role="tablist" aria-label="Settings sections" className="order-2 flex min-w-0 gap-5 overflow-x-auto sm:order-1">
          {SETTINGS_TABS.map((tab, index) => (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight") next = (index + 1) % SETTINGS_TABS.length;
                else if (event.key === "ArrowLeft") next = (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = SETTINGS_TABS.length - 1;
                else return;
                event.preventDefault();
                selectTab(SETTINGS_TABS[next].id);
                document.getElementById(`settings-tab-${SETTINGS_TABS[next].id}`)?.focus();
              }}
              className={`shrink-0 border-b-2 px-1 pb-3 pt-2 text-sm font-medium transition-colors focus-visible:outline-accent ${activeTab === tab.id ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <fieldset className="order-1 shrink-0 self-end pb-3 sm:order-2">
          <legend className="mb-2 text-xs font-medium text-ink">Theme</legend>
          <div className="flex gap-2">
            {THEME_ORDER.map((value) => (
              <label key={value} title={THEME_LABELS[value]} className="cursor-pointer">
                <input type="radio" name="theme" value={value} checked={theme === value}
                  onChange={() => setTheme(value)} aria-label={THEME_LABELS[value]} className="peer sr-only" />
                <span className="grid size-8 place-items-center rounded-full border border-border transition peer-checked:border-ink peer-checked:ring-2 peer-checked:ring-border peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
                  <span className="size-5 rounded-full border border-black/10" style={{ background: THEME_SWATCHES[value].page }} />
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">{THEME_LABELS[theme]}</p>
        </fieldset>
      </div>

      <div role="tabpanel" id="settings-panel-folders" aria-labelledby="settings-tab-folders" hidden={activeTab !== "folders"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">Scan Folders</h2>
        <p className="mb-3 text-sm text-muted">
          Add folders containing your photos and videos. MemoryLane never modifies, renames, or moves originals.
        </p>
        <ScanFoldersManager />
        <div className="mt-5">
          <ApplePhotosSyncCard />
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">Ignored Folders</h2>
        <p className="mb-3 text-sm text-muted">
          Folders MemoryLane skips during every scan - click "Ignore folder" while browsing a folder to add it here.
          Removing one from this list doesn't restore anything; it'll be picked up fresh on the next scan.
        </p>
        <ul className="flex flex-col gap-2">
          {ignoredPaths.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-3.5 py-2.5"
            >
              <span className="min-w-0 truncate text-ink" title={p.path}>
                {p.path}
              </span>
              <button
                onClick={() => removeIgnoredPath(p.id)}
                aria-label="Remove from ignore list"
                title="Remove from ignore list"
                className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-ink"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </li>
          ))}
          {ignoredPaths.length === 0 && <li className="text-sm text-muted">No ignored folders.</li>}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">Scanning</h2>
        <div className="mb-4 flex items-center gap-2 text-sm text-ink">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.scanScheduleEnabled}
              onChange={(e) => updateSchedule({ scanScheduleEnabled: e.target.checked })}
              className="accent-accent"
            />
            Scan automatically every
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={settings.scanIntervalDays ?? 7}
            onChange={(e) => updateSchedule({ scanIntervalDays: Number(e.target.value) })}
            disabled={!settings.scanScheduleEnabled}
            className={`w-16 ${inputClass} disabled:opacity-40`}
          />
          days
        </div>

        <button onClick={() => runScanNow()} disabled={status?.running} className={accentButtonClass}>
          {status?.running ? "Scan running..." : "Run Scan Now (all folders)"}
        </button>
        {scheduleError && <p className="mt-2 text-sm text-red-500">{scheduleError}</p>}

        {status && (
          <div className="mt-4 flex flex-col gap-3 text-sm text-muted">
            {/* Per-folder progress is shown inline under each folder above
                (see activeScanRootId/ScanProgress) - this only covers the
                brief window right at the start of a run before the scanner
                has attributed itself to a specific folder yet. */}
            {status.running && activeScanRootId === null && <p>Starting scan...</p>}
            {status.lastRun && !status.running && (
              <p>
                Last scan: {new Date(status.lastRun.startedAt).toLocaleString()} - {status.lastRun.status} -{" "}
                {status.lastRun.filesScanned} scanned, {status.lastRun.filesNew} new, {status.lastRun.filesChanged}{" "}
                changed, {status.lastRun.filesRemoved} removed, {status.lastRun.errorCount} errors.
              </p>
            )}
            {status.lastSuccessfulRun && (
              <p className="text-muted">Last successful scan: {new Date(status.lastSuccessfulRun.startedAt).toLocaleString()}</p>
            )}
          </div>
        )}
      </section>

      </div>

      <div role="tabpanel" id="settings-panel-analysis" aria-labelledby="settings-tab-analysis" hidden={activeTab !== "analysis"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">AI</h2>
        <p className="mb-3 text-sm text-muted">
          An optional local sidecar (<code>memorylane-ai</code>) turns photos into vectors for Find similar, describe-it search,
          smarter stacks, and AI tags. Nothing leaves your machine.
        </p>
        <label className="mb-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={settings.aiEnabled}
            onChange={(e) => updateSchedule({ aiEnabled: e.target.checked })}
            className="accent-accent"
          />
          Analyse photos with the AI sidecar when it's running
        </label>
        {analysis && (
          <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
            {analysis.provider === null && <p className="text-muted">No AI provider configured (MEMORYLANE_AI_PROVIDER=none).</p>}
            {analysis.provider && analysis.provider.reachable && (
              <p className="text-ink">
                <span className="mr-2 inline-block size-2 rounded-full bg-green-500 align-middle" aria-hidden />
                Connected to <code>{analysis.provider.url}</code> · {analysis.provider.model} · {analysis.provider.device}
              </p>
            )}
            {analysis.provider && !analysis.provider.reachable && (
              <div className="text-ink">
                <p>
                  <span className="mr-2 inline-block size-2 rounded-full bg-amber-500 align-middle" aria-hidden />
                  Not connected to <code>{analysis.provider.url}</code>
                  {analysis.provider.lastError ? ` - ${analysis.provider.lastError}` : ""}
                </p>
                <p className="mt-1 text-muted">
                  Start it with <code>npm run ai</code> in a second terminal (see its README). Photos queue up meanwhile and are
                  analysed once it's reachable; this card refreshes within a few seconds.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <section id="running-analysis">
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">Running Analysis</h2>
        <p className="mb-3 text-sm text-muted">
          Background processing that runs after scans - EXIF capture, keywords, stacking, and (when the AI sidecar is
          running) embeddings, photo tags, and faces. Pauses automatically while a scan is running.
        </p>
        {activeTab === "analysis" && <AnalysisProgress key={analysisKey} onStatus={setAnalysis} />}
        {analysis && analysis.analyzers.some((a) => a.counts.failed + a.counts.unsupported > 0) && (
          <div className="mt-3">
            <button onClick={() => void retryAnalysis()} className={buttonClass}>
              Retry failed
            </button>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">People</h2>
        <p className="mb-3 text-sm text-muted">
          Finds faces and groups them into people you can name, then lets you browse "photos of X". Off by default because faces are
          personal data; everything is computed and stored on this machine only, and can be removed in one click.
        </p>
        <label className="mb-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={settings.personsEnabled}
            onChange={(e) => updateSchedule({ personsEnabled: e.target.checked })}
            className="accent-accent"
          />
          Find and group faces (needs the AI sidecar)
        </label>
        <div className="mb-3 flex flex-wrap items-end gap-3 text-sm text-ink">
          <label className="flex flex-col gap-1">
            <span className="text-muted">Face model</span>
            <select
              value={settings.faceModel}
              onChange={async (e) => {
                const next = e.target.value as SettingsDto["faceModel"];
                if (next === settings.faceModel) return;
                const ok = await confirm({
                  title: "Switch face model?",
                  message:
                    "Every photo is re-analysed with the new model - a few minutes per few thousand photos, and a one-time download the first time. Names and your confirmed/rejected faces are kept. Press Regroup once it finishes.",
                  confirmLabel: "Switch model",
                });
                if (ok) void updateSchedule({ faceModel: next });
                else e.target.value = settings.faceModel;
              }}
              className={inputClass}
            >
              <option value="yunet-sface">Standard - YuNet + SFace (open license)</option>
              <option value="buffalo_l">ArcFace - InsightFace buffalo_l (stronger, personal use only)</option>
            </select>
          </label>
          <p className="max-w-xl text-xs text-muted">
            ArcFace tells similar faces (siblings, children) apart much better, costs ~60% more time per photo and a one-time ~190 MB
            download, and its weights are licensed for <em>non-commercial</em> use - fine for your own library, not for redistribution.
            {analysis?.provider && analysis.provider.reachable && !analysis.provider.faceModels.some((m) => m.name === settings.faceModel) && (
              <span className="text-amber-600"> The running sidecar doesn't offer this model - update and restart it (npm run ai).</span>
            )}
          </p>
        </div>
        <details className="rounded-lg border border-border p-4">
          <summary className="mb-3 cursor-pointer text-sm font-medium text-ink">Advanced People settings</summary>
        <p className="mb-2 text-xs text-muted">
          Siblings and young children look alike to the model - if one person collects several kids, raise both strictness values
          (0.55-0.6 is a good start) and press Regroup. Stricter means more small "Person N" entries to merge, which is cheaper than
          un-mixing a wrong one face by face.
        </p>
        <div className="flex flex-wrap items-end gap-4 text-sm text-ink">
          <label className="flex flex-col gap-1">
            <span className="text-muted">Match strictness (min similarity, 0.3-0.9)</span>
            <input
              type="number"
              min={0.3}
              max={0.9}
              step={0.05}
              defaultValue={settings.faceAssignThreshold}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 0.3 && v <= 0.9 && v !== settings.faceAssignThreshold) void updateSchedule({ faceAssignThreshold: v });
              }}
              className={`w-24 ${inputClass}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Faces needed to create a person (2-20)</span>
            <input
              type="number"
              min={2}
              max={20}
              step={1}
              defaultValue={settings.faceMinClusterSize}
              onBlur={(e) => {
                const v = Math.round(Number(e.target.value));
                if (v >= 2 && v <= 20 && v !== settings.faceMinClusterSize) void updateSchedule({ faceMinClusterSize: v });
              }}
              className={`w-24 ${inputClass}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Grouping strictness (0.3-0.9)</span>
            <input
              type="number"
              min={0.3}
              max={0.9}
              step={0.05}
              defaultValue={settings.faceLinkThreshold}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 0.3 && v <= 0.9 && v !== settings.faceLinkThreshold) void updateSchedule({ faceLinkThreshold: v });
              }}
              className={`w-24 ${inputClass}`}
            />
          </label>
          <button
            className={buttonClass}
            title="Regroup all automatically grouped faces with the current settings. Names and your ✓/✗ answers are kept."
            onClick={async () => {
              const ok = await confirm({
                title: "Regroup faces?",
                message: "Automatic groupings are redone with the current strictness. Names and your confirmed/rejected faces are kept.",
                confirmLabel: "Regroup",
              });
              if (!ok) return;
              const r = await api.persons.regroup();
              await notice({ title: "Regrouped", message: `${r.persons} new ${r.persons === 1 ? "person" : "people"}, ${r.assigned} faces assigned.` });
            }}
          >
            Regroup with these settings
          </button>
          <button
            className={`${buttonClass} text-red-600`}
            onClick={async () => {
              const ok = await confirm({
                title: "Delete all face data?",
                message: "People, faces and their vectors are removed. Your photos are untouched. Faces are detected again only while People is on.",
                confirmLabel: "Delete face data",
                danger: true,
              });
              if (ok) {
                await api.persons.deleteAllData();
                setAnalysisKey((k) => k + 1);
              }
            }}
          >
            Delete all face data
          </button>
        </div>
        </details>
      </section>

      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">Stacks</h2>
        <p className="mb-3 text-sm text-muted">
          Bursts (same camera, within the burst gap, visually alike) and tripod series (long exposures minutes apart that look
          near-identical, within the series gap) are grouped into one grid item. Stacks you edit are never regrouped automatically.
        </p>
        <details className="rounded-lg border border-border p-4">
          <summary className="mb-3 cursor-pointer text-sm font-medium text-ink">Advanced stack settings</summary>
        <div className="flex flex-wrap items-end gap-4 text-sm text-ink">
          <label className="flex flex-col gap-1">
            <span className="text-muted">Burst gap (seconds)</span>
            <input
              type="number"
              min={0.1}
              max={60}
              step={0.5}
              defaultValue={settings.stackGapSeconds}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v > 0 && v !== settings.stackGapSeconds) void updateSchedule({ stackGapSeconds: v });
              }}
              className={`w-24 ${inputClass}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Visual similarity (max hash distance, 0-64)</span>
            <input
              type="number"
              min={0}
              max={64}
              step={1}
              defaultValue={settings.stackMaxHamming}
              onBlur={(e) => {
                const v = Math.round(Number(e.target.value));
                if (v >= 0 && v <= 64 && v !== settings.stackMaxHamming) void updateSchedule({ stackMaxHamming: v });
              }}
              className={`w-24 ${inputClass}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">AI similarity (min cosine, 0.5-1)</span>
            <input
              type="number"
              min={0.5}
              max={1}
              step={0.01}
              defaultValue={settings.stackMinCosine}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 0.5 && v <= 1 && v !== settings.stackMinCosine) void updateSchedule({ stackMinCosine: v });
              }}
              className={`w-24 ${inputClass}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Tripod series gap (seconds)</span>
            <input
              type="number"
              min={0}
              max={3600}
              step={10}
              defaultValue={settings.stackSeriesGapSeconds}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 0 && v <= 3600 && v !== settings.stackSeriesGapSeconds) void updateSchedule({ stackSeriesGapSeconds: v });
              }}
              className={`w-24 ${inputClass}`}
            />
          </label>
          <button onClick={() => void recomputeStacks()} className={buttonClass}>
            Recompute all stacks
          </button>
        </div>
        {recomputeMsg && <p className="mt-2 text-sm text-muted">{recomputeMsg}</p>}
        </details>
      </section>

      </div>

      <div role="tabpanel" id="settings-panel-plugins" aria-labelledby="settings-tab-plugins" hidden={activeTab !== "plugins"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
        {activeTab === "plugins" && <PluginsSettings />}
      </div>

      <div role="tabpanel" id="settings-panel-storage" aria-labelledby="settings-tab-storage" hidden={activeTab !== "storage"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="font-serif text-lg font-semibold text-ink">Storage</h2>
          <button onClick={loadStorage} disabled={storageLoading} className={buttonClass}>
            {storageLoading ? "Calculating..." : "Refresh"}
          </button>
        </div>
        <p className="mb-3 text-sm text-muted">
          MemoryLane's own cache and index - entirely separate from your photo folders, and safe to delete and
          rebuild via a rescan at any time.
        </p>
        {storageError && <p role="alert" className="mb-3 text-sm text-red-500">{storageError}</p>}
        {storage ? (
          <>
            <div className="mb-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm">
              <div className="text-xs uppercase tracking-wide text-muted">Location</div>
              <code className="break-all text-ink">{storage.dataDir}</code>
              <div className="mt-1 text-xs text-muted">
                {storage.dataDirSource === "env" && "Set by MEMORYLANE_DATA_DIR in the environment."}
                {storage.dataDirSource === "pointer" && "Chosen under Settings (the default location holds a pointer to it)."}
                {storage.dataDirSource === "default" && "The OS default location."}
              </div>
              {storage.pendingMoveTo && (
                <p className="mt-2 rounded-md bg-amber-500/15 px-2.5 py-1.5 text-xs text-amber-700">
                  Data was copied to <code>{storage.pendingMoveTo}</code>. Restart MemoryLane to use it; the copy here can be deleted afterwards.
                </p>
              )}
            </div>
            <ul className="flex flex-col gap-2">
              {[
                ["Previews (RAW fullscreen)", storage.previewsBytes],
                ["Thumbnail cache", storage.thumbnailCacheBytes],
                ["Database (index, EXIF, embeddings)", storage.databaseBytes],
                ["Vector index", storage.vectorsBytes],
                ["Face crops", storage.facesBytes],
                ["Logs", storage.logsBytes],
              ].map(([label, bytes]) => (
                <li key={label as string} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3.5 py-2.5">
                  <span className="text-ink">{label}</span>
                  <span className="text-muted tabular-nums">{formatBytes(bytes as number)}</span>
                </li>
              ))}
              <li className="flex items-center justify-between rounded-lg border border-accent bg-surface px-3.5 py-2.5 font-medium">
                <span className="text-ink">Total</span>
                <span className="text-ink tabular-nums">{formatBytes(storage.totalBytes)}</span>
              </li>
            </ul>
            {storage.dataDirSource !== "env" && (
              <div className="mt-4 flex flex-col gap-2 text-sm">
                <span className="text-muted">Move to another disk (an empty folder, e.g. <code>/Volumes/External/MemoryLane</code> or <code>D:\\MemoryLane</code>)</span>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={movePath}
                    onChange={(e) => setMovePath(e.target.value)}
                    placeholder="/absolute/path/to/empty/folder"
                    className={`min-w-0 flex-1 ${inputClass}`}
                  />
                  <button onClick={() => void moveData()} disabled={moving || !movePath.trim()} className={buttonClass}>
                    {moving ? "Copying…" : "Move data here"}
                  </button>
                </div>
                {moveError && <p className="text-red-600">{moveError}</p>}
                {moveDone && (
                  <p className="text-muted">
                    Copied {formatBytes(moveDone.bytes)} to <code>{moveDone.to}</code>. <strong className="text-ink">Restart MemoryLane</strong> to switch;
                    then delete <code>{moveDone.from}</code> to free the space.
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">{storageLoading ? "Calculating..." : "Use Refresh to calculate storage usage."}</p>
        )}
      </section>

      </div>

      <div role="tabpanel" id="settings-panel-service" aria-labelledby="settings-tab-service" hidden={activeTab !== "service"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
        <section className="max-w-3xl space-y-6">
          <div>
            <h2 className="mb-2 font-serif text-lg font-semibold text-ink">MemoryLane Museum Service</h2>
            <p className="text-sm text-muted">Control the local service and how it can be reached. Network changes take effect after MemoryLane is restarted.</p>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
            <input
              type="checkbox"
              checked={settings.museumServiceEnabled}
              onChange={(event) => void updateSchedule({ museumServiceEnabled: event.target.checked })}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              <span className="block text-sm font-medium text-ink">Enable MemoryLane Museum Service</span>
              <span className="mt-1 block text-sm text-muted">Enabled by default. Turn this off when the museum service is not needed.</span>
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
            <input
              type="checkbox"
              checked={settings.bindAddress === "0.0.0.0"}
              disabled={!settings.museumServiceEnabled}
              onChange={(event) => void updateSchedule({ bindAddress: event.target.checked ? "0.0.0.0" : "127.0.0.1" })}
              className="mt-1 size-4 accent-accent disabled:opacity-50"
            />
            <span>
              <span className="block text-sm font-medium text-ink">Bind to all network interfaces</span>
              <span className="mt-1 block text-sm text-muted">
                Off by default, so MemoryLane is available only on this computer. Enable the Museum Service first, then restart MemoryLane to apply this change.
              </span>
            </span>
          </label>
        </section>
      </div>

      <div role="tabpanel" id="settings-panel-account" aria-labelledby="settings-tab-account" hidden={activeTab !== "account"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">Account</h2>
        {user && <p className="mb-3 text-sm text-muted">Signed in as <span className="font-medium text-ink">{user.username}</span></p>}
        <ChangePasswordForm />
      </section>
      </div>

      <div role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about" hidden={activeTab !== "about"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
        <section className="max-w-3xl space-y-6">
          <div>
            <h2 className="flex items-center gap-3 font-serif text-2xl font-semibold text-ink">
              <img src="/icon-32.png" alt="" className="size-8 shrink-0" />
              <span>MemoryLane{version ? ` v${version}` : ""}</span>
            </h2>
            <p className="mt-1 text-sm text-muted">A love letter to the art of photography.</p>
          </div>

          <div className="space-y-1 text-sm">
            <p className="font-medium text-ink">Free, MIT Licensed</p>
            <p className="text-muted">
              Original Authors: <span className="text-ink">Madhan Kanagavel, Anis Abdul</span>
            </p>
          </div>

          <div>
            <h3 className="mb-2 font-serif text-lg font-semibold text-ink">Other Licenses and Attributions</h3>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-surface p-4 text-sm leading-6 text-muted" tabIndex={0}>
              <p>MemoryLane is built with open-source software. Key components include:</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li><strong className="text-ink">React, React DOM, React Router, Fastify, better-sqlite3, Argon2, Zod, Nano ID, bmp-js, open, and p-limit</strong> — MIT License.</li>
                <li><strong className="text-ink">Lucide</strong> — ISC License.</li>
                <li><strong className="text-ink">dotenv</strong> — BSD 2-Clause License.</li>
                <li><strong className="text-ink">Sharp and its bundled libvips distribution</strong> — Apache License 2.0 and LGPL v3 or later, respectively.</li>
                <li><strong className="text-ink">ExifTool and exiftool-vendored</strong> — ExifTool is available under the Perl Artistic License or GNU GPL; its Node wrapper is MIT licensed.</li>
                <li><strong className="text-ink">FFmpeg</strong> — bundled through ffmpeg-static under the GNU GPL v3 or later. FFprobe is distributed with its applicable FFmpeg license; the ffprobe-static wrapper is MIT licensed.</li>
                <li><strong className="text-ink">Go systray</strong> and its supporting Go libraries power the desktop tray application under their respective open-source licenses.</li>
              </ul>
              <p className="mt-4">Optional plugins may include additional libraries, models, and license terms. Their license notices are distributed with each plugin package.</p>
              <p className="mt-4">Copyright and license notices for bundled dependencies remain the property of their respective authors and contributors. Full license texts are included with the distributed software where required.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
