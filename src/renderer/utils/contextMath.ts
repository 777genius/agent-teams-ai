import type { ContextInjection } from '@renderer/types/contextInjection';

export function sumContextInjectionTokens(injections: readonly ContextInjection[]): number {
  let sum = 0;
  for (const inj of injections) {
    sum += inj.estimatedTokens ?? 0;
  }
  return sum;
}

export function computePercentOfTotal(
  visibleTokens: number,
  totalSessionTokens: number | undefined
): number | null {
  if (totalSessionTokens === undefined || totalSessionTokens <= 0) return null;
  if (!Number.isFinite(visibleTokens) || visibleTokens <= 0) return 0;
  return Math.min((visibleTokens / totalSessionTokens) * 100, 100);
}

export function formatPercentOfTotal(
  visibleTokens: number,
  totalSessionTokens: number | undefined
): string | null {
  const pct = computePercentOfTotal(visibleTokens, totalSessionTokens);
  if (pct === null) return null;
  return `${pct.toFixed(1)}% of input`;
}
