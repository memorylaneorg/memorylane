import { useEffect, useRef, useState } from 'react';
import { Folder, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DirectoryBrowseDto } from '@memorylane/shared';
import { api } from '../api/client';

const button = 'rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-40';
export default function FolderPicker({initialPath, onChoose, onClose}: {initialPath?: string; onChoose:(path:string)=>void; onClose:()=>void}) {
  const {t} = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const [result, setResult] = useState<DirectoryBrowseDto>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(path?: string, offset=0) {
    const version = ++request.current;
    setBusy(true); setError('');
    try {
      const next = await api.scanRoots.browseDirectories(path, offset);
      if (version === request.current) setResult(previous => offset && previous?.path === next.path ? {...next, folders:[...previous.folders,...next.folders]} : next);
    } catch(cause) { if(version === request.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {if(version === request.current) setBusy(false);}
  }
  useEffect(()=>{
    dialog.current?.showModal();
    void load(initialPath?.trim() || undefined);
    return ()=>{request.current++;};
  }, [initialPath]);
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="folder-picker-title" className="w-[min(36rem,95vw)] rounded-xl border border-border bg-surface p-5 text-ink shadow-card backdrop:bg-black/60">
    <h2 id="folder-picker-title" className="text-lg font-semibold">{t('folderPicker.title')}</h2>
    <p className="mt-1 text-sm text-muted">{t('folderPicker.help')}</p>
    <div className="my-3 flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={()=>void load()}>{t('folderPicker.home')}</button>
      {result?.locations.filter(location=>location.name!=='home').map(location=><button key={location.path} className={button} disabled={busy} onClick={()=>void load(location.path)}>{t(`folderPicker.${location.name}`)}{location.name==='drives' && result.locations.filter(item=>item.name==='drives').length>1 ? ` (${location.path})` : ''}</button>)}
    </div>
    {result && <div className="mb-2 flex items-center gap-2"><button className={button} disabled={busy || !result.parent} onClick={()=>void load(result.parent!)}>{t('folderPicker.up')}</button><p className="min-w-0 break-all text-sm">{result.path}</p></div>}
    {error && <p role="alert" className="mb-2 text-sm text-red-500">{error}</p>}
    <div className="h-64 overflow-auto rounded-lg border border-border" aria-busy={busy}>
      {result?.folders.map(folder=><button key={folder.path} disabled={busy} onClick={()=>void load(folder.path)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover disabled:opacity-50"><Folder size={17}/><span className="min-w-0 flex-1 break-all">{folder.name}</span><ChevronRight size={16}/></button>)}
      {busy && <p role="status" className="p-3 text-sm text-muted">{t('common.loading')}</p>}
      {!busy && result?.folders.length===0 && <p className="p-3 text-sm text-muted">{t('folderPicker.empty')}</p>}
      {result?.nextOffset!=null && <button className={`${button} m-2`} disabled={busy} onClick={()=>void load(result.path,result.nextOffset!)}>{t('folderPicker.more')}</button>}
    </div>
    <div className="mt-4 flex justify-end gap-2"><button className={button} onClick={onClose}>{t('common.cancel')}</button><button className={button} disabled={busy || !result || !!error} onClick={()=>onChoose(result!.path)}>{t('folderPicker.choose')}</button></div>
  </dialog>;
}
