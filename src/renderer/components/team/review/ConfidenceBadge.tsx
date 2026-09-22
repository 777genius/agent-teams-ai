import { useAppTranslation } from '@features/localization/renderer';

import type { TaskScopeConfidence } from '@shared/types';

interface ConfidenceBadgeProps {
  confidence: TaskScopeConfidence;
  showTooltip?: boolean;
  label?: string;
}

const TIER_COLORS: Record<number, string> = {
  1: 'bg-green-500/20 text-green-400 border-green-500/30',
  2: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  3: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  4: 'bg-red-500/20 text-red-400 border-red-500/30',
};

export const ConfidenceBadge = ({
  confidence,
  showTooltip = true,
  label,
}: ConfidenceBadgeProps) => {
  const { t } = useAppTranslation('team');
  const fallbackLabel =
    confidence.tier === 1
      ? t('review.scope.confidence.high')
      : confidence.tier === 2
        ? t('review.scope.confidence.medium')
        : confidence.tier === 3
          ? t('review.scope.confidence.low')
          : t('review.scope.confidence.bestEffort');

  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${TIER_COLORS[confidence.tier] ?? TIER_COLORS[4]}`}
      title={showTooltip ? confidence.reason : undefined}
    >
      {label ?? fallbackLabel}
    </span>
  );
};
