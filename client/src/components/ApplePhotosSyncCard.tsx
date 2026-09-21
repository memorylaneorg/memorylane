import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApplePhotosSyncStatusDto, PluginDto, ScanRootDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import { isPluginActive } from "../utils/plugins";
import { useConfirm } from "./ConfirmDialog";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-40";

function syncSummary(status: ApplePhotosSyncStatusDto | undefined, t: TFunction): string {
  if (!status) return t("applePhotos.notSynced");
  if (status.status === "running" && status.total === 0) {
    const started = status.startedAt ? Date.parse(status.startedAt) : NaN;
    const elapsed = Number.isFinite(started) ? t("applePhotos.elapsed", { seconds: Math.max(0, Math.floor((Date.now() - started) / 1000)) }) : "";
    return t("applePhotos.preparing", { elapsed });
  }
  return t("applePhotos.syncSummary", { processed: status.processed.toLocaleString(), total: status.total.toLocaleString(), status: status.status }) + (status.failed ? t("applePhotos.skipped", { count: status.failed.toLocaleString() }) : "");
}

interface PanelProps {
  plugin: PluginDto;
  roots: ScanRootDto[];
  statuses: Record<number, ApplePhotosSyncStatusDto>;
  helperStatus: string | null;
  libraryPath: string;
  busy: boolean;
  onToggle?: () => void;
  onPathChange: (path: string) => void;
  onAdd: (event: FormEvent) => void;
  onSync: (rootId: number) => void;
  detected?: { path: string; readable: boolean; reason?: string }[];
  onChooseDetected?: (path: string) => void;
}

export function ApplePhotosPluginPanel(props: PanelProps) {
  const { t } = useTranslation();
  const { plugin, roots, statuses, helperStatus, libraryPath, busy, onPathChange, onAdd, onSync } = props;
  return (
    <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink">{t("applePhotos.title")}</h2>
          <p className="text-sm text-muted">{t("applePhotos.readOnly")}</p>
        </div>
        {!plugin.available && <span className="text-sm text-muted">{t("applePhotos.unavailablePlatform")}</span>}
      </div>
      {plugin.enabled && (
        <div className="space-y-5 border-t border-border pt-5">
          <div className="space-y-1 text-sm text-muted">
            <p>{t("applePhotos.service", { status: helperStatus ?? t("applePhotos.checking") })}</p>
            <p>{t("applePhotos.permissionHint")}</p>
          </div>
          <form onSubmit={onAdd} className="flex flex-wrap gap-2">
            <label className="sr-only" htmlFor="apple-photos-library-path">{t("applePhotos.path")}</label>
            <input id="apple-photos-library-path" value={libraryPath} onChange={(event) => onPathChange(event.target.value)}
              placeholder="/Users/you/Pictures/Photos Library.photoslibrary" className="min-w-64 flex-1 rounded-md border border-border bg-page px-3 py-2 text-sm text-ink" />
            <button type="submit" className={buttonClass} disabled={busy || !libraryPath.trim()}>{t("applePhotos.addLibrary")}</button>
          </form>
          {(props.detected ?? []).filter((item) => !roots.some((root) => root.path === item.path)).map((item) => (
            <div key={item.path} className="flex flex-wrap items-start gap-2 text-sm text-muted">
              <span className="break-all">{t("applePhotos.detected", { path: item.path })}</span>
              {item.readable ? <button type="button" className={buttonClass} onClick={() => props.onChooseDetected?.(item.path)}>{t("applePhotos.usePath")}</button>
                : <div className="space-y-1 text-red-500">
                  <p>{item.reason}</p>
                  {/operation not permitted|permission/i.test(item.reason ?? "") && <p>
                    {t("applePhotos.fullDiskAccess")}
                  </p>}
                </div>}
            </div>
          ))}
          <div className="space-y-3">
            {roots.length === 0 && <p className="text-sm text-muted">{t("applePhotos.noLibraries")}</p>}
            {roots.map((root) => {
              const status = statuses[root.id];
              return <div key={root.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="break-all text-sm text-ink">{root.path}</p>
                  <p className="text-xs text-muted">{t("applePhotos.indexed", { count: root.stats.mediaCount.toLocaleString(), summary: syncSummary(status, t) })}</p>
                  {status && <p className="text-xs text-muted">{t("applePhotos.availability", { previewOnly: status.previewOnly.toLocaleString(), unavailable: status.unavailable.toLocaleString() })}</p>}
                  {status?.error && <p className="text-xs text-red-500">{t("applePhotos.previousError", { error: status.error })}</p>}
                </div>
                <button type="button" className={buttonClass} disabled={busy || !root.enabled || status?.status === "running"} onClick={() => onSync(root.id)}>{t("applePhotos.syncNow")}</button>
              </div>;
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export default function ApplePhotosSyncCard() {
  const { t } = useTranslation();
  const { notice } = useConfirm();
  const [visible, setVisible] = useState(false);
  const [roots, setRoots] = useState<ScanRootDto[]>([]);
  const [statuses, setStatuses] = useState<Record<number, ApplePhotosSyncStatusDto>>({});
  const [helperStatus, setHelperStatus] = useState<string | null>(null);
  const [detected, setDetected] = useState<{ path: string; readable: boolean; reason?: string }[]>([]);
  const [libraryPath, setLibraryPath] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [legacyPlugins, platformPlugins] = await Promise.all([api.plugins.list(), api.pluginPlatform.list()]);
    const enabled = legacyPlugins.some((item) => item.id === "apple-photos" && item.enabled)
      && platformPlugins.some((item) => item.id === "com.memorylane.apple-photos" && isPluginActive(item));
    setVisible(enabled);
    if (!enabled) {
      setRoots([]);
      setStatuses({});
      setHelperStatus(null);
      setDetected([]);
      return;
    }

    const [libraries, allRoots] = await Promise.all([
      api.plugins.detectApplePhotosLibraries(),
      api.scanRoots.list(),
    ]);
    const appleRoots = allRoots.filter((root) => root.kind === "apple-photos");
    setDetected(libraries);
    setRoots(appleRoots);
    const checks = await Promise.all(appleRoots.map(async (root) => [root.id, await api.plugins.applePhotosSyncStatus(root.id)] as const));
    setStatuses(Object.fromEntries(checks));
    try {
      await api.plugins.applePhotosHealth();
      setHelperStatus("ready");
    } catch (cause) {
      setHelperStatus(cause instanceof Error ? cause.message : t("appleErrors.notRunning"));
    }
  }, [t]);

  useEffect(() => {
    void refresh().catch((cause) => void notice({ title: t("appleBrowse.loadFailed"), message: cause instanceof Error ? cause.message : t("pluginUi.genericError") }));
    const timer = window.setInterval(() => void refresh().catch(() => {}), 3000);
    return () => window.clearInterval(timer);
  }, [notice, refresh, t]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.scanRoots.create({ path: libraryPath.trim(), kind: "apple-photos" });
      setLibraryPath("");
      await refresh();
    } catch (cause) {
      await notice({ title: t("appleErrors.addFailed"), message: cause instanceof ApiError ? cause.message : t("pluginUi.genericError") });
    } finally {
      setBusy(false);
    }
  };

  const sync = async (rootId: number) => {
    setBusy(true);
    try {
      await api.plugins.applePhotosSync(rootId);
      await refresh();
    } catch (cause) {
      await notice({ title: t("appleErrors.syncFailed"), message: cause instanceof ApiError ? cause.message : t("pluginUi.genericError") });
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;
  return <ApplePhotosPluginPanel plugin={{ id: "apple-photos", name: "Apple Photos", available: true, enabled: true }}
    roots={roots} statuses={statuses} helperStatus={helperStatus} libraryPath={libraryPath} busy={busy}
    onPathChange={setLibraryPath} onAdd={(event) => void add(event)} onSync={(rootId) => void sync(rootId)}
    detected={detected} onChooseDetected={setLibraryPath} />;
}
