import { useCallback, useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import type { CoreUpdateDto } from "@memorylane/shared";
import { api } from "../api/client";
import { useTranslation } from "react-i18next";

export const CORE_UPDATE_REFRESH_EVENT = "memorylane-core-update-refresh";

export default function CoreUpdateBanner() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<CoreUpdateDto | null>(null);
  const [installing, setInstalling] = useState(false);
  const refresh = useCallback(() => void api.coreUpdate.status().then(setUpdate).catch(() => setUpdate(null)), []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener(CORE_UPDATE_REFRESH_EVENT, refresh);
    return () => { window.clearInterval(timer); window.removeEventListener(CORE_UPDATE_REFRESH_EVENT, refresh); };
  }, [refresh]);

  if (!update?.availableVersion || !["downloading", "ready"].includes(update.state)) return null;
  const dismissed = localStorage.getItem("memorylane-dismissed-core-update") === update.availableVersion;
  if (dismissed) return null;

  const install = async () => {
    setInstalling(true);
    try { setUpdate(await api.coreUpdate.install()); }
    catch { refresh(); }
    finally { setInstalling(false); }
  };
  return <div className="border-b border-amber-400/40 bg-amber-100 text-amber-950">
    <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-3 py-2.5 text-sm sm:px-5 lg:px-8">
      <Download aria-hidden size={17} className="shrink-0" />
      <p className="min-w-0 flex-1"><strong>{t("updates.available", { version: update.availableVersion })}</strong>{update.state === "downloading" ? ` ${t("updates.downloading")}` : update.message ? ` ${update.message}.` : ` ${t("updates.restart")}`}</p>
      {update.state === "ready" && <button type="button" disabled={installing} onClick={() => void install()} className="shrink-0 rounded-md bg-amber-900 px-3 py-1.5 font-semibold text-white disabled:opacity-50">{installing ? t("updates.starting") : t("updates.install")}</button>}
      <button type="button" aria-label={t("updates.dismiss", { version: update.availableVersion })} className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-amber-200" onClick={() => { localStorage.setItem("memorylane-dismissed-core-update", update.availableVersion!); setUpdate(null); }}><X aria-hidden size={16} /></button>
    </div>
  </div>;
}
