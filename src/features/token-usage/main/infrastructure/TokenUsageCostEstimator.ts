import { calculateMessageCost, getPricing } from '@shared/utils/pricing';

import { normalizeCostBreakdown } from '../../core/domain';

import type {
  TokenUsageBillingMode,
  TokenUsageCostBreakdownDto,
  TokenUsageEventDto,
} from '../../contracts';

export function estimateTokenUsageCost(
  model: string | undefined,
  tokens: TokenUsageEventDto['tokens'],
  rawCostUsd: number | undefined,
  billingMode: TokenUsageBillingMode
): TokenUsageCostBreakdownDto {
  if (rawCostUsd !== undefined && rawCostUsd > 0) {
    return normalizeCostBreakdown({
      estimatedUsd: rawCostUsd,
      apiEquivalentUsd: rawCostUsd,
      source: 'pricing_table',
      billingMode,
    });
  }

  if (model && getPricing(model)) {
    const apiEquivalentUsd = calculateMessageCost(
      model,
      tokens.inputTokens,
      tokens.outputTokens,
      tokens.cacheReadTokens,
      tokens.cacheCreationTokens
    );
    return normalizeCostBreakdown({
      estimatedUsd: apiEquivalentUsd,
      apiEquivalentUsd,
      source: 'pricing_table',
      billingMode,
    });
  }

  return normalizeCostBreakdown({ estimatedUsd: 0, source: 'unknown', billingMode });
}
