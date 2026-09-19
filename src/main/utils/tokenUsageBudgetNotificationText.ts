export function formatTokenUsageBudgetMetricLabel(
  metric: 'tokens' | 'apiEquivalentCostUsd'
): string {
  return metric === 'apiEquivalentCostUsd' ? 'API-equivalent' : 'token';
}

export function formatTokenUsageBudgetValue(
  value: number,
  metric: 'tokens' | 'apiEquivalentCostUsd'
): string {
  if (metric === 'apiEquivalentCostUsd') {
    return `$${value.toFixed(value >= 10 ? 0 : 2)}`;
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tokens`;
  return `${Math.round(value)} tokens`;
}
