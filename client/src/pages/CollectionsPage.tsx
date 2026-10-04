import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CollectionDto, CollectionId, MediaDto } from '@memorylane/shared';
import { api } from '../api/client';
import MediaGrid from '../components/MediaGrid';
import CollectionCard from '../components/CollectionCard';
import Viewer from '../components/Viewer';
import CollectionPhotoPicker from '../components/CollectionPhotoPicker';
import CollectionPicker from '../components/CollectionPicker';
import { useConfirm } from '../components/ConfirmDialog';
import { MoreVertical, Plus } from 'lucide-react';
const button = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink hover:bg-hover disabled:opacity-50';
export default function CollectionsPage({ onCollectionCountChange }: { onCollectionCountChange?: (count: number) => void }) {
    const { t } = useTranslation(), { confirm } = useConfirm();
    const [params, setParams] = useSearchParams();
    const raw = params.get('id');
    const id: CollectionId | null = raw === 'favorites' ? 'favorites' : raw && /^\d+$/.test(raw) ? Number(raw) : null;
    const [collections, setCollections] = useState<CollectionDto[]>([]), [items, setItems] = useState<MediaDto[]>([]), [total, setTotal] = useState(0), [name, setName] = useState(''), [rename, setRename] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState<Set<number>>(new Set()), [selecting, setSelecting] = useState(false), [viewer, setViewer] = useState<number | null>(null), [revision, setRevision] = useState(0);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    useEffect(() => {
        if (!pickerOpen) return;
        const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPickerOpen(false); };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [pickerOpen]);
    useEffect(() => { setPickerOpen(false); setMoreOpen(false); setRenameOpen(false); }, [id]);
    const generation = useRef(0), fetching = useRef(false);
    const refresh = useCallback(() => setRevision(v => v + 1), []);
    useEffect(() => { let active = true; void api.collections.list().then(rows => { if (active) {
        setCollections(rows); onCollectionCountChange?.(rows.filter(row => !row.builtin).length); } }).catch(e => { if (active)
        setError(String(e)); }); return () => { active = false; }; }, [revision]);
    useEffect(() => {
        const version = ++generation.current;
        setItems([]);
        setTotal(0);
        setSelected(new Set());
        setSelecting(false);
        setViewer(null);
        setError('');
        fetching.current = false;
        if (id === null) {
            setLoading(false);
            return;
        }
        setLoading(true);
        fetching.current = true;
        void api.collections.media(id).then(result => { if (version === generation.current) {
            setItems(result.items);
            setTotal(result.total);
        } }).catch(e => { if (version === generation.current)
            setError(String(e)); }).finally(() => { if (version === generation.current) {
            setLoading(false);
            fetching.current = false;
        } });
        return () => { generation.current++; };
    }, [id, revision]);
    const current = collections.find(c => c.id === id);
    useEffect(() => { setRename(current?.name ?? ''); }, [current?.name, id]);
    const loadMore = async () => {
        if (id === null || fetching.current || items.length >= total)
            return;
        const version = generation.current;
        fetching.current = true;
        setLoading(true);
        try {
            const result = await api.collections.media(id, items.length);
            if (version === generation.current) {
                setItems(old => [...old, ...result.items]);
                setTotal(result.total);
            }
        }
        catch (e) {
            if (version === generation.current)
                setError(String(e));
        }
        finally {
            if (version === generation.current) {
                fetching.current = false;
                setLoading(false);
            }
        }
    };
    async function mutate(action: () => Promise<unknown>) { setBusy(true); setError(''); try {
        await action();
        refresh();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        setBusy(false);
    } }
    const label = (c: CollectionDto) => c.builtin ? t('navigation.favorites') : c.name;
    const customCollections = collections.filter(c => !c.builtin);
    return <div className="flex flex-col gap-5">
  <div className="sticky top-16 z-10 bg-page">
   <nav className="mb-2 text-sm text-muted" aria-label={t('collections.title')}>
    <Link to="/" className="hover:text-ink">{t('navigation.library')}</Link>
    <span> / {id === null ? t('collections.title') : <button type="button" className="hover:text-ink" onClick={() => setParams({})}>{t('collections.title')}</button>}</span>
    {current && <span> / {label(current)}</span>}
   </nav>
   <div className="flex flex-wrap items-center justify-between gap-4">
    <h1 className="min-w-0 break-words font-serif text-2xl font-semibold text-ink">{current ? label(current) : t('collections.title')}</h1>
   {id === null && <div className="relative">
    <button type="button" aria-label={t('collections.new')} title={t('collections.new')} aria-expanded={createOpen} onClick={() => setCreateOpen(open => !open)} className="grid size-8 place-items-center rounded-md border border-border text-ink hover:bg-hover"><Plus size={16} strokeWidth={2}/></button>
    {createOpen && <form className="absolute right-0 top-full z-30 mt-2 flex w-72 gap-2 rounded-lg border border-border bg-surface p-3 shadow-card" onSubmit={e => { e.preventDefault(); void mutate(async () => { await api.collections.create(name); setName(''); setCreateOpen(false); }); }}>
     <input autoFocus aria-label={t('collections.name')} placeholder={t('collections.name')} className={`${button} min-w-0 flex-1`} required maxLength={80} disabled={busy} value={name} onChange={e => setName(e.target.value)}/><button className={button} disabled={busy || !name.trim()}>{t('common.add')}</button>
    </form>}
   </div>}
   {current && !current.builtin && !selecting && <div className="flex items-center gap-2">
    <button className={button} disabled={busy} onClick={() => setPickerOpen(true)}><span className="inline-flex items-center gap-1.5"><Plus size={15}/>{t('collectionsDetail.addItems')}</span></button>
    <div className="relative">
     <button type="button" className="grid size-9 place-items-center rounded-md border border-border text-muted hover:bg-hover hover:text-ink" aria-label={t('coreBrowse.folder.more')} aria-expanded={moreOpen} onClick={() => { setMoreOpen(open => !open); setRenameOpen(false); }}><MoreVertical size={16}/></button>
     {moreOpen && <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-border bg-surface py-1 shadow-card">
      <button className="w-full px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-ink" onClick={() => { setSelecting(true); setSelected(new Set()); setMoreOpen(false); }}>{t('collections.select')}</button>
      <button className="w-full px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-ink" onClick={() => { setRenameOpen(true); setMoreOpen(false); }}>{t('collections.rename')}</button>
      <button className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-500/10" onClick={() => void (async () => { setMoreOpen(false); if (await confirm({ title: t('collections.delete'), message: t('collections.deleteHelp'), danger: true })) await mutate(async () => { await api.collections.delete(Number(id)); setParams({}); }); })()}>{t('collections.delete')}</button>
     </div>}
     {renameOpen && <form className="absolute right-0 top-full z-20 mt-1 flex w-80 gap-2 rounded-lg border border-border bg-surface p-3 shadow-card" onSubmit={e => { e.preventDefault(); void mutate(async () => { await api.collections.rename(Number(id), rename); setRenameOpen(false); }); }}><input autoFocus aria-label={t('collections.rename')} className={`${button} min-w-0 flex-1`} value={rename} disabled={busy} maxLength={80} required onChange={e => setRename(e.target.value)}/><button className={button} disabled={busy || !rename.trim() || rename === current.name}>{t('common.save')}</button></form>}
    </div>
   </div>}
   </div>
  </div>
  {error && <p role="alert" className="text-red-600">{error}</p>}
  {id === null ? customCollections.length > 0 ? <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">{customCollections.map(c => <CollectionCard key={c.id} collection={c} disabled={busy} onOpen={() => setParams({ id: String(c.id) })}/>)}</div> : <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center"><p className="font-medium text-ink">{t('collectionsEmpty.title')}</p><p className="mt-1 text-sm text-muted">{t('collectionsEmpty.help')}</p></div> : null}
  {current && <section className="flex flex-col gap-4">
   {selecting && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3"><span className="mr-1 text-sm font-medium text-ink">{t('collectionsDetail.selected', { count: selected.size })}</span><button className={button} disabled={busy} onClick={() => setSelected(new Set(items.map(m => m.id)))}>{t('collections.selectShown')}</button><CollectionPicker key={String(id)} mediaIds={[...selected]}/><button className={button} disabled={busy || !selected.size} onClick={() => void mutate(() => api.collections.remove(Number(id), [...selected]))}>{t('collections.remove', { count: selected.size })}</button><button className={button} disabled={busy} onClick={() => { setSelecting(false); setSelected(new Set()); }}>{t('coreBrowse.folder.done')}</button></div>}
   {!loading && !items.length && <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center"><p className="font-medium text-ink">{t('collectionsDetail.empty')}</p><p className="mt-1 text-sm text-muted">{t('collectionsDetail.emptyHelp')}</p><button className={`${button} mt-4`} onClick={() => setPickerOpen(true)}><span className="inline-flex items-center gap-1.5"><Plus size={15}/>{t('collectionsDetail.addItems')}</span></button></div>}
   <MediaGrid items={items} onOpen={setViewer} selectable={selecting} selectedIds={selected} onToggleSelect={m => { if (!busy)
            setSelected(old => { const next = new Set(old); next.has(m.id) ? next.delete(m.id) : next.add(m.id); return next; }); }}/>
   {loading && <p role="status">{t('common.loading')}</p>}
   {items.length < total && <button className={`${button} self-center`} disabled={loading} onClick={() => void loadMore()}>{t('collections.more')}</button>}
  </section>}
  {!current?.builtin && pickerOpen && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-overlay/80 p-4" role="dialog" aria-modal="true" aria-label={t('collectionsDetail.addItems')} onMouseDown={e => { if (e.target === e.currentTarget) setPickerOpen(false); }}><div className="max-h-[92vh] w-full max-w-6xl overflow-y-auto"><CollectionPhotoPicker key={String(id)} collectionId={Number(id)} onAdded={refresh} onClose={() => setPickerOpen(false)} /></div></div>}
  {viewer !== null && <Viewer items={items} startIndex={viewer} total={total} onRequestMore={loadMore} onClose={() => { setViewer(null); refresh(); }}/>}
 </div>;
}
