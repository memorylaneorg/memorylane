import { useEffect, useRef, useState } from 'react';
import FolderCard from './FolderCard';
import { useTranslation } from 'react-i18next';
import type { FolderDto, FolderBreadcrumbDto, MediaDto } from '@memorylane/shared';
import { api } from '../api/client';
import MediaGrid from './MediaGrid';

const button = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink hover:bg-hover disabled:opacity-50';
const PAGE_SIZE = 100;

export default function CollectionPhotoPicker({ collectionId, onAdded, onClose }: {
  collectionId: number;
  onAdded: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [folderId, setFolderId] = useState<number | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<FolderBreadcrumbDto[]>([]);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [folderTotal, setFolderTotal] = useState(0);
  const [photos, setPhotos] = useState<MediaDto[]>([]);
  const [photoTotal, setPhotoTotal] = useState(0);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [recursive, setRecursive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const paging = useRef(false);
  const saving = useRef(false);

  useEffect(() => {
    const version = ++generation.current;
    setLoading(true); setError(''); setFolders([]); setPhotos([]);
    setFolderTotal(0); setPhotoTotal(0); setBreadcrumbs([]); setRecursive(false);
    paging.current = true;
    const load = async () => {
      if (folderId === null) {
        const roots = await api.folders.listTop();
        if (version !== generation.current) return;
        setFolders(roots); setFolderTotal(roots.length);
      } else {
        const [detail, children, media] = await Promise.all([
          api.folders.get(folderId), api.folders.children(folderId, 0, PAGE_SIZE),
          // Selecting photos must expose every frame, including hidden stack members.
          api.folders.media(folderId, 0, PAGE_SIZE, false, 'photo', true),
        ]);
        if (version !== generation.current) return;
        setBreadcrumbs(detail.breadcrumbs); setFolders(children.items); setFolderTotal(children.total);
        setPhotos(media.items); setPhotoTotal(media.total);
      }
    };
    void load().catch(e => { if (version === generation.current) setError(String(e)); })
      .finally(() => { if (version === generation.current) { setLoading(false); paging.current = false; } });
    return () => { generation.current++; };
  }, [folderId, reload]);

  async function loadMore(kind: 'folders' | 'photos') {
    if (folderId === null || paging.current || busy) return;
    const version = generation.current;
    paging.current = true; setLoading(true); setError('');
    try {
      if (kind === 'folders') {
        const page = await api.folders.children(folderId, folders.length, PAGE_SIZE);
        if (version === generation.current) { setFolders(old => [...old, ...page.items]); setFolderTotal(page.total); }
      } else {
        const page = await api.folders.media(folderId, photos.length, PAGE_SIZE, false, 'photo', true);
        if (version === generation.current) { setPhotos(old => [...old, ...page.items]); setPhotoTotal(page.total); }
      }
    } catch (e) { if (version === generation.current) setError(String(e)); }
    finally { if (version === generation.current) { paging.current = false; setLoading(false); } }
  }

  async function add(mediaIds?: number[]) {
    if (saving.current || (!mediaIds && folderId === null)) return;
    saving.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.collections.add(collectionId, mediaIds
        ? { mediaIds } : { folderId: folderId!, recursive });
      setAdded(old => new Set([...old, ...(mediaIds ?? photos.map(photo => photo.id))]));
      setMessage(t('collections.added', { count: result.added }));
      onAdded();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; setBusy(false); }
  }

  const navigate = (id: number | null) => { if (!busy) { setFolderId(id); setMessage(''); } };
  return <section aria-label={t('collectionPicker.title')} className="space-y-4 rounded-xl border border-border bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-serif text-xl text-ink">{t('collectionPicker.title')}</h3><p className="text-sm text-muted">{t('collectionPicker.help')}</p></div>
      <button className={button} disabled={busy} onClick={onClose}>{t('common.close')}</button>
    </div>
    <nav aria-label={t('collectionPicker.folderNavigation')} className="flex flex-wrap items-center gap-2 text-sm">
      <button className="text-accent underline disabled:opacity-50" disabled={busy} onClick={() => navigate(null)}>{t('collectionPicker.allFolders')}</button>
      {breadcrumbs.map(crumb => <span key={crumb.id}> / <button className="text-accent underline disabled:opacity-50" aria-current={crumb.id === folderId ? 'location' : undefined} disabled={busy} onClick={() => navigate(crumb.id)}>{crumb.name}</button></span>)}
    </nav>
    {error && <div role="alert" className="text-red-600">{error} <button className={button} disabled={busy || loading} onClick={() => setReload(v => v + 1)}>{t('common.retry')}</button></div>}
    {message && <p role="status" className="text-sm text-muted">{message}</p>}
    <div className="max-h-[55vh] space-y-4 overflow-y-auto p-1">
      {folders.length > 0 && <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">{folders.map(folder => <FolderCard key={folder.id} folder={folder} disabled={busy} onOpen={() => navigate(folder.id)}/>)}</div>}
      {folders.length < folderTotal && <button className={button} disabled={busy || loading} onClick={() => void loadMore('folders')}>{t('collectionPicker.moreFolders')}</button>}
      {folderId !== null && <>
        <div className="flex flex-wrap items-center gap-2">

          <span className="text-sm text-muted">{t('common.photos', { count: photoTotal })}</span>
        </div>
        <MediaGrid items={photos} showFavorite={false} disabled={busy} onOpen={index => { const photo = photos[index]; if (!added.has(photo.id)) void add([photo.id]); }} captions={Object.fromEntries([...added].map(id => [id, t('collectionPicker.saved')]))}/>

        {!loading && !photos.length && <p className="text-sm text-muted">{t('collectionPicker.noPhotos')}</p>}
        {photos.length < photoTotal && <button className={button} disabled={busy || loading} onClick={() => void loadMore('photos')}>{t('collections.more')}</button>}
      </>}
      {loading && <p role="status" className="text-sm text-muted">{t('common.loading')}</p>}
      {!loading && folderId === null && !folders.length && <p className="text-sm text-muted">{t('coreBrowse.home.noFolders')}</p>}
    </div>
    {folderId !== null && !loading && !error && <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={busy} onClick={() => void add()}>{t('collectionPicker.addFolder')}</button><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={recursive} onChange={e => setRecursive(e.target.checked)}/>{t('collections.recursive')}</label></div>
      <p className="text-sm text-muted">{t('collections.snapshot')}</p>
    </div>}
  </section>;
}
