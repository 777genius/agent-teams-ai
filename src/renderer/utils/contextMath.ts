import { DEFAULT_CONTEXT_WINDOW } from '@shared/utils/modelParser';

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

export type ContextUrgency = 'normal' | 'warning' | 'critical';

export interface RemainingContext {
  remainingPct: number;
  urgency: ContextUrgency;
}

/**
 * Compute how much context window remains before compaction.
 * Returns null if input data is unavailable.
 */
export function computeRemainingContext(
  usedContextTokens: number | undefined,
  contextWindow?: number
): RemainingContext | null {
  if (usedContextTokens === undefined || usedContextTokens < 0) return null;
  const resolvedContextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const remainingPct = Math.max(
    ((resolvedContextWindow - usedContextTokens) / resolvedContextWindow) * 100,
    0
  );
  const urgency: ContextUrgency =
    remainingPct < 20 ? 'critical' : remainingPct < 40 ? 'warning' : 'normal';
  return { remainingPct, urgency };
}
