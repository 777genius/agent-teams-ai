import { useAppTranslation } from '@features/localization/renderer';
import { Loader2 } from 'lucide-react';

export const TimelineLoadingState = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      className="rounded-md border border-[var(--color-border)] p-3 pl-5 text-xs text-[var(--color-text-muted)]"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Loader2 size={13} className="animate-spin" />
        <span>{t('activity.timeline.loadingMessages')}</span>
      </div>
      <div className="mt-3 space-y-2" aria-hidden="true">
        <div className="h-3 w-3/4 animate-pulse rounded bg-[var(--color-surface-raised)]" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-surface-raised)]" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--color-surface-raised)]" />
      </div>
    </div>
  );
};

export const TimelineEmptyState = ({
  label,
  hint,
}: {
  label?: string;
  hint?: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div className="rounded-md border border-[var(--color-border)] p-3 pl-5 text-xs text-[var(--color-text-muted)]">
      <p>{label ?? t('activity.timeline.noMessages')}</p>
      {hint === '' ? null : (
        <p className="mt-1 text-[11px]">{hint ?? t('activity.timeline.emptyHint')}</p>
      )}
    </div>
  );
};
