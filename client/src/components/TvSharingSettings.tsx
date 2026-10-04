import { PreviewUpgradeStatus } from './PreviewUpgradeStatus';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CollectionDto, TvSharingSettingsDto, TvSharingStatusDto } from '@memorylane/shared';
import { api } from '../api/client';
const settingsKey = (value: TvSharingSettingsDto) => JSON.stringify({ ...value, folders: [...value.folders].sort((a, b) => a.id - b.id), collections: [...(value.collections ?? [])].sort((a,b)=>String(a).localeCompare(String(b))) });
const input = 'rounded border border-border bg-surface px-2 py-1.5 text-ink';
type Folder = Awaited<ReturnType<typeof api.tvSharing.folders>>[number];
function FolderChoice({ folder, selected, onChange, disabled }: {
    folder: Folder;
    selected: TvSharingSettingsDto['folders'];
    onChange: (value: TvSharingSettingsDto['folders']) => void;
    disabled: boolean;
}) {
    const { t } = useTranslation();
    const [children, setChildren] = useState<Folder[] | null>(null), [open, setOpen] = useState(false), [error, setError] = useState('');
    const choice = selected.find(s => s.id === folder.id);
    return <li className="py-1"><div className="flex flex-wrap items-center gap-2">
 <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={!!choice} onChange={e => onChange(e.target.checked ? [...selected, { id: folder.id, recursive: true }] : selected.filter(s => s.id !== folder.id))}/>{folder.name}</label>
 {!!folder.hasChildren && <button type="button" disabled={disabled} className="text-sm underline" aria-expanded={open} onClick={() => { setOpen(!open); if (children === null)
        void api.tvSharing.folders(folder.id).then(setChildren).catch(e => setError(String(e))); }}>{t(open ? 'tvSharing.collapse' : 'tvSharing.expand')}</button>}
 {choice && <label className="flex items-center gap-1 text-sm text-muted"><input type="checkbox" disabled={disabled} checked={choice.recursive} onChange={e => onChange(selected.map(s => s.id === folder.id ? { ...s, recursive: e.target.checked } : s))}/>{t('tvSharing.recursive')}</label>}
 </div>{error && <p role="alert">{error}</p>}{open && <ul className="ml-5 border-l border-border pl-3">{children?.map(f => <FolderChoice key={f.id} folder={f} selected={selected} onChange={onChange} disabled={disabled}/>)}</ul>}</li>;
}
export default function TvSharingSettings() {
    const { t, i18n } = useTranslation();
    const [clearedBytes, setClearedBytes] = useState<number | null>(null);
    const [clearingCache, setClearingCache] = useState(false);
    const [refreshFailed, setRefreshFailed] = useState(false);
    const number = (value: number, digits = 0) => new Intl.NumberFormat(i18n.resolvedLanguage, {maximumFractionDigits:digits}).format(value);
    const [status, setStatus] = useState<TvSharingStatusDto | null>(null), [settings, setSettings] = useState<TvSharingSettingsDto | null>(null), [folders, setFolders] = useState<Folder[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
    const [collections, setCollections] = useState<CollectionDto[]>([]);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [loadingFolders, setLoadingFolders] = useState(true), [loadingCollections, setLoadingCollections] = useState(true);
    const [loadErrors, setLoadErrors] = useState<{settings?:string;folders?:string;collections?:string}>({});
    useEffect(() => {
      let active = true;
      setLoadErrors({}); setLoadingFolders(true); setLoadingCollections(true);
      const failed = (key: 'settings' | 'folders' | 'collections', cause: unknown) => {
        if (active) setLoadErrors(old => ({...old,[key]:cause instanceof Error ? cause.message : String(cause)}));
      };
      void api.tvSharing.get().then(s => {
        if (active) { setStatus(s); setSettings(old => old ?? s.settings); }
      }).catch(e => failed('settings',e));
      void api.tvSharing.folders().then(f => { if (active) setFolders(f); })
        .catch(e => failed('folders',e)).finally(() => { if (active) setLoadingFolders(false); });
      void api.collections.list().then(c => { if (active) setCollections(c); })
        .catch(e => failed('collections',e)).finally(() => { if (active) setLoadingCollections(false); });
      return () => { active = false; };
    }, [loadAttempt]);
    const hasStatus = status !== null;
    useEffect(() => {
      if (!hasStatus) return;
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      const poll = () => { void api.tvSharing.get().then(next => {
        if (active) { setRefreshFailed(false); setStatus(old => old ? {...old, runtime:next.runtime, diagnostics:next.diagnostics} : next); }
      }).catch(() => { if (active) setRefreshFailed(true); }).finally(() => {
        if (active) timer = setTimeout(poll, 3000);
      }); };
      timer = setTimeout(poll, 3000);
      return () => { active = false; clearTimeout(timer); };
    }, [hasStatus]);
    const dirty = !!settings && !!status && settingsKey(settings) !== settingsKey(status.settings);
    function change(patch: Partial<TvSharingSettingsDto>) { setSettings(s => s ? { ...s, ...patch } : s); setSaved(false); }
    async function save() { if (!settings || !dirty || busy)
        return; setBusy(true); setError(''); try {
        const result = await api.tvSharing.update(settings);
        setSettings(result.settings);
        setStatus(s => s ? { ...s, settings: result.settings, runtime: result.runtime } : s);
        // Saving succeeded even if the subsequent diagnostic refresh is unavailable.
        try { setStatus(await api.tvSharing.get()); } catch { /* Retain the confirmed settings. */ }
        setSaved(true);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        setBusy(false);
    } }
    async function clearCache() {
      if (busy) return;
      setBusy(true); setClearingCache(true); setError(''); setClearedBytes(null);
      try {
        const result = await api.tvSharing.clearCache();
        setClearedBytes(result.freedBytes);
        try { setStatus(await api.tvSharing.get()); } catch { setRefreshFailed(true); }
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); setClearingCache(false); }
    }
    async function togglePreviews() {
      if (busy || !status) return;
      setBusy(true); setError('');
      try {
        const result = await api.tvSharing.setPreviewProcessing(!status.settings.upgradePreviews);
        setStatus(s => s ? {...s, settings:result.settings} : s);
        setSettings(s => s ? {...s, upgradePreviews:result.settings.upgradePreviews} : s);
        try { setStatus(await api.tvSharing.get()); setRefreshFailed(false); } catch { setRefreshFailed(true); }
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }
    async function retry() {
      if (busy) return;
      setBusy(true); setError('');
      try {
        await api.tvSharing.retryPreviews();
        try { setStatus(await api.tvSharing.get()); } catch { setRefreshFailed(true); }
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }
    const storage = status?.diagnostics.previewStorage;
    const failureLabels: Record<string,string> = {budget:'previewUpgrade.reasonBudget',disk:'previewUpgrade.reasonDisk',source:'previewUpgrade.reasonSource',decode:'previewUpgrade.reasonDecode',timeout:'previewUpgrade.reasonTimeout',worker:'previewUpgrade.reasonWorker',io:'previewUpgrade.reasonIo',unknown:'previewUpgrade.reasonUnknown'};
    return <div className="mt-5 space-y-4 border-t border-border pt-4">
 <p className="text-sm text-muted">{t('tvSharing.help')}</p>
 <p className="text-sm text-muted">{t('tvSharing.privacy')}</p>
 {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
 {!settings && !loadErrors.settings && <p role="status" className="text-sm text-muted">{t('tvSharing.loadingSettings')}</p>}
 {Object.entries(loadErrors).length > 0 && <div role="alert" className="space-y-1 text-sm text-red-600">
 {Object.entries(loadErrors).map(([key,message])=><p key={key}>{t(`tvSharing.loadFailed${key[0].toUpperCase()+key.slice(1)}`)} {message}</p>)}
 <button type="button" className="underline" onClick={()=>setLoadAttempt(value=>value+1)}>{t('common.retry')}</button>
 </div>}
 {settings && status && <>
 <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => change({ enabled: e.target.checked })}/>{t('tvSharing.enabled')}</label>
 <div className="flex flex-wrap gap-4">
 <label className="grid gap-1 text-sm">{t('tvSharing.name')}<input className={input} disabled={busy} value={settings.name} maxLength={80} onChange={e => change({ name: e.target.value })}/></label>
 <label className="grid gap-1 text-sm">{t('tvSharing.interface')}<select className={input} disabled={busy} value={settings.address} onChange={e => change({ address: e.target.value })}><option value="">{t('tvSharing.choose')}</option>{status.interfaces.map(i => <option key={i.address} value={i.address}>{i.name} · {i.address}</option>)}</select></label>
 <label className="grid gap-1 text-sm">{t('tvSharing.quality')}<select className={input} disabled={busy} value={settings.quality} onChange={e => change({ quality: e.target.value as '1080p' | '4k' })}><option value="1080p">1080p</option><option value="4k">4K</option></select></label>
 <label className="grid gap-1 text-sm">{t('tvSharing.cache')}<input className={`${input} w-24`} disabled={busy} type="number" min={64} max={10240} value={settings.cacheMiB} onChange={e => change({ cacheMiB: Number(e.target.value) })}/></label>
 </div>
 <div><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={settings.upgradePreviews ?? false} onChange={e => change({upgradePreviews:e.target.checked})}/>{t('previewUpgrade.enable')}</label><p className="mt-1 text-sm text-muted">{t('previewUpgrade.help')}</p></div>
 <section className="space-y-2 rounded-lg border border-border bg-surface p-3" aria-label={t('previewUpgrade.storageTitle')}>
 <h4 className="font-medium">{t('previewUpgrade.storageTitle')}</h4>
 {refreshFailed ? <p role="alert" className="text-sm text-amber-600">{t('previewUpgrade.refreshFailed')}</p> : <PreviewUpgradeStatus diagnostics={status.diagnostics} enabled={status.installed && status.settings.enabled && status.settings.upgradePreviews} busy={busy} dirty={dirty} onRetry={()=>void retry()} onToggle={()=>void togglePreviews()} canResume={status.installed && status.settings.enabled}/>}
 {storage && <p className="text-sm text-muted">{t('previewUpgrade.storageSummary', {used:number(storage.usageBytes/1073741824,2),limit:number(storage.limitMiB/1024,2)})}</p>}
 {storage && (storage.usageBytes >= storage.limitMiB*1048576 || storage.failures.some(f=>f.code==='budget')) && <p className="text-sm text-amber-700 dark:text-amber-400">{t('previewUpgrade.budgetReached')}</p>}
 <details className="text-sm">
 <summary className="cursor-pointer text-muted">{t('previewUpgrade.changeLimit')}</summary>
 <div className="mt-3 space-y-2">
 <label className="flex flex-wrap items-center gap-2">{t('previewUpgrade.limit')}<input className={`${input} w-32`} disabled={busy} type="number" min={1024} max={1048576} step={1} value={settings.previewCacheMiB ?? 4096} onChange={e => change({previewCacheMiB:Number(e.target.value)})}/></label>
 <p className="text-muted">{t('previewUpgrade.limitHelp')}</p>
 {storage && <>
 <p className="text-muted">{t('previewUpgrade.diskFree', {free:number(storage.freeBytes/1073741824,1)})}</p>
 {storage.remaining > 0 && storage.suggestedMiB !== null && <>
 <button type="button" className="underline" disabled={busy || settings.previewCacheMiB === storage.suggestedMiB} onClick={()=>change({previewCacheMiB:storage.suggestedMiB!})}>{t('previewUpgrade.suggested', {size:number(storage.suggestedMiB/1024,2)})}</button>
 <p className="text-muted">{t('previewUpgrade.estimate', {photos:number(storage.remaining)})}</p>
 </>}
 {storage.remaining > 0 && storage.suggestedMiB === null && (storage.usageBytes >= storage.limitMiB*1048576 || storage.failures.some(f=>f.code==='budget')) && <p className="text-muted">{t('previewUpgrade.noSuggestion')}</p>}
 </>}
 </div>
 </details>
 {storage && storage.failures.some(f=>f.code!=='unknown') && <details><summary className="cursor-pointer text-sm">{t('previewUpgrade.failureDetails')}</summary><ul className="mt-2 space-y-1 text-sm">{storage.failures.filter(f=>f.code!=='unknown').map(f=><li key={f.code}>{t(failureLabels[f.code] ?? failureLabels.unknown)}: {number(f.count)}</li>)}</ul></details>}
 </section>
 <fieldset disabled={busy || loadingFolders || !!loadErrors.folders}><legend className="font-medium">{t('tvSharing.folders')}</legend><p className="text-sm text-muted">{t('tvSharing.future')}</p>{loadingFolders && <p role="status" className="text-sm text-muted">{t('common.loading')}</p>}<ul className="mt-2 max-h-72 overflow-auto">{folders.map(f => <FolderChoice key={f.id} folder={f} selected={settings.folders} onChange={v => change({ folders: v })} disabled={busy}/>)}</ul><p className="mt-2 text-sm">{t('tvSharing.selected', { count: settings.folders.length })}</p><button type="button" className="text-sm underline" onClick={() => change({ folders: [] })}>{t('tvSharing.clear')}</button></fieldset>
 <fieldset disabled={busy || loadingCollections || !!loadErrors.collections}><legend className="font-medium">{t('collections.shared')}</legend><p className="text-sm text-muted">{t('tvSharing.collectionsTip')}</p>{loadingCollections && <p role="status" className="text-sm text-muted">{t('common.loading')}</p>}<ul className="mt-2 max-h-60 overflow-auto">{collections.map(c=><li key={c.id}><label className="flex items-center gap-2 py-1"><input type="checkbox" checked={(settings.collections??[]).includes(c.id)} onChange={e=>change({collections:e.target.checked?[...(settings.collections??[]),c.id]:(settings.collections??[]).filter(id=>id!==c.id)})}/>{c.builtin?t('navigation.favorites'):c.name}</label></li>)}</ul><button type="button" className="mt-2 text-sm underline" onClick={()=>change({collections:[]})}>{t('collections.clearShared')}</button></fieldset>
 <div><label className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked={settings.momentsHighlights ?? false} onChange={e=>change({momentsHighlights:e.target.checked})}/>{t('tvSharing.momentsHighlights')}</label><p className="mt-1 text-sm text-muted">{t('tvSharing.momentsHighlightsHelp')}</p></div>
 <details><summary>{t('tvSharing.advanced')}</summary><label className="mt-2 flex items-center gap-2 text-sm">{t('tvSharing.port')}<input className={`${input} w-24`} disabled={busy} type="number" min={1024} max={65535} value={settings.port} onChange={e => change({ port: Number(e.target.value) })}/></label></details>
 <div className="flex flex-wrap items-center gap-3">
 <button type="button" disabled={busy || !dirty || !Number.isInteger(settings.previewCacheMiB ?? 4096) || (settings.previewCacheMiB ?? 4096)<1024 || (settings.previewCacheMiB ?? 4096)>1048576} className={`rounded border px-4 py-2 font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed ${dirty ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60' : 'border-border bg-surface text-muted'}`} onClick={() => void save()}>{t(busy ? 'tvSharing.saving' : dirty ? 'tvSharing.saveChanges' : 'tvSharing.upToDate')}</button>
 <p role="status" aria-live="polite" className={`text-sm ${dirty ? 'font-medium text-ink' : 'text-muted'}`}>{t(busy ? 'tvSharing.saving' : dirty ? 'tvSharing.unsaved' : saved ? 'tvSharing.saved' : 'tvSharing.noChanges')}</p>
 </div>
 <div className="space-y-1 border-t border-border pt-3">
 <div className="flex flex-wrap items-center gap-3">
 <span className="text-sm">{t('tvSharing.cacheUsage', {size:number(status.diagnostics.cacheBytes/1048576,1)})}</span>
 <button type="button" className="text-sm underline disabled:opacity-50" disabled={busy} onClick={()=>void clearCache()}>{t(clearingCache ? 'tvSharing.clearingCache' : 'tvSharing.clearCache')}</button>
 </div>
 <p className="text-xs text-muted">{t('tvSharing.clearCacheHelp')}</p>
 {clearedBytes !== null && <p role="status" className="text-sm">{t('tvSharing.cacheCleared',{size:number(clearedBytes/1048576,1)})}</p>}
 </div>
 <p className="text-sm">{t('tvSharing.diagnostics', { count: status.diagnostics.sharedPhotos, cache: (status.diagnostics.cacheBytes / 1048576).toFixed(1), failures: status.diagnostics.conversionFailures })}</p>

 <p className="text-sm">{t(status.runtime?.sharing ? 'tvSharing.running' : 'tvSharing.off')}</p>
 {status.runtime?.error && <p role="alert" className="text-sm text-amber-600">{status.runtime.error}</p>}
 </>}
 </div>;
}
