import { memo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import type { RuntimeDisplayState, TeamRuntimeDisplayRow } from './teamRuntimeDisplayRows';

interface LiveRuntimeStatusSectionProps {
  rows: readonly TeamRuntimeDisplayRow[];
}

const STATE_CLASS_NAMES: Record<RuntimeDisplayState, string> = {
  running: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  starting: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  waiting: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  degraded: 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  stopped: 'border-zinc-500/25 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
  unknown: 'border-zinc-500/20 bg-zinc-500/5 text-zinc-600 dark:text-zinc-400',
};

export const LiveRuntimeStatusSection = memo(function LiveRuntimeStatusSection({
  rows,
}: LiveRuntimeStatusSectionProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  if (rows.length === 0) return null;

  return (
    <div className="space-y-3" aria-label={t('liveRuntimeStatus.title')}>
      <span className="sr-only">{t('liveRuntimeStatus.title')}</span>
      <p className="text-muted-foreground text-xs">{t('liveRuntimeStatus.description')}</p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <article
            key={row.memberName}
            className="border-border/70 bg-card/50 rounded-lg border p-3 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-foreground truncate text-sm font-medium">{row.memberName}</div>
                <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                  {row.stateReason}
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATE_CLASS_NAMES[row.state]}`}
              >
                {t(`liveRuntimeStatus.states.${row.state}`)}
              </span>
            </div>

            <div className="text-muted-foreground mt-3 flex flex-wrap gap-1.5 text-[11px]">
              <span className="bg-muted rounded-full px-2 py-0.5">
                {t('liveRuntimeStatus.source', { source: row.source })}
              </span>
              {row.runtimeModel ? (
                <span className="bg-muted rounded-full px-2 py-0.5">{row.runtimeModel}</span>
              ) : null}
              {row.laneKind ? (
                <span className="bg-muted rounded-full px-2 py-0.5">
                  {t('liveRuntimeStatus.lane', { lane: row.laneKind })}
                </span>
              ) : null}
              {row.pidLabel ? (
                <span
                  className="bg-muted rounded-full px-2 py-0.5"
                  title={t('liveRuntimeStatus.diagnosticOnly')}
                >
                  {row.pidLabel}
                </span>
              ) : null}
              {row.updatedAt ? (
                <span className="bg-muted rounded-full px-2 py-0.5">
                  {t('liveRuntimeStatus.updated', {
                    value: formatRuntimeUpdatedAt(row.updatedAt),
                  })}
                </span>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
});

function formatRuntimeUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;

  const secondsAgo = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (secondsAgo < 60) return `${secondsAgo}s ago`;

  const minutesAgo = Math.round(secondsAgo / 60);
  if (minutesAgo < 60) return `${minutesAgo}m ago`;

  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
