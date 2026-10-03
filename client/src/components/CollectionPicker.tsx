import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CollectionDto } from '@memorylane/shared';
import { api } from '../api/client';
const control = 'rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink disabled:opacity-50';
export default function CollectionPicker({ mediaIds, folderId, onAdded }: {
    mediaIds?: number[];
    folderId?: number;
    onAdded?: () => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false), [collections, setCollections] = useState<CollectionDto[]>([]), [id, setId] = useState(''), [name, setName] = useState(''), [recursive, setRecursive] = useState(true), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
    useEffect(() => {
        if (!open)
            return;
        let active = true;
        setLoading(true);
        setError('');
        void api.collections.list().then(rows => { if (active)
            setCollections(rows.filter(c => !c.builtin)); }).catch(e => { if (active)
            setError(String(e)); }).finally(() => { if (active)
            setLoading(false); });
        return () => { active = false; };
    }, [open]);
    async function add(event: React.FormEvent) {
        event.preventDefault();
        if (busy)
            return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            let collectionId = Number(id);
            if (!id) {
                const created = await api.collections.create(name);
                collectionId = Number(created.id);
                setCollections(rows => [...rows, created]);
                setId(String(collectionId));
                setName('');
            }
            const result = await api.collections.add(collectionId, folderId !== undefined ? { folderId, recursive } : { mediaIds: mediaIds ?? [] });
            setMessage(t('collections.added', { count: result.added }));
            setOpen(false);
            onAdded?.();
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="relative text-sm" onKeyDown={event => event.stopPropagation()}>
  <button type="button" className={control} disabled={busy || (folderId === undefined && !mediaIds?.length)} aria-expanded={open} onClick={() => { setOpen(!open); setMessage(''); }}>{t(folderId === undefined ? 'collections.addTo' : 'collections.addFolder')}</button>
  {message && <p role="status" className="mt-1 text-muted">{message}</p>}
  {open && <form onSubmit={event => void add(event)} className="mt-2 flex max-w-sm flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-ink shadow-card">
   <label>{t('collections.destination')}<select className={`${control} mt-1 w-full`} disabled={busy || loading} value={id} onChange={e => setId(e.target.value)}><option value="">{t('collections.new')}</option>{collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   {!id && <label>{t('collections.name')}<input className={`${control} mt-1 w-full`} disabled={busy} required maxLength={80} value={name} onChange={e => setName(e.target.value)}/></label>}
   {folderId !== undefined && <><label className="flex items-center gap-2"><input type="checkbox" checked={recursive} disabled={busy} onChange={e => setRecursive(e.target.checked)}/>{t('collections.recursive')}</label><p className="text-muted">{t('collections.snapshot')}</p></>}
   {error && <p role="alert" className="text-red-600">{error}</p>}
   <div className="flex gap-2"><button className={control} disabled={busy || loading || (!id && !name.trim())}>{t(busy ? 'common.loading' : 'common.add')}</button><button type="button" className={control} disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
  </form>}
 </div>;
}
