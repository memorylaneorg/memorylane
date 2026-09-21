export default function PluginInstallProgress({ label }: { label: string }) {
  return <div className="mt-3" role="status" aria-live="polite">
    <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted">
      <span>{label}</span><span>Please keep MemoryLane open</span>
    </div>
    <div className="h-2 overflow-hidden rounded-full bg-chip" role="progressbar" aria-label={label}>
      <div className="plugin-install-progress h-full w-2/5 rounded-full bg-accent" />
    </div>
  </div>;
}
