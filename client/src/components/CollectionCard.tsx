import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CollectionDto } from '@memorylane/shared';
import { api } from '../api/client';
import { useHoverPreview, type PreviewFrame } from '../hooks/useHoverPreview';

export default function CollectionCard({ collection, disabled, onOpen }: {
  collection: CollectionDto;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [frames, setFrames] = useState<PreviewFrame[]>([]);
  useEffect(() => {
    let active = true;
    setFrames([]);
    if (collection.count > 0) {
      void api.collections.media(collection.id, 0, 6).then(page => {
        if (active) setFrames(page.items.filter(photo => photo.thumbnailStatus === 'done')
          .map(photo => ({ id: photo.id, thumbnailVersion: photo.thumbnailVersion })));
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [collection.id, collection.count]);
  const load = useCallback(() => Promise.resolve(frames), [frames]);
  const cover = frames[0] ?? null;
  const { frame, onMouseEnter, onMouseLeave } = useHoverPreview(cover, load);
  const display = frame ?? cover;
  const name = collection.builtin ? t('navigation.favorites') : collection.name;
  return <button disabled={disabled} onClick={onOpen} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    className="group overflow-hidden rounded-xl bg-surface text-left ring-1 ring-border transition hover:-translate-y-0.5 hover:shadow-xl">
    <div className="relative aspect-[4/3] overflow-hidden bg-media">
      {display ? <img src={api.media.thumbnailUrl(display.id, display.thumbnailVersion)} alt="" loading="lazy"
        className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
        : <div className="flex h-full items-center justify-center text-5xl opacity-40">{collection.builtin ? '★' : '📁'}</div>}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 truncate p-4 font-serif text-2xl font-semibold text-white">{name}</div>
    </div>
    <div className="p-4 text-sm text-muted">{t('collections.items', { count: collection.count })}</div>
  </button>;
}
