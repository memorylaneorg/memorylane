import { useTranslation } from 'react-i18next';
import type { TvSharingStatusDto } from '@memorylane/shared';

export function PreviewUpgradeStatus({ diagnostics, enabled, busy, dirty, onRetry, onToggle, canResume = true }: {
  diagnostics: TvSharingStatusDto['diagnostics']; enabled: boolean; busy: boolean; dirty: boolean; onRetry: () => void; onToggle?: () => void; canResume?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const counts = diagnostics.previews;
  if (!counts) return null;
  const waiting = diagnostics.previewStorage?.retryPending ?? 0;
  const outstanding = counts.queued + counts.running + waiting;
  const needsRetry = Math.max(0, counts.failed + (counts.blocked ?? 0) - waiting);
  const total = counts.ready + counts.limited + counts.failed + (counts.blocked ?? 0) + counts.queued + counts.running;
  const processed = Math.max(0, total - outstanding);
  const number = (n: number) => new Intl.NumberFormat(i18n.resolvedLanguage).format(n);
  const state = !enabled ? (canResume ? 'statusPaused' : 'sharingOff') : outstanding > 0
    ? needsRetry > 0 ? 'statusWorkingWithFailures' : 'statusWorking'
    : needsRetry > 0 ? 'statusNeedsAction' : 'statusComplete';
  return <div className="space-y-2" role="status" aria-live="polite">
    <p className="font-medium">{t(`previewUpgrade.${state}`)}</p>
    {total > 0 && <div className="space-y-1">
      <progress className="block h-2 w-full overflow-hidden rounded-full accent-blue-500" max={total} value={processed} aria-label={t('previewUpgrade.progressLabel')} />
      <p className="text-xs text-muted">{t('previewUpgrade.compactProgress', {done:number(processed),total:number(total)})}</p>
    </div>}
    {onToggle && (enabled || canResume) && (outstanding > 0 || !enabled) && <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50" disabled={busy} onClick={onToggle}>{t(enabled ? 'previewUpgrade.pause' : 'previewUpgrade.resume')}</button>}
    {needsRetry > 0 && <p className="text-sm">{t('previewUpgrade.needsRetry', {photos: number(needsRetry)})}</p>}
    {enabled && needsRetry > 0 && outstanding === 0 && <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50" disabled={busy || dirty} onClick={onRetry}>{t(busy ? 'previewUpgrade.requestingRetry' : 'previewUpgrade.retryAll')}</button>}
  </div>;
}
