import { useCallback, useEffect, useState } from "react";
import type { PluginPlatformDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import { useConfirm } from "./ConfirmDialog";
import { isPluginActive } from "../utils/plugins";
import { CORE_UPDATE_REFRESH_EVENT } from "./CoreUpdateBanner";
import PluginInstallProgress from "./PluginInstallProgress";
import { useTranslation } from "react-i18next";

export { ApplePhotosPluginPanel } from "./ApplePhotosSyncCard";

const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-40";

export default function PluginsSettings() {
  const { t } = useTranslation();
  const { confirm, notice } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [platformPlugins, setPlatformPlugins] = useState<PluginPlatformDto[]>([]);
  const [pluginLogs, setPluginLogs] = useState<{id:string;lines:string[]}|null>(null);
  const [updateHistory,setUpdateHistory]=useState<Array<{pluginId:string;toVersion:string;status:string;at:string;error?:string}>>([]);
  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  const [installingPlugin, setInstallingPlugin] = useState<{id:string;label:string}|null>(null);

  const refresh = useCallback(async () => {
    const [generic, updates, versionInfo] = await Promise.all([api.pluginPlatform.list(), api.pluginPlatform.updates(), api.settings.version()]);
    setUpdateHistory(updates.history.slice(-10).reverse());
    setPlatformPlugins(generic);
    setCoreVersion(versionInfo.version);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => void notice({ title: t("pluginUi.loadFailed"), message: cause instanceof Error ? cause.message : t("pluginUi.genericError") }));
  }, [refresh]);

  const changePlatformPlugin = async (item: PluginPlatformDto) => {
    if (!item.version) return;
    setBusy(true);
    if (item.state === "available" || item.state === "update-available") setInstallingPlugin({ id: item.id, label: t(item.state === "available" ? "pluginUi.installing" : "pluginUi.updating", { name: item.name }) });
    try {
      if (item.state === "update-available") await api.pluginPlatform.update(item.id, item.version);
      else if (item.state === "available") {
        await api.pluginPlatform.install(item.id, item.version);
        await api.pluginPlatform.setEnabled(item.id, true, item.version);
      } else await api.pluginPlatform.setEnabled(item.id, !isPluginActive(item), item.version);
      if (item.id === "com.memorylane.apple-photos" && item.state !== "update-available") {
        await api.plugins.setApplePhotosEnabled(item.state === "available" || !isPluginActive(item));
      }
      await refresh();
    } catch (cause) { await notice({ title: t("pluginUi.changeFailed", { name: item.name }), message: cause instanceof ApiError ? cause.message : t("pluginUi.genericError") }); }
    finally { setBusy(false); setInstallingPlugin(null); }
  };

  const removePlatformPlugin = async (item: PluginPlatformDto) => {
    if (!item.version || item.required) return;
    const approved = await confirm({ title: t("pluginUi.removeTitle", { name: item.name }), message: t("pluginUi.removeMessage"), confirmLabel: t("pluginUi.removePlugin"), danger: true });
    if (!approved) return;
    setBusy(true);
    try {
      if (item.id === "com.memorylane.apple-photos") await api.plugins.setApplePhotosEnabled(false);
      await api.pluginPlatform.remove(item.id);
      await refresh();
      await notice({ title: t("pluginUi.removed"), message: t("pluginUi.removedMessage", { name: item.name }) });
    } catch (cause) { await notice({ title: t("pluginUi.removeFailed", { name: item.name }), message: cause instanceof Error ? cause.message : t("pluginUi.genericError") }); }
    finally { setBusy(false); }
  };

  // "available" is the only state a plugin can be in before it's ever been
  // installed - everything else (disabled/installed/ready/failed/
  // update-available, and the rare case of an installed plugin that's gone
  // incompatible after a core upgrade) means it's on disk in some form.
  // Required plugins are always installed by the time this loads (they're
  // auto-installed at boot), so they land in the same "Installed" group as
  // any optional plugin the user has added - required-vs-optional is still
  // visible per row, just not worth its own separate heading.
  // Required-first within Installed - otherwise required plugins (always
  // present, same as core) would be scattered alphabetically among whatever
  // optional features happen to be installed, instead of reading as "the
  // foundation, then what you've added".
  const installedPlugins = platformPlugins
    .filter((item) => item.state !== "available")
    .sort((a, b) => Number(b.required) - Number(a.required));
  const availablePlugins = platformPlugins.filter((item) => item.state === "available");
  const renderPlugin = (item: PluginPlatformDto) => <section key={item.id} className="rounded-xl border border-border p-5"><div className="flex flex-wrap items-center justify-between gap-4">
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-ink">{item.name}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${item.required ? "bg-accent/15 text-accent" : "bg-chip text-muted"}`}>
          {item.required ? t("pluginUi.required") : t("pluginUi.optional")}
        </span>
      </div>
      {item.description && <p className="mt-1 text-sm text-muted">{item.description}</p>}
      <p className="mt-1 text-xs text-muted">
        {item.version ? `v${item.version} · ` : ""}{item.state}
        {item.dependsOn.length > 0 && ` · ${t("pluginUi.requires", { dependencies: item.dependsOn.join(", ") })}`}
      </p>
      {item.error && <p className="mt-1 text-xs text-amber-600">{item.error}</p>}
    </div>
    <div className="flex gap-2"><button type="button" className={buttonClass} onClick={() => void api.pluginPlatform.logs(item.id).then(result=>setPluginLogs({id:item.id,lines:result.lines})).catch(()=>setPluginLogs({id:item.id,lines:[t("pluginUi.logsUnavailable")]}))}>{t("pluginUi.logs")}</button>
      {/* Required plugins keep Update (a version bump, not a user turning a
          core feature off) but never Enable/Disable or Remove - matched by
          the server-side guards on the same actions. */}
      {(!item.required || item.state === "update-available") && <button type="button" className={buttonClass} disabled={busy || item.state === "incompatible" || !item.version} onClick={() => void changePlatformPlugin(item)}>
        {item.state === "available" ? t("pluginUi.install") : item.state === "update-available" ? t("pluginUi.update") : isPluginActive(item) ? t("pluginUi.disable") : t("pluginUi.enable")}
      </button>}
      {!item.required && item.state !== "available" && <button type="button" className={buttonClass} disabled={busy} onClick={() => void removePlatformPlugin(item)}>{t("pluginUi.remove")}</button>}</div></div>
    {installingPlugin?.id === item.id && <PluginInstallProgress label={installingPlugin.label} />}
  </section>;
  return <div className="space-y-6">
    <div className="flex items-center justify-between gap-4"><p className="text-sm text-muted">{t("pluginUi.updateIntro")}</p><button type="button" className={buttonClass} disabled={busy} onClick={()=>{setBusy(true);void Promise.all([api.pluginPlatform.checkUpdates(),api.coreUpdate.check()]).then(()=>{window.dispatchEvent(new Event(CORE_UPDATE_REFRESH_EVENT));return refresh();}).catch(cause=>notice({title:t("pluginUi.updateFailed"),message:cause instanceof Error?cause.message:t("pluginUi.genericError")})).finally(()=>setBusy(false));}}>{t("pluginUi.checkUpdates")}</button></div>
    <section className="space-y-3"><h2 className="font-serif text-lg font-semibold text-ink">{t("pluginUi.core")}</h2><div className="rounded-xl border border-border p-5"><h3 className="font-semibold text-ink">MemoryLane Core</h3><p className="text-sm text-muted">{t("pluginUi.builtInRunning", { version: coreVersion ?? "…" })}</p></div></section>
    <section className="space-y-3"><div><h2 className="font-serif text-lg font-semibold text-ink">{t("pluginUi.installed")}</h2><p className="text-sm text-muted">{t("pluginUi.installedHelp")}</p></div>{installedPlugins.map(renderPlugin)}</section>
    <section className="space-y-3">
      <div><h2 className="font-serif text-lg font-semibold text-ink">{t("pluginUi.available")}</h2><p className="text-sm text-muted">{t("pluginUi.availableHelp")}</p></div>
      {availablePlugins.length > 0 ? availablePlugins.map(renderPlugin) : <p className="text-sm text-muted">{t("pluginUi.nothingAvailable")}</p>}
    </section>
    {pluginLogs&&<section className="rounded-xl border border-border p-4"><div className="mb-2 flex justify-between"><h3 className="font-medium">{t("pluginUi.recentOutput")}</h3><button className={buttonClass} onClick={()=>setPluginLogs(null)}>{t("common.close")}</button></div><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted">{pluginLogs.lines.join("\n")||t("pluginUi.noOutput")}</pre></section>}
    {updateHistory.length>0&&<details className="rounded-xl border border-border p-4"><summary className="cursor-pointer font-medium">{t("pluginUi.history")}</summary><div className="mt-3 space-y-2 text-xs text-muted">{updateHistory.map((item,index)=><p key={`${item.at}-${index}`}>{new Date(item.at).toLocaleString()} · {item.pluginId} → {item.toVersion} · {item.status}{item.error?` · ${item.error}`:""}</p>)}</div></details>}
  </div>;
}
