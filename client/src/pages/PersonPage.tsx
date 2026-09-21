import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { FaceDto, MediaDto, PersonDto } from "@memorylane/shared";
import { api } from "../api/client";
import FaceChip from "../components/FaceChip";
import MediaGrid from "../components/MediaGrid";
import Viewer from "../components/Viewer";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useConfirm } from "../components/ConfirmDialog";

const PAGE_SIZE = 200;
const inputClass = "rounded-lg border border-border bg-page px-3 py-1.5 text-ink outline-none focus:border-accent";
const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-40";

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const personId = Number(id);
  const navigate = useNavigate();
  const [person, setPerson] = useState<PersonDto | null>(null);
  const [faces, setFaces] = useState<FaceDto[]>([]);
  const [others, setOthers] = useState<PersonDto[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [media, setMedia] = useState<MediaDto[] | null>(null);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const { confirm } = useConfirm();

  const filters = { personIds: String(personId), from: from || undefined, to: to || undefined };

  const load = useCallback(async () => {
    const [detail, all] = await Promise.all([api.persons.get(personId), api.persons.list(true)]);
    // Merged persons resolve to their target - follow the redirect in the URL too.
    if (detail.person.id !== personId) {
      navigate(`/people/${detail.person.id}`, { replace: true });
      return;
    }
    setPerson(detail.person);
    setFaces(detail.faces);
    setName(detail.person.name ?? "");
    setOthers(all.filter((p) => p.id !== detail.person.id));
  }, [personId, navigate]);

  const loadMedia = useCallback(async () => {
    const res = await api.media.list({ personIds: String(personId), from: from || undefined, to: to || undefined }, 0, PAGE_SIZE);
    setMedia(res.items);
    setMediaTotal(res.total);
  }, [personId, from, to]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setMedia(null);
    void loadMedia();
  }, [loadMedia]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || media === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await api.media.list(filters, media.length, PAGE_SIZE);
      setMedia((prev) => [...(prev ?? []), ...res.items]);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, personId, from, to]);
  const hasMore = media !== null && media.length < mediaTotal;
  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    setPerson(await api.persons.rename(personId, trimmed ? trimmed : null));
    setEditing(false);
  };

  const refreshAll = async () => {
    await load();
    await loadMedia();
  };

  if (!person) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="size-24 overflow-hidden rounded-full bg-media ring-1 ring-border">
          {person.coverFaceId && <img src={api.faces.cropUrl(person.coverFaceId)} alt="" className="size-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <Link to="/people" className="text-xs text-muted hover:text-ink">← People</Link>
          {editing ? (
            <form onSubmit={saveName} className="mt-1 flex items-center gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={person.autoLabel} className={inputClass} />
              <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-sm text-page">Save</button>
              <button type="button" onClick={() => setEditing(false)} className={buttonClass}>Cancel</button>
            </form>
          ) : (
            <button onClick={() => setEditing(true)} title="Click to rename" className="mt-1 block text-left font-serif text-2xl font-semibold text-ink hover:text-accent">
              {person.displayName}
              {!person.name && <span className="ml-2 text-sm font-normal text-muted">(click to name)</span>}
            </button>
          )}
          <p className="text-sm text-muted">{person.mediaCount} photos · {person.faceCount} faces{person.hidden ? " · hidden" : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button className={buttonClass} onClick={async () => { setPerson(await api.persons.setHidden(personId, !person.hidden)); }}>
            {person.hidden ? "Unhide" : "Hide"}
          </button>
          <button
            className={`${buttonClass} text-red-600`}
            disabled={removing}
            onClick={async () => {
              const ok = await confirm({
                title: `Remove ${person.displayName}?`,
                message: "This removes the person grouping and permanently dismisses its detected faces from automatic discovery. Photos and face detections are not deleted.",
                confirmLabel: "Remove person",
                danger: true,
              });
              if (!ok) return;
              setRemoving(true);
              setRemoveError(null);
              try {
                await api.persons.remove(personId);
                navigate("/people", { replace: true });
              } catch (err) {
                setRemoveError(err instanceof Error ? err.message : "Could not remove this person");
              } finally {
                setRemoving(false);
              }
            }}
          >
            {removing ? "Removing…" : "Remove person"}
          </button>
          {others.length > 0 && (
            <select
              className={inputClass}
              defaultValue=""
              onChange={async (e) => {
                const target = Number(e.target.value);
                if (!target) return;
                const into = others.find((o) => o.id === target)?.displayName;
                const ok = await confirm({
                  title: `Merge into ${into}?`,
                  message: `All of ${person.displayName}'s faces move to ${into}. This can't be split apart automatically afterwards.`,
                  confirmLabel: "Merge",
                });
                if (ok) {
                  const merged = await api.persons.merge(target, personId);
                  navigate(`/people/${merged.id}`, { replace: true });
                } else e.target.value = "";
              }}
            >
              <option value="">Merge into…</option>
              {others.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          )}
        </div>
        {removeError && <p role="alert" className="w-full text-sm text-red-600">{removeError}</p>}
      </div>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Faces</h2>
        <div className="flex flex-wrap gap-2">
          {faces.map((f) => (
            <FaceChip
              key={f.id}
              face={f}
              onConfirm={async () => { await api.faces.assign(f.id, personId); await refreshAll(); }}
              onReject={async () => { await api.faces.reject(f.id, personId); await refreshAll(); }}
              onOpen={() => {
                const idx = media?.findIndex((m) => m.id === f.mediaId) ?? -1;
                if (idx >= 0) setViewerIndex(idx);
              }}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">Hover a face to confirm it (✓) or say it isn't {person.displayName} (✗). Your answers are never overridden by automatic grouping.</p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Photos</h2>
          <label className="flex items-center gap-1.5 text-muted">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} /></label>
          <label className="flex items-center gap-1.5 text-muted">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} /></label>
          {(from || to) && <button className="text-xs text-muted underline" onClick={() => { setFrom(""); setTo(""); }}>Clear dates</button>}
        </div>
        {media === null && <p className="text-sm text-muted">Loading photos…</p>}
        {media && media.length === 0 && <p className="text-sm text-muted">No photos in this range.</p>}
        {media && media.length > 0 && <MediaGrid items={media} onOpen={setViewerIndex} />}
        {hasMore && <div ref={sentinelRef} className="min-h-[40px]" />}
      </section>

      {media && viewerIndex !== null && (
        <Viewer items={media} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} total={mediaTotal} onRequestMore={loadMore} />
      )}
    </div>
  );
}
