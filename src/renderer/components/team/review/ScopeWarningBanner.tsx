import { type JSX, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, ChevronRight, Info, ShieldCheck, X } from 'lucide-react';

import { ConfidenceBadge } from './ConfidenceBadge';

import type { TaskScopeConfidence } from '@shared/types';
import type { FC } from 'react';

interface ScopeWarningBannerProps {
  warnings: string[];
  confidence: TaskScopeConfidence;
  sourceKind?: 'ledger' | 'legacy';
  onDismiss?: () => void;
}

interface TierConfig {
  Icon: FC<{ className?: string }>;
  border: string;
  bg: string;
  accentColor: string;
  title: string;
  detail: string;
  badgeLabel?: string;
}

export const ScopeWarningBanner = ({
  warnings,
  confidence,
  sourceKind = 'legacy',
  onDismiss,
}: ScopeWarningBannerProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  const [expanded, setExpanded] = useState(false);
  const tierConfigs: Record<number, TierConfig> = {
    1: {
      Icon: ShieldCheck,
      border: 'border-emerald-500/15',
      bg: 'bg-emerald-500/5',
      accentColor: 'text-emerald-400',
      title: t('review.scope.tiers.exact.title'),
      detail: t('review.scope.tiers.exact.detail'),
    },
    2: {
      Icon: Info,
      border: 'border-blue-500/15',
      bg: 'bg-blue-500/5',
      accentColor: 'text-blue-400',
      title: t('review.scope.tiers.endEstimated.title'),
      detail: t('review.scope.tiers.endEstimated.detail'),
    },
    3: {
      Icon: AlertTriangle,
      border: 'border-orange-500/20',
      bg: 'bg-orange-500/5',
      accentColor: 'text-orange-400',
      title: t('review.scope.tiers.startEstimated.title'),
      detail: t('review.scope.tiers.startEstimated.detail'),
    },
    4: {
      Icon: AlertTriangle,
      border: 'border-red-500/20',
      bg: 'bg-red-500/5',
      accentColor: 'text-red-400',
      title: t('review.scope.tiers.allSession.title'),
      detail: t('review.scope.tiers.allSession.detail'),
    },
  };
  const ledgerConfig: TierConfig | null =
    sourceKind === 'ledger'
      ? {
          Icon: confidence.tier <= 1 ? ShieldCheck : confidence.tier === 2 ? Info : AlertTriangle,
          border:
            confidence.tier <= 1
              ? 'border-emerald-500/15'
              : confidence.tier === 2
                ? 'border-blue-500/15'
                : 'border-orange-500/20',
          bg:
            confidence.tier <= 1
              ? 'bg-emerald-500/5'
              : confidence.tier === 2
                ? 'bg-blue-500/5'
                : 'bg-orange-500/5',
          accentColor:
            confidence.tier <= 1
              ? 'text-emerald-400'
              : confidence.tier === 2
                ? 'text-blue-400'
                : 'text-orange-400',
          title:
            confidence.tier <= 1
              ? t('review.scope.ledger.exact.title')
              : t('review.scope.ledger.limited.title'),
          detail:
            confidence.tier <= 1
              ? t('review.scope.ledger.exact.detail')
              : t('review.scope.ledger.limited.detail'),
          badgeLabel:
            confidence.tier <= 1
              ? t('review.scope.ledger.exact.badge')
              : confidence.tier === 2
                ? t('review.scope.ledger.limited.mixedBadge')
                : t('review.scope.ledger.limited.needsReviewBadge'),
        }
      : null;
  const workIntervalConfig: TierConfig | null =
    sourceKind !== 'ledger' && confidence.reason.toLowerCase().includes('workinterval')
      ? {
          Icon: Info,
          border: 'border-blue-500/15',
          bg: 'bg-blue-500/5',
          accentColor: 'text-blue-400',
          title: t('review.scope.workInterval.title'),
          detail: t('review.scope.workInterval.detail'),
          badgeLabel: t('review.scope.workInterval.badge'),
        }
      : null;
  const config =
    ledgerConfig ?? workIntervalConfig ?? tierConfigs[confidence.tier] ?? tierConfigs[4];
  const { Icon } = config;

  return (
    <div className={cn('border-b px-4 py-2', config.border, config.bg)}>
      <div className="flex items-center gap-2">
        <Icon className={cn('size-3.5 shrink-0', config.accentColor)} />
        <span className={cn('text-xs font-medium', config.accentColor)}>{config.title}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-0.5 text-xs text-text-muted transition-colors hover:text-text-secondary"
        >
          {t('review.scope.readMore')}
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        </button>

        <div className="flex-1" />

        <ConfidenceBadge confidence={confidence} label={config.badgeLabel} />

        {onDismiss && (
          <button onClick={onDismiss} className="text-text-muted hover:text-text">
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5 pl-6 text-xs text-text-secondary">
          <p>{config.detail}</p>
          {warnings.length > 0 && (
            <ul className="list-inside list-disc space-y-0.5 text-text-muted">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
