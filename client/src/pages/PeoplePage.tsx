import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { PersonDto } from "@memorylane/shared";
import { Pencil, X } from "lucide-react";
import { api, ApiError } from "../api/client";
import AnalysisProgress from "../components/AnalysisProgress";
import { useConfirm } from "../components/ConfirmDialog";
import { useTranslation } from "react-i18next";

interface PersonCardProps {
  person: PersonDto;
  removing: boolean;
  onRemove: () => void;
  editing: boolean;
  draftName: string;
  renaming: boolean;
  onEdit: () => void;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function PersonCard({ person: p, removing, onRemove, editing, draftName, renaming, onEdit, onNameChange, onSave, onCancel }: PersonCardProps) {
  const portrait = (
    <div className="size-28 overflow-hidden rounded-full bg-media ring-1 ring-border">
      {p.coverFaceId && <img src={api.faces.cropUrl(p.coverFaceId)} alt="" className="size-full object-cover transition group-hover:scale-105" />}
    </div>
  );
  return (
    <div className="group relative rounded-lg hover:bg-hover focus-within:bg-hover">
      {editing ? (
        <div className="flex flex-col items-center gap-2 rounded-lg p-2">
          {portrait}
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); onSave(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }} className="flex w-full flex-col items-center gap-1.5">
            <input autoFocus aria-label={`Name for ${p.displayName}`} value={draftName} onChange={(e) => onNameChange(e.target.value)} placeholder={p.autoLabel} disabled={renaming} className="w-full rounded-md border border-border bg-page px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent" />
            <div className="flex gap-1 text-xs">
              <button type="submit" disabled={renaming} className="rounded-md bg-accent px-2 py-1 text-page disabled:opacity-40">{renaming ? "Saving…" : "Save"}</button>
              <button type="button" disabled={renaming} onClick={onCancel} className="rounded-md border border-border px-2 py-1 text-ink disabled:opacity-40">Cancel</button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <Link to={`/people/${p.id}`} className="flex flex-col items-center gap-2 rounded-lg p-2">
            {portrait}
            <div className="text-center">
              <div className={`text-sm ${p.name ? "font-medium text-ink" : "text-muted italic"}`}>{p.displayName}</div>
              <div className="text-xs text-faint">{p.mediaCount} photo{p.mediaCount === 1 ? "" : "s"}{p.hidden ? " · hidden" : ""}</div>
            </div>
          </Link>
          <button type="button" aria-label={`Rename ${p.displayName}`} title={`Rename ${p.displayName}`} onClick={onEdit} className="absolute right-9 top-1 flex size-7 items-center justify-center rounded-full border border-border bg-surface text-muted opacity-0 shadow-sm transition hover:text-accent focus:opacity-100 focus:text-accent group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <Pencil size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Remove ${p.displayName}`}
            title={`Remove ${p.displayName}`}
            disabled={removing}
            onClick={onRemove}
            className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-full border border-border bg-surface text-muted opacity-0 shadow-sm transition hover:text-red-600 focus:opacity-100 focus:text-red-600 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-40 [@media(hover:none)]:opacity-100"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

// Everyone the library knows about, unnamed "Person N"s first so the user
// sees what still needs a name. Off = a short explanation, not an empty grid.
export default function PeoplePage() {
  const { t } = useTranslation();
  const [persons, setPersons] = useState<PersonDto[] | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [off, setOff] = useState(false);
  const [finding, setFinding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const load = async (hidden: boolean) => {
    try {
      setPersons(await api.persons.list(hidden));
      setOff(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setOff(true);
      else throw err;
    }
  };

  useEffect(() => {
    void load(includeHidden);
  }, [includeHidden]);

  const findNow = async () => {
    setFinding(true);
    try {
      await api.persons.discover();
      await load(includeHidden);
    } finally {
      setFinding(false);
    }
  };

  const removePerson = async (person: PersonDto) => {
    const ok = await confirm({
      title: `Remove ${person.displayName}?`,
      message: "This removes the person grouping and permanently dismisses its detected faces from automatic discovery. Photos and face detections are not deleted.",
      confirmLabel: "Remove person",
      danger: true,
    });
    if (!ok) return;
    setRemovingId(person.id);
    setRemoveError(null);
    try {
      await api.persons.remove(person.id);
      setPersons((current) => current?.filter((p) => p.id !== person.id) ?? null);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Could not remove this person");
    } finally {
      setRemovingId(null);
    }
  };

  const renamePerson = async (person: PersonDto) => {
    const name = draftName.trim() || null;
    if (name === person.name) {
      setEditingId(null);
      return;
    }
    setRenamingId(person.id);
    setRenameError(null);
    try {
      const updated = await api.persons.rename(person.id, name);
      setPersons((current) => current?.map((p) => p.id === person.id ? updated : p) ?? null);
      setEditingId(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Could not rename this person");
    } finally {
      setRenamingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-ink">{t("pages.people")}</h1>
          <p className="text-sm text-muted">{persons ? `${persons.length} ${persons.length === 1 ? "person" : "people"}` : ""}</p>
        </div>
        {!off && (
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5 text-muted">
              <input type="checkbox" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} className="accent-accent" />
              Show hidden
            </label>
            <button onClick={() => void findNow()} disabled={finding} className="rounded-md border border-border px-3 py-1.5 text-ink hover:bg-hover disabled:opacity-40">
              {finding ? "Looking…" : "Find people now"}
            </button>
          </div>
        )}
      </div>

      {off && (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-ink">
          <p className="font-medium">People is turned off.</p>
          <p className="mt-1 text-muted">
            Face grouping is opt-in because faces are personal data. Turn it on under{" "}
            <Link to="/settings" className="text-accent underline">Settings › People</Link> - everything stays on this machine and can be deleted in one click.
          </p>
        </div>
      )}

      {!off && (
        <div className="max-w-2xl">
          <AnalysisProgress only={["faces"]} />
        </div>
      )}

      {persons && persons.length === 0 && !off && (
        <p className="text-sm text-muted">No people yet - they appear once a few faces of the same person have been found. Use "Find people now" to group what's been found so far.</p>
      )}

      {removeError && <p role="alert" className="text-sm text-red-600">{removeError}</p>}
      {renameError && <p role="alert" className="text-sm text-red-600">{renameError}</p>}

      {persons && persons.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
          {persons.map((p) => (
            <PersonCard
              key={p.id}
              person={p}
              removing={removingId === p.id}
              onRemove={() => void removePerson(p)}
              editing={editingId === p.id}
              draftName={draftName}
              renaming={renamingId === p.id}
              onEdit={() => { setEditingId(p.id); setDraftName(p.name ?? ""); setRenameError(null); }}
              onNameChange={setDraftName}
              onSave={() => void renamePerson(p)}
              onCancel={() => { setEditingId(null); setRenameError(null); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
