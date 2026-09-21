import { useEffect, useRef, useState } from "react";
import type { AnalysisStatusDto, AnalyzerStatusDto } from "@memorylane/shared";
import { api } from "../api/client";

const LABELS: Record<string, string> = {
  exif_full: "EXIF metadata",
  phash: "Visual fingerprints (stacks)",
  embed_image: "AI embeddings (similar, search, stacks)",
  ai_tags: "AI photo tags",
  import_tags: "Imported keywords",
  faces: "Faces (People)",
};

export const analysisBusy = (a: AnalysisStatusDto | null) =>
  !!a && a.analyzers.some((x) => x.enabled && (x.counts.pending > 0 || x.counts.running > 0));

function total(a: AnalyzerStatusDto): number {
  const c = a.counts;
  return c.pending + c.running + c.done + c.failed + c.unsupported;
}

function state(a: AnalyzerStatusDto, paused: boolean): { label: string; tone: "muted" | "accent" | "amber" | "red" | "green" } {
  const c = a.counts;
  const left = c.pending + c.running;
  if (!a.enabled) return { label: "Off", tone: "muted" };
  if (a.backoffUntil) return { label: "Waiting for sidecar", tone: "amber" };
  if (paused && left > 0) return { label: "Paused during scan", tone: "muted" };
  // Mostly failing while still "working" means something systemic (a volume
  // that can't be read) - say so instead of promising an ETA.
  if (left > 0 && c.failed > c.done && c.failed >= 20) return { label: "Failing", tone: "red" };
  if (left > 0) return { label: "Working", tone: "accent" };
  if (c.failed > 0) return { label: "Needs retry", tone: "red" };
  return { label: "Done", tone: "green" };
}

const toneClass = {
  muted: "bg-chip text-muted",
  accent: "bg-accent/15 text-accent",
  amber: "bg-amber-500/15 text-amber-600",
  red: "bg-red-500/15 text-red-600",
  green: "bg-green-500/15 text-green-700",
};

function formatEta(seconds: number): string {
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(1)} h`;
}

interface AnalysisProgressProps {
  // Optional: only show these analyzers (e.g. the People page shows faces only).
  only?: string[];
  onStatus?: (status: AnalysisStatusDto) => void;
  pollMs?: number;
  // Render nothing once every shown analyzer is done without failures - for
  // pages that only need a "still working" banner (Reports, People).
  hideWhenDone?: boolean;
}

// Live progress for the background analysis queue. Polls while anything is
// outstanding, estimates time left from the rate between polls, and stops
// polling once everything is done or off.
export default function AnalysisProgress({ only, onStatus, pollMs = 3000, hideWhenDone = false }: AnalysisProgressProps) {
  const [status, setStatus] = useState<AnalysisStatusDto | null>(null);
  const [eta, setEta] = useState<Record<string, number>>({});
  const last = useRef<{ at: number; done: Record<string, number> } | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let st: AnalysisStatusDto;
      try {
        st = await api.analysis.status();
      } catch {
        return;
      }
      if (!active) return;
      const now = Date.now();
      const done = Object.fromEntries(st.analyzers.map((a) => [a.key, a.counts.done + a.counts.failed + a.counts.unsupported]));
      if (last.current) {
        const dt = (now - last.current.at) / 1000;
        const next: Record<string, number> = {};
        for (const a of st.analyzers) {
          const rate = (done[a.key] - (last.current.done[a.key] ?? done[a.key])) / dt;
          const left = a.counts.pending + a.counts.running;
          if (rate > 0 && left > 0) next[a.key] = left / rate;
        }
        setEta((prev) => ({ ...prev, ...next }));
      }
      last.current = { at: now, done };
      setStatus(st);
      onStatus?.(st);
      const anyPending = st.analyzers.some((a) => a.counts.pending > 0 || a.counts.running > 0);
      if (analysisBusy(st)) timer = setTimeout(tick, pollMs);
      else if (anyPending) timer = setTimeout(tick, pollMs * 5); // disabled-but-pending: slow poll
    };
    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);

  if (!status) return hideWhenDone ? null : <p className="text-sm text-muted">Loading…</p>;
  const rows = status.analyzers.filter((a) => !only || only.includes(a.key));
  if (rows.length === 0) return hideWhenDone ? null : <p className="text-sm text-muted">Nothing to analyse yet.</p>;
  if (hideWhenDone && rows.every((a) => a.counts.pending + a.counts.running + a.counts.failed === 0)) return null;

  return (
    <div className="flex flex-col gap-3">
      {status.paused && <p className="text-xs text-muted">A scan is running - analysis resumes when it finishes.</p>}
      {rows.map((a) => {
        const n = total(a);
        // Only successes count toward the bar - "100%" with thousands failed is a lie.
        const finished = a.counts.done + a.counts.unsupported;
        const pct = n === 0 ? 0 : Math.round((finished / n) * 100);
        const s = state(a, status.paused);
        const left = a.counts.pending + a.counts.running;
        return (
          <div key={a.key} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-ink">
                {LABELS[a.key] ?? a.key} <span className="text-xs text-faint">{a.version}</span>
              </span>
              <span className="flex items-center gap-2 text-xs tabular-nums text-muted">
                {finished.toLocaleString()} / {n.toLocaleString()} · {pct}%
                {s.label === "Working" && eta[a.key] !== undefined && <span>· {formatEta(eta[a.key])} left</span>}
                {a.counts.failed > 0 && <span className="text-red-600">· {a.counts.failed.toLocaleString()} failed</span>}
                <span className={`rounded-full px-2 py-0.5 font-medium ${toneClass[s.tone]}`}>{s.label}</span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-chip" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={LABELS[a.key] ?? a.key}>
              <div
                className={`h-full rounded-full transition-[width] duration-700 ${s.tone === "accent" ? "bg-accent" : s.tone === "amber" ? "bg-amber-500" : s.tone === "muted" ? "bg-faint" : "bg-green-600"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {!a.enabled && left > 0 && a.key === "faces" && (
              <p className="text-xs text-muted">Turn on People below to start finding faces.</p>
            )}
            {!a.enabled && a.key === "embed_image" && <p className="text-xs text-muted">AI analysis is switched off above.</p>}
            {a.counts.failed > 0 && (
              <p className="text-xs text-muted">
                {a.counts.failed.toLocaleString()} file{a.counts.failed === 1 ? "" : "s"} failed
                {a.lastError && (
                  <>
                    {" "}- last error: <code className="text-ink">{a.lastError}</code>
                  </>
                )}
                . {/opening file|permission|EPERM|EACCES|ENOENT/i.test(a.lastError ?? "")
                  ? "The files exist but this process can't open them - on macOS, the app you started MemoryLane from needs access to that volume (System Settings › Privacy & Security › Files and Folders › Network/Removable Volumes), or start it from Terminal. "
                  : ""}
                Fix the cause, then use Retry failed under Settings › Analysis.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
