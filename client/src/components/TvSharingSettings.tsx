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
    const { t } = useTranslation();
    const [status, setStatus] = useState<TvSharingStatusDto | null>(null), [settings, setSettings] = useState<TvSharingSettingsDto | null>(null), [folders, setFolders] = useState<Folder[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
    const [collections, setCollections] = useState<CollectionDto[]>([]);
    useEffect(() => { let active = true; void Promise.all([api.tvSharing.get(), api.tvSharing.folders(), api.collections.list()]).then(([s, f, c]) => { if (active) {
        setStatus(s);
        setSettings(s.settings);
        setFolders(f);
        setCollections(c);
    } }).catch(e => { if (active)
        setError(String(e)); }); return () => { active = false; }; }, []);
    useEffect(() => {
      let active = true;
      const timer = setInterval(() => { void api.tvSharing.get().then(next => {
        if (active) setStatus(old => old ? {...old, runtime:next.runtime, diagnostics:next.diagnostics} : next);
      }).catch(() => {}); }, 3000);
      return () => { active = false; clearInterval(timer); };
    }, []);
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
    return <div className="mt-5 space-y-4 border-t border-border pt-4">
 <p className="text-sm text-muted">{t('tvSharing.help')}</p>
 <p className="text-sm text-muted">{t('tvSharing.privacy')}</p>
 {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
 {settings && status && <>
 <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => change({ enabled: e.target.checked })}/>{t('tvSharing.enabled')}</label>
 <div className="flex flex-wrap gap-4">
 <label className="grid gap-1 text-sm">{t('tvSharing.name')}<input className={input} disabled={busy} value={settings.name} maxLength={80} onChange={e => change({ name: e.target.value })}/></label>
 <label className="grid gap-1 text-sm">{t('tvSharing.interface')}<select className={input} disabled={busy} value={settings.address} onChange={e => change({ address: e.target.value })}><option value="">{t('tvSharing.choose')}</option>{status.interfaces.map(i => <option key={i.address} value={i.address}>{i.name} · {i.address}</option>)}</select></label>
 <label className="grid gap-1 text-sm">{t('tvSharing.quality')}<select className={input} disabled={busy} value={settings.quality} onChange={e => change({ quality: e.target.value as '1080p' | '4k' })}><option value="1080p">1080p</option><option value="4k">4K</option></select></label>
 <label className="grid gap-1 text-sm">{t('tvSharing.cache')}<input className={`${input} w-24`} disabled={busy} type="number" min={64} max={10240} value={settings.cacheMiB} onChange={e => change({ cacheMiB: Number(e.target.value) })}/></label>
 </div>
 <fieldset disabled={busy}><legend className="font-medium">{t('tvSharing.folders')}</legend><p className="text-sm text-muted">{t('tvSharing.future')}</p><ul className="mt-2 max-h-72 overflow-auto">{folders.map(f => <FolderChoice key={f.id} folder={f} selected={settings.folders} onChange={v => change({ folders: v })} disabled={busy}/>)}</ul><p className="mt-2 text-sm">{t('tvSharing.selected', { count: settings.folders.length })}</p><button type="button" className="text-sm underline" onClick={() => change({ folders: [] })}>{t('tvSharing.clear')}</button></fieldset>
 <fieldset disabled={busy}><legend className="font-medium">{t('collections.shared')}</legend><p className="text-sm text-muted">{t('collections.shareHelp')}</p><ul className="mt-2 max-h-60 overflow-auto">{collections.map(c=><li key={c.id}><label className="flex items-center gap-2 py-1"><input type="checkbox" checked={(settings.collections??[]).includes(c.id)} onChange={e=>change({collections:e.target.checked?[...(settings.collections??[]),c.id]:(settings.collections??[]).filter(id=>id!==c.id)})}/>{c.builtin?t('navigation.favorites'):c.name}</label></li>)}</ul><button type="button" className="mt-2 text-sm underline" onClick={()=>change({collections:[]})}>{t('collections.clearShared')}</button></fieldset>
 <details><summary>{t('tvSharing.advanced')}</summary><label className="mt-2 flex items-center gap-2 text-sm">{t('tvSharing.port')}<input className={`${input} w-24`} disabled={busy} type="number" min={1024} max={65535} value={settings.port} onChange={e => change({ port: Number(e.target.value) })}/></label></details>
 <div className="flex flex-wrap items-center gap-3">
 <button type="button" disabled={busy || !dirty} className={`rounded border px-4 py-2 font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed ${dirty ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60' : 'border-border bg-surface text-muted'}`} onClick={() => void save()}>{t(busy ? 'tvSharing.saving' : dirty ? 'tvSharing.saveChanges' : 'tvSharing.upToDate')}</button>
 <p role="status" aria-live="polite" className={`text-sm ${dirty ? 'font-medium text-ink' : 'text-muted'}`}>{t(busy ? 'tvSharing.saving' : dirty ? 'tvSharing.unsaved' : saved ? 'tvSharing.saved' : 'tvSharing.noChanges')}</p>
 </div>
 <p className="text-sm">{t('tvSharing.diagnostics', { count: status.diagnostics.sharedPhotos, cache: (status.diagnostics.cacheBytes / 1048576).toFixed(1), failures: status.diagnostics.conversionFailures })}</p>
 {status.diagnostics.previews && <p role="status" className="text-sm">{t('previewUpgrade.progress', {done:status.diagnostics.previews.ready + status.diagnostics.previews.limited + status.diagnostics.previews.failed, total:Object.values(status.diagnostics.previews).reduce((a,b)=>a+b,0)})} {t('previewUpgrade.results', status.diagnostics.previews)}</p>}
 <p className="text-sm">{t(status.runtime?.sharing ? 'tvSharing.running' : 'tvSharing.off')}</p>
 {status.runtime?.error && <p role="alert" className="text-sm text-amber-600">{status.runtime.error}</p>}
 </>}
 </div>;
}
