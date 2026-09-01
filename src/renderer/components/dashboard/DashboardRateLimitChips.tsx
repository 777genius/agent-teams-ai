import { useAppTranslation } from '@features/localization/renderer';

import type { DashboardRateLimitItem } from './providerDashboardRateLimits';
import type { CliProviderId } from '@shared/types';

interface DashboardRateLimitChipsProps {
  providerId: CliProviderId;
  items: DashboardRateLimitItem[];
  refreshCycle: number;
  refreshing: boolean;
}

export const DashboardRateLimitChips = ({
  providerId,
  items,
  refreshCycle,
  refreshing,
}: DashboardRateLimitChipsProps): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-busy={refreshing}
      aria-label={refreshing ? t('cliStatus.labels.loadingRateLimits') : undefined}
    >
      {items.map((item) => (
        <div
          key={`${providerId}-${item.label}-${refreshCycle}`}
          className={`relative w-fit max-w-full overflow-hidden rounded-md border px-2 py-1.5 ${
            refreshing
              ? 'skeleton-shimmer'
              : refreshCycle > 0
                ? 'dashboard-rate-limit-refreshed'
                : ''
          }`}
          style={{
            borderColor: 'rgba(74, 222, 128, 0.2)',
            backgroundColor: 'rgba(74, 222, 128, 0.035)',
          }}
        >
          <div
            className="dashboard-rate-limit-progress pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
            style={{
              width: `${item.remainingPercent}%`,
              backgroundColor: 'rgba(74, 222, 128, 0.1)',
            }}
            aria-hidden="true"
          />
          <div className="relative z-10 flex items-baseline gap-1.5 whitespace-nowrap">
            <span
              className="text-[10px] uppercase tracking-[0.06em]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {item.label}
            </span>
            <span
              className="text-xs font-medium"
              style={{ color: item.isDepleted ? '#f87171' : '#86efac' }}
            >
              {item.remaining}
            </span>
            <span
              className="min-w-0 truncate text-[10px]"
              style={{ color: 'var(--color-text-secondary)' }}
              title={item.resetsAt}
            >
              • {t('cliStatus.labels.resets', { time: item.resetsAt })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};
