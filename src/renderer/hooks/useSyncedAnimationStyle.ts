import { useMemo } from 'react';

import type { CSSProperties } from 'react';

const DEFAULT_ANIMATION_DURATION_MS = 1000;

function getCurrentTimeMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function useSyncedAnimationStyle(
  enabled: boolean,
  durationMs = DEFAULT_ANIMATION_DURATION_MS
): CSSProperties | undefined {
  return useMemo(() => {
    if (!enabled) {
      return undefined;
    }
    const safeDurationMs =
      Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_ANIMATION_DURATION_MS;
    const phaseMs = getCurrentTimeMs() % safeDurationMs;
    return {
      animationDelay: `${-phaseMs}ms`,
      animationDuration: `${safeDurationMs}ms`,
    };
  }, [durationMs, enabled]);
}
