import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApplePhotoPreparationDto } from "@memorylane/shared";
import { api } from "../api/client";
import { useConfirm } from "./ConfirmDialog";

const button = "rounded-md border border-border px-3 py-1.5 text-sm text-ink disabled:opacity-40";
export default function ApplePhotoPreparationCard() {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirm();
  const [state, setState] = useState<ApplePhotoPreparationDto>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api.plugins.applePreparation();
        if (active) { setState(next); setError(""); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  async function act(action: () => Promise<ApplePhotoPreparationDto>) {
    setBusy(true);
    try { setState(await action()); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const number = (n: number) => n.toLocaleString(i18n.language);
  const pending = (state?.queued ?? 0) + (state?.running ?? 0);
  const completed = (state?.ready ?? 0) + (state?.failed ?? 0) + (state?.blocked ?? 0);
  return <section className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-semibold text-ink">{t("applePreparation.title")}</h3>
    <p className="text-sm text-muted">{t("applePreparation.description")}</p>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {!state && !error && <p role="status">{t("common.loading")}</p>}
    {state && <>
      <p role="status" className="text-sm text-ink">{t(state.paused ? "applePreparation.paused" : pending ? "applePreparation.working" : "applePreparation.idle")}</p>
      {pending > 0 && <progress className="h-2 w-full accent-accent" aria-label={t("applePreparation.title")} max={completed + pending} value={completed} />}
      <p className="text-sm text-muted">{t("applePreparation.counts", { ready: number(state.ready), remaining: number(pending), failed: number(state.failed + state.blocked) })}</p>
      {state.lastError && <p role="alert" className="text-sm text-red-500">{t(state.lastError === "cache-budget" ? "applePreparation.budgetError" : state.lastError === "disk-reserve" ? "applePreparation.diskError" : "applePreparation.error", {error: state.lastError})}</p>}
      <p className="text-sm text-muted">{t("applePreparation.storage", {used: number(Math.round(state.usageBytes / 1048576)), limit: number(state.cacheMiB)})}</p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">{t("applePreparation.storageSettings")}</summary>
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => {event.preventDefault(); void act(() => api.plugins.configureApplePreparation({cacheMiB: Number(limit)}));}}>
          <label>{t("applePreparation.limit")} <input type="number" min={64} max={1048576} required value={limit || state.cacheMiB} onChange={event => setLimit(event.target.value)} className="w-28 rounded border border-border bg-page px-2 py-1" /></label>
          <button className={button} disabled={busy || !limit}>{t("common.save")}</button>
        </form>
      </details>
      <div className="flex flex-wrap gap-2">
        {(pending > 0 || state.paused) && <button className={button} disabled={busy} onClick={() => void act(() => api.plugins.configureApplePreparation({paused: !state.paused}))}>{t(state.paused ? "applePreparation.resume" : "applePreparation.pause")}</button>}
        {(state.failed + state.blocked) > 0 && <button className={button} disabled={busy} onClick={() => void act(api.plugins.retryApplePreparation)}>{t("applePreparation.retry")}</button>}
        {state.existing > 0 && <button className={button} disabled={busy} onClick={() => void act(api.plugins.startApplePreparation)}>{t("applePreparation.existing", {count: number(Math.min(state.existing, state.batchLimit))})}</button>}
        {state.usageBytes > 0 && <button className={button} disabled={busy} onClick={async () => {if (await confirm({title: t("applePreparation.clear"), message: t("applePreparation.clearConfirm")})) void act(api.plugins.clearApplePreparation);}}>{t("applePreparation.clear")}</button>}
      </div>
    </>}
  </section>;
}
