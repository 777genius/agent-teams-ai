import { useAppTranslation } from '@features/localization/renderer';

import { namedTeamId } from '../../contracts';

import type { TokenUsageBudgetStatusDto } from '../../contracts';
import type React from 'react';

interface TeamBudgetProgressProps {
  teamName: string;
  status: TokenUsageBudgetStatusDto | null;
}

export function TeamBudgetProgress({ teamName, status }: TeamBudgetProgressProps): React.JSX.Element | null {
  const { t } = useAppTranslation('dashboard');
  const target = status?.targets.find(
    (item) => item.scope === 'team' && item.id === namedTeamId(teamName)
  );
  if (!target?.metrics.length) return null;
  // A confirmed exceeded counter takes precedence over an incomplete estimate.
  const exceededMetrics = target.metrics.filter(
    (metric) => !metric.incomplete && metric.value !== null && metric.value >= metric.limit
  );
  const candidates = exceededMetrics.length ? exceededMetrics : target.metrics;
  const metric = candidates.reduce((best, current) =>
    (current.percent ?? -1) > (best.percent ?? -1) ? current : best
  );
  const reached = target.metrics.some(
    (item) => !item.incomplete && item.value !== null && item.value >= item.limit
  );
  const uncertain = !reached && Boolean(
    status?.stale || status?.degraded ||
    target.metrics.some((item) => item.incomplete || item.value === null)
  );
  const enforced = (target.onExceeded ?? 'notify') !== 'notify';
  const display = (amount: number | null): string => {
    if (amount === null) return '?';
    return metric.metric === 'apiEquivalentCostUsd'
      ? `$${amount.toFixed(2)}`
      : Intl.NumberFormat().format(Math.round(amount));
  };
  const value = `${display(metric.value)} / ${display(metric.limit)}`;
  const label = uncertain
    ? t('tokenUsage.budgets.teamCardUnknown')
    : reached && enforced
      ? t('tokenUsage.budgets.teamCardBlocked')
      : reached
        ? t('tokenUsage.budgets.critical')
        : t('tokenUsage.budgets.teamCardBudget');
  const barClass = uncertain
    ? 'bg-gray-500/50'
    : reached
      ? 'bg-red-400'
      : 'bg-emerald-500/70';

  return (
    <div className="mt-2 space-y-1" aria-label={`${label}: ${value}`}>
      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-muted)]">
        <span className={reached ? 'text-red-400' : undefined}>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded bg-[var(--color-surface-raised)]">
        <div className={`h-full rounded ${barClass}`} style={{ width: uncertain ? '0%' : `${Math.min(100, Math.max(0, metric.percent ?? 0))}%` }} />
      </div>
    </div>
  );
}
