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
import { useTranslation } from "react-i18next";
import { languagePreference, setLanguage, type SupportedLanguage } from "../i18n";

const SETTINGS_TABS = [
  { id: "folders", labelKey: "settings.folders" },
  { id: "analysis", labelKey: "settings.analysis" },
  { id: "plugins", labelKey: "settings.plugins" },
  { id: "storage", labelKey: "settings.storage" },
  { id: "network", labelKey: "settings.network" },
  { id: "account", labelKey: "settings.account" },
  { id: "about", labelKey: "settings.about" },
] as const;
const THEME_ORDER: Theme[] = ["light", "dusk", "gallery", "dark"];

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
  const { t } = useTranslation();
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
      setError(t("settingsUi.passwordMismatch"));
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
      setError(err instanceof ApiError ? err.message : t("settingsUi.passwordFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)} className="text-sm font-medium text-accent hover:underline">
        {t("auth.changePassword")}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
      <input
        type="password"
        autoComplete="current-password"
        placeholder={t("auth.currentPassword")}
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        required
        className={inputClass}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder={t("settingsUi.newPasswordHint")}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        minLength={8}
        required
        className={inputClass}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder={t("settingsUi.confirmNewPassword")}
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        minLength={8}
        required
        className={inputClass}
      />
      {error && <p className="text-sm text-red-500">{error}</p>}
      {success && <p className="text-sm text-green-600">{t("settingsUi.passwordChanged")}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className={accentButtonClass}>
          {submitting ? t("settingsUi.changing") : t("auth.changePassword")}
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
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
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
      title: t("settingsUi.moveTitle"),
      message: (
        <>
          {t("settingsUi.moveMessageBefore")} <code className="text-ink">{target}</code> {t("settingsUi.moveMessageAfter")}
        </>
      ),
      confirmLabel: t("settingsUi.copyData"),
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
      setMoveError(err instanceof ApiError ? err.message : t("settingsUi.moveFailed"));
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
    setRecomputeMsg(t("settingsUi.recomputed", { count: res.folders }));
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
      setStorageError(err instanceof Error ? err.message : t("settingsUi.storageFailed"));
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
      setScheduleError(err instanceof ApiError ? err.message : t("scanning.scanFailed"));
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

  if (!settings) return <p className="text-sm text-muted">{t("common.loading")}</p>;

  return (
    <div className="flex flex-col gap-10">
      <h1 className="font-serif text-2xl font-semibold text-ink">{t("settings.title")}</h1>

      <div className="flex flex-col gap-4 border-b border-border sm:flex-row sm:items-end sm:justify-between">
        <div role="tablist" aria-label={t("settings.sections")} className="order-2 flex min-w-0 gap-5 overflow-x-auto sm:order-1">
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
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <div className="order-1 flex shrink-0 items-end gap-4 self-end pb-3 sm:order-2">
        <label className="text-xs font-medium text-ink">
          <span className="mb-2 block">{t("common.language")}</span>
          <select
            value={languagePreference()}
            onChange={(event) => void setLanguage(event.target.value as SupportedLanguage | "system")}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink"
            aria-label={t("common.language")}
          >
            <option value="system">{t("common.systemDefault")}</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
          </select>
        </label>
        <fieldset className="text-xs font-medium text-ink">
          <legend className="mb-2">{t("settings.theme")} <span className="font-normal text-muted">· {t(`settingsUi.theme.${theme}`)}</span></legend>
          <div className="flex gap-2">
            {THEME_ORDER.map((value) => (
              <label key={value} title={t(`settingsUi.theme.${value}`)} className="cursor-pointer">
                <input type="radio" name="theme" value={value} checked={theme === value}
                  onChange={() => setTheme(value)} aria-label={t(`settingsUi.theme.${value}`)} className="peer sr-only" />
                <span className="grid size-8 place-items-center rounded-full border border-border transition peer-checked:border-ink peer-checked:ring-2 peer-checked:ring-border peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
                  <span className="size-5 rounded-full border border-black/10" style={{ background: THEME_SWATCHES[value].page }} />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        </div>
      </div>

      <div role="tabpanel" id="settings-panel-folders" aria-labelledby="settings-tab-folders" hidden={activeTab !== "folders"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">{t("settings.scanFolders")}</h2>
        <p className="mb-3 text-sm text-muted">
          {t("settingsUi.scanFoldersHelp")}
        </p>
        <ScanFoldersManager />
        <div className="mt-5">
          <ApplePhotosSyncCard />
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">{t("settings.scanning")}</h2>
        <div className="mb-4 flex items-center gap-2 text-sm text-ink">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.scanScheduleEnabled}
              onChange={(e) => updateSchedule({ scanScheduleEnabled: e.target.checked })}
              className="accent-accent"
            />
            {t("settingsUi.scanEvery")}
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
          {t("settingsUi.days")}
        </div>

        <button onClick={() => runScanNow()} disabled={status?.running} className={accentButtonClass}>
          {status?.running ? t("settingsUi.scanRunning") : t("settingsUi.runAll")}
        </button>
        {scheduleError && <p className="mt-2 text-sm text-red-500">{scheduleError}</p>}

        {status && (
          <div className="mt-4 flex flex-col gap-3 text-sm text-muted">
            {/* Per-folder progress is shown inline under each folder above
                (see activeScanRootId/ScanProgress) - this only covers the
                brief window right at the start of a run before the scanner
                has attributed itself to a specific folder yet. */}
            {status.running && activeScanRootId === null && <p>{t("settingsUi.startingScan")}</p>}
            {status.lastRun && !status.running && (
              <p>
                {t("settingsUi.lastScan", { date: new Date(status.lastRun.startedAt).toLocaleString(), status: status.lastRun.status, scanned: status.lastRun.filesScanned, newCount: status.lastRun.filesNew, changed: status.lastRun.filesChanged, removed: status.lastRun.filesRemoved, errors: status.lastRun.errorCount })}
              </p>
            )}
            {status.lastSuccessfulRun && (
              <p className="text-muted">{t("settingsUi.lastSuccessful", { date: new Date(status.lastSuccessfulRun.startedAt).toLocaleString() })}</p>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">{t("settings.ignoredFolders")}</h2>
        <p className="mb-3 text-sm text-muted">
          {t("settingsUi.ignoredHelp")}
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
                aria-label={t("settings.removeIgnored")}
                title={t("settings.removeIgnored")}
                className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-ink"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </li>
          ))}
          {ignoredPaths.length === 0 && <li className="text-sm text-muted">{t("settingsUi.noIgnored")}</li>}
        </ul>
      </section>

      </div>

      <div role="tabpanel" id="settings-panel-analysis" aria-labelledby="settings-tab-analysis" hidden={activeTab !== "analysis"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">{t("settingsAnalysis.ai")}</h2>
        <p className="mb-3 text-sm text-muted">
          {t("settingsAnalysis.aiIntroBefore")} <code>memorylane-ai</code> {t("settingsAnalysis.aiIntroAfter")}
        </p>
        <label className="mb-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={settings.aiEnabled}
            onChange={(e) => updateSchedule({ aiEnabled: e.target.checked })}
            className="accent-accent"
          />
          {t("settingsAnalysis.analyseAi")}
        </label>
        {analysis && (
          <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
            {analysis.provider === null && <p className="text-muted">{t("settingsAnalysis.noProvider")}</p>}
            {analysis.provider && analysis.provider.reachable && (
              <p className="text-ink">
                <span className="mr-2 inline-block size-2 rounded-full bg-green-500 align-middle" aria-hidden />
                {t("settingsAnalysis.connected")} <code>{analysis.provider.url}</code> · {analysis.provider.model} · {analysis.provider.device}
              </p>
            )}
            {analysis.provider && !analysis.provider.reachable && (
              <div className="text-ink">
                <p>
                  <span className="mr-2 inline-block size-2 rounded-full bg-amber-500 align-middle" aria-hidden />
                  {t("settingsAnalysis.notConnected")} <code>{analysis.provider.url}</code>
                  {analysis.provider.lastError ? ` - ${analysis.provider.lastError}` : ""}
                </p>
                <p className="mt-1 text-muted">
                  {t("settingsAnalysis.startBefore")} <code>npm run ai</code> {t("settingsAnalysis.startAfter")}
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <section id="running-analysis">
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">{t("settings.runningAnalysis")}</h2>
        <p className="mb-3 text-sm text-muted">
          {t("settingsAnalysis.backgroundHelp")}
        </p>
        {activeTab === "analysis" && <AnalysisProgress key={analysisKey} onStatus={setAnalysis} />}
        {analysis && analysis.analyzers.some((a) => a.counts.failed + a.counts.unsupported > 0) && (
          <div className="mt-3">
            <button onClick={() => void retryAnalysis()} className={buttonClass}>
              {t("settingsAnalysis.retryFailed")}
            </button>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">{t("settings.people")}</h2>
        <p className="mb-3 text-sm text-muted">
          {t("settingsAnalysis.peopleHelp")}
        </p>
        <label className="mb-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={settings.personsEnabled}
            onChange={(e) => updateSchedule({ personsEnabled: e.target.checked })}
            className="accent-accent"
          />
          {t("settingsAnalysis.findFaces")}
        </label>
        <div className="mb-3 flex flex-wrap items-end gap-3 text-sm text-ink">
          <label className="flex flex-col gap-1">
            <span className="text-muted">{t("settingsAnalysis.faceModel")}</span>
            <select
              value={settings.faceModel}
              onChange={async (e) => {
                const next = e.target.value as SettingsDto["faceModel"];
                if (next === settings.faceModel) return;
                const ok = await confirm({
                  title: t("settingsAnalysis.switchTitle"), message: t("settingsAnalysis.switchMessage"), confirmLabel: t("settingsAnalysis.switchModel"),
                });
                if (ok) void updateSchedule({ faceModel: next });
                else e.target.value = settings.faceModel;
              }}
              className={inputClass}
            >
              <option value="yunet-sface">{t("settingsAnalysis.standardModel")}</option>
              <option value="buffalo_l">{t("settingsAnalysis.arcfaceModel")}</option>
            </select>
          </label>
          <p className="max-w-xl text-xs text-muted">
            {t("settingsAnalysis.arcfaceHelp")}
            {analysis?.provider && analysis.provider.reachable && !analysis.provider.faceModels.some((m) => m.name === settings.faceModel) && (
              <span className="text-amber-600"> {t("settingsAnalysis.modelUnavailable")}</span>
            )}
          </p>
        </div>
        <details className="rounded-lg border border-border p-4">
          <summary className="mb-3 cursor-pointer text-sm font-medium text-ink">{t("settingsAnalysis.advancedPeople")}</summary>
        <p className="mb-2 text-xs text-muted">
          {t("settingsAnalysis.peopleAdvancedHelp")}
        </p>
        <div className="flex flex-wrap items-end gap-4 text-sm text-ink">
          <label className="flex flex-col gap-1">
            <span className="text-muted">{t("settingsAnalysis.matchStrictness")}</span>
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
            <span className="text-muted">{t("settingsAnalysis.facesNeeded")}</span>
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
            <span className="text-muted">{t("settingsAnalysis.groupStrictness")}</span>
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
            title={t("settingsAnalysis.regroupTitleHelp")}
            onClick={async () => {
              const ok = await confirm({
                title: t("settingsAnalysis.regroupTitle"), message: t("settingsAnalysis.regroupMessage"), confirmLabel: t("settingsAnalysis.regroup"),
              });
              if (!ok) return;
              const r = await api.persons.regroup();
              await notice({ title: t("settingsAnalysis.regrouped"), message: t("settingsAnalysis.regroupedMessage", { count: r.persons, assigned: r.assigned }) });
            }}
          >
            {t("settingsAnalysis.regroupSettings")}
          </button>
          <button
            className={`${buttonClass} text-red-600`}
            onClick={async () => {
              const ok = await confirm({
                title: t("settingsAnalysis.deleteTitle"), message: t("settingsAnalysis.deleteMessage"), confirmLabel: t("settingsAnalysis.deleteFaceData"),
                danger: true,
              });
              if (ok) {
                await api.persons.deleteAllData();
                setAnalysisKey((k) => k + 1);
              }
            }}
          >
            {t("settingsAnalysis.deleteAll")}
          </button>
        </div>
        </details>
      </section>

      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">{t("settings.stacks")}</h2>
        <p className="mb-3 text-sm text-muted">
          {t("settingsAnalysis.stacksHelp")}
        </p>
        <details className="rounded-lg border border-border p-4">
          <summary className="mb-3 cursor-pointer text-sm font-medium text-ink">{t("settingsAnalysis.advancedStacks")}</summary>
        <div className="flex flex-wrap items-end gap-4 text-sm text-ink">
          <label className="flex flex-col gap-1">
            <span className="text-muted">{t("settingsAnalysis.burstGap")}</span>
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
            <span className="text-muted">{t("settingsAnalysis.visualSimilarity")}</span>
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
            <span className="text-muted">{t("settingsAnalysis.aiSimilarity")}</span>
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
            <span className="text-muted">{t("settingsAnalysis.tripodGap")}</span>
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
            {t("settingsAnalysis.recompute")}
          </button>
        </div>
        {recomputeMsg && <p className="mt-2 text-sm text-muted">{recomputeMsg}</p>}
        </details>
      </section>

      </div>

      <div role="tabpanel" id="settings-panel-plugins" aria-labelledby="settings-tab-plugins" hidden={activeTab !== "plugins"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
        <section className="max-w-3xl space-y-3">
          <div>
            <h2 className="font-serif text-lg font-semibold text-ink">{t("settings.museumTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("settings.museumIntro")}</p>
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
            <input
              type="checkbox"
              checked={settings.museumServiceEnabled}
              onChange={(event) => void updateSchedule({ museumServiceEnabled: event.target.checked })}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              <span className="block text-sm font-medium text-ink">{t("settings.museumEnable")}</span>
              <span className="mt-1 block text-sm text-muted">{t("settings.museumHelp")}</span>
            </span>
          </label>
        </section>
        {activeTab === "plugins" && <PluginsSettings />}
      </div>

      <div role="tabpanel" id="settings-panel-storage" aria-labelledby="settings-tab-storage" hidden={activeTab !== "storage"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="font-serif text-lg font-semibold text-ink">{t("settings.storage")}</h2>
          <button onClick={loadStorage} disabled={storageLoading} className={buttonClass}>
            {storageLoading ? t("settingsStorage.calculating") : t("common.refresh")}
          </button>
        </div>
        <p className="mb-3 text-sm text-muted">
          {t("settingsStorage.intro")}
        </p>
        {storageError && <p role="alert" className="mb-3 text-sm text-red-500">{storageError}</p>}
        {storage ? (
          <>
            <div className="mb-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm">
              <div className="text-xs uppercase tracking-wide text-muted">{t("settingsStorage.location")}</div>
              <code className="break-all text-ink">{storage.dataDir}</code>
              <div className="mt-1 text-xs text-muted">
                {storage.dataDirSource === "env" && t("settingsStorage.sourceEnv")}
                {storage.dataDirSource === "pointer" && t("settingsStorage.sourcePointer")}
                {storage.dataDirSource === "default" && t("settingsStorage.sourceDefault")}
              </div>
              {storage.pendingMoveTo && (
                <p className="mt-2 rounded-md bg-amber-500/15 px-2.5 py-1.5 text-xs text-amber-700">
                  {t("settingsStorage.pendingBefore")} <code>{storage.pendingMoveTo}</code>. {t("settingsStorage.pendingAfter")}
                </p>
              )}
            </div>
            <ul className="flex flex-col gap-2">
              {[
                [t("settingsStorage.previews"), storage.previewsBytes],
                [t("settingsStorage.thumbnails"), storage.thumbnailCacheBytes],
                [t("settingsStorage.database"), storage.databaseBytes],
                [t("settingsStorage.vectors"), storage.vectorsBytes],
                [t("settingsStorage.faces"), storage.facesBytes],
                [t("settingsStorage.logs"), storage.logsBytes],
              ].map(([label, bytes]) => (
                <li key={label as string} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3.5 py-2.5">
                  <span className="text-ink">{label}</span>
                  <span className="text-muted tabular-nums">{formatBytes(bytes as number)}</span>
                </li>
              ))}
              <li className="flex items-center justify-between rounded-lg border border-accent bg-surface px-3.5 py-2.5 font-medium">
                <span className="text-ink">{t("settingsStorage.total")}</span>
                <span className="text-ink tabular-nums">{formatBytes(storage.totalBytes)}</span>
              </li>
            </ul>
            {storage.dataDirSource !== "env" && (
              <div className="mt-4 flex flex-col gap-2 text-sm">
                <span className="text-muted">{t("settingsStorage.moveHelp")} <code>/Volumes/External/MemoryLane</code> {t("settingsStorage.or")} <code>D:\\MemoryLane</code>)</span>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={movePath}
                    onChange={(e) => setMovePath(e.target.value)}
                    placeholder={t("settingsStorage.pathPlaceholder")}
                    className={`min-w-0 flex-1 ${inputClass}`}
                  />
                  <button onClick={() => void moveData()} disabled={moving || !movePath.trim()} className={buttonClass}>
                    {moving ? t("settingsStorage.copying") : t("settingsStorage.moveHere")}
                  </button>
                </div>
                {moveError && <p className="text-red-600">{moveError}</p>}
                {moveDone && (
                  <p className="text-muted">
                    {t("settingsStorage.copied", { bytes: formatBytes(moveDone.bytes) })} <code>{moveDone.to}</code>. <strong className="text-ink">{t("settingsStorage.restart")}</strong> {t("settingsStorage.switchThenDelete")} <code>{moveDone.from}</code> {t("settingsStorage.freeSpace")}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">{storageLoading ? t("settingsStorage.calculating") : t("settingsStorage.useRefresh")}</p>
        )}
      </section>

      </div>

      <div role="tabpanel" id="settings-panel-network" aria-labelledby="settings-tab-network" hidden={activeTab !== "network"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
        <section className="max-w-3xl space-y-6">
          <div>
            <h2 className="mb-2 font-serif text-lg font-semibold text-ink">{t("settings.network")}</h2>
            <p className="text-sm text-muted">{t("settings.networkIntro")}</p>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
            <input
              type="checkbox"
              checked={settings.bindAddress === "0.0.0.0"}
              onChange={(event) => void updateSchedule({ bindAddress: event.target.checked ? "0.0.0.0" : "127.0.0.1" })}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              <span className="block text-sm font-medium text-ink">{t("settings.allowRemote")}</span>
              <span className="mt-1 block text-sm text-muted">
                {t("settings.allowRemoteHelp")}
              </span>
            </span>
          </label>
        </section>
      </div>

      <div role="tabpanel" id="settings-panel-account" aria-labelledby="settings-tab-account" hidden={activeTab !== "account"} tabIndex={0} className="space-y-8 focus-visible:outline-accent">
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold text-ink">{t("settings.accountHeading")}</h2>
        {user && <p className="mb-3 text-sm text-muted">{t("settings.signedInAs", { username: user.username })}</p>}
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
            <p className="mt-1 text-sm text-muted">{t("settingsAbout.tagline")}</p>
          </div>

          <div className="space-y-1 text-sm">
            <p className="font-medium text-ink">{t("settingsAbout.free")}</p>
            <p className="text-muted">
              {t("settingsAbout.authors")} <span className="text-ink">Madhan Kanagavel, Anis Abdul</span>
            </p>
          </div>

          <div>
            <h3 className="mb-2 font-serif text-lg font-semibold text-ink">{t("settingsAbout.licenses")}</h3>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-surface p-4 text-sm leading-6 text-muted" tabIndex={0}>
              <p>{t("settingsAbout.openSource")}</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>{t("settingsAbout.licenseMit")}</li>
                <li>{t("settingsAbout.licenseLucide")}</li>
                <li>{t("settingsAbout.licenseDotenv")}</li>
                <li>{t("settingsAbout.licenseSharp")}</li>
                <li>{t("settingsAbout.licenseExif")}</li>
                <li>{t("settingsAbout.licenseFfmpeg")}</li>
                <li>{t("settingsAbout.licenseTray")}</li>
              </ul>
              <p className="mt-4">{t("settingsAbout.plugins")}</p>
              <p className="mt-4">{t("settingsAbout.copyright")}</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
