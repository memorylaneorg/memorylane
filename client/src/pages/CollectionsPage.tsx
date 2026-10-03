import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CollectionDto, CollectionId, MediaDto } from '@memorylane/shared';
import { api } from '../api/client';
import MediaGrid from '../components/MediaGrid';
import CollectionCard from '../components/CollectionCard';
import Viewer from '../components/Viewer';
import CollectionPhotoPicker from '../components/CollectionPhotoPicker';
import CollectionPicker from '../components/CollectionPicker';
import { useConfirm } from '../components/ConfirmDialog';
const button = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink hover:bg-hover disabled:opacity-50';
export default function CollectionsPage() {
    const { t } = useTranslation(), { confirm } = useConfirm();
    const [params, setParams] = useSearchParams();
    const raw = params.get('id');
    const id: CollectionId | null = raw === 'favorites' ? 'favorites' : raw && /^\d+$/.test(raw) ? Number(raw) : null;
    const [collections, setCollections] = useState<CollectionDto[]>([]), [items, setItems] = useState<MediaDto[]>([]), [total, setTotal] = useState(0), [name, setName] = useState(''), [rename, setRename] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState<Set<number>>(new Set()), [selecting, setSelecting] = useState(false), [viewer, setViewer] = useState<number | null>(null), [revision, setRevision] = useState(0);
    const [pickerOpen, setPickerOpen] = useState(false);
    useEffect(() => { setPickerOpen(false); }, [id]);
    const generation = useRef(0), fetching = useRef(false);
    const refresh = useCallback(() => setRevision(v => v + 1), []);
    useEffect(() => { let active = true; void api.collections.list().then(rows => { if (active)
        setCollections(rows); }).catch(e => { if (active)
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
    return <div className="flex flex-col gap-5">
  <p className="text-sm text-muted">{t('collectionPicker.intro')}</p>
  {id === null && <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void mutate(async () => { const c = await api.collections.create(name); setName(''); setParams({ id: String(c.id) }); }); }}>
   <input aria-label={t('collections.name')} placeholder={t('collections.name')} className={button} required maxLength={80} disabled={busy} value={name} onChange={e => setName(e.target.value)}/><button className={button} disabled={busy || !name.trim()}>{t('collections.new')}</button>
  </form>}
  {error && <p role="alert" className="text-red-600">{error}</p>}
  {id === null ? <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">{collections.map(c => <CollectionCard key={c.id} collection={c} disabled={busy} onOpen={() => setParams({ id: String(c.id) })}/>) }</div> : <nav aria-label={t('collections.title')}><button className="text-accent underline" onClick={() => setParams({})}>{t('collections.title')}</button><span> / {current ? label(current) : ''}</span></nav>}
  {current && <section className="flex flex-col gap-4">
   <h2 className="font-serif text-2xl">{label(current)} <span className="font-sans text-sm text-muted">{t('common.photos', { count: total })}</span></h2>
   {!current.builtin && <button className={`${button} self-start`} disabled={busy} aria-expanded={pickerOpen} onClick={() => setPickerOpen(!pickerOpen)}>{t('collectionPicker.title')}</button>}
   {!current.builtin && pickerOpen && <CollectionPhotoPicker key={String(id)} collectionId={Number(id)} onAdded={refresh} onClose={() => setPickerOpen(false)} />}
   {!current.builtin && <div className="flex flex-wrap items-center gap-2">
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void mutate(() => api.collections.rename(Number(id), rename)); }}><input aria-label={t('collections.rename')} className={button} value={rename} disabled={busy} maxLength={80} required onChange={e => setRename(e.target.value)}/><button className={button} disabled={busy || !rename.trim() || rename === current.name}>{t('collections.rename')}</button></form>
    <button className={button} disabled={busy} onClick={() => void (async () => { if (await confirm({ title: t('collections.delete'), message: t('collections.deleteHelp'), danger: true }))
                await mutate(async () => { await api.collections.delete(Number(id)); setParams({}); }); })()}>{t('collections.delete')}</button>
    <button className={button} disabled={busy} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>{t(selecting ? 'common.cancel' : 'collections.select')}</button>
   </div>}
   {selecting && <div className="flex flex-wrap items-start gap-2"><button className={button} disabled={busy} onClick={() => setSelected(new Set(items.map(m => m.id)))}>{t('collections.selectShown')}</button><button className={button} disabled={busy || !selected.size} onClick={() => void mutate(() => api.collections.remove(Number(id), [...selected]))}>{t('collections.remove', { count: selected.size })}</button><CollectionPicker key={String(id)} mediaIds={[...selected]}/></div>}
   {!loading && !items.length && <p className="text-muted">{t('collectionPicker.empty')}</p>}
   <MediaGrid items={items} onOpen={setViewer} selectable={selecting} selectedIds={selected} onToggleSelect={m => { if (!busy)
            setSelected(old => { const next = new Set(old); next.has(m.id) ? next.delete(m.id) : next.add(m.id); return next; }); }}/>
   {loading && <p role="status">{t('common.loading')}</p>}
   {items.length < total && <button className={`${button} self-center`} disabled={loading} onClick={() => void loadMore()}>{t('collections.more')}</button>}
  </section>}
  {viewer !== null && <Viewer items={items} startIndex={viewer} total={total} onRequestMore={loadMore} onClose={() => { setViewer(null); refresh(); }}/>}
 </div>;
}
