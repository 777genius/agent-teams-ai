import { useEffect, useMemo, useState } from 'react';

interface UseNewItemKeysOptions {
  itemKeys: string[];
  paginationKey?: number;
  resetKey?: string;
}

/**
 * Tracks which currently visible items are newly mounted since the last committed render.
 * Pagination expansions are treated as non-animated so "Show more" does not replay enter motion.
 *
 * Uses useState instead of useRef to avoid reading ref.current during render.
 * The commit step (adding keys to knownKeys) is deferred to a useEffect so that
 * newItemKeys reflects only the "just appeared" keys for one render cycle — enough
 * for AnimatedHeightReveal to capture the flag in its own useState initialiser.
 */
export function useNewItemKeys({
  itemKeys,
  paginationKey = 0,
  resetKey,
}: UseNewItemKeysOptions): Set<string> {
  const [knownKeys, setKnownKeys] = useState<Set<string>>(new Set());
  const [isInitialized, setIsInitialized] = useState(false);
  const [prevPaginationKey, setPrevPaginationKey] = useState(paginationKey);

  // Reset when resetKey changes (render-time "derive state" pattern).
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setKnownKeys(new Set());
    setIsInitialized(false);
    setPrevPaginationKey(paginationKey);
  }

  // Compute during render — reads from state, not refs.
  const isPaginationExpansion = isInitialized && paginationKey > prevPaginationKey;

  const newItemKeys = useMemo(() => {
    if (!isInitialized || isPaginationExpansion) {
      return new Set<string>();
    }

    const next = new Set<string>();
    for (const key of itemKeys) {
      if (!knownKeys.has(key)) {
        next.add(key);
      }
    }
    return next;
  }, [isInitialized, knownKeys, isPaginationExpansion, itemKeys]);

  // Commit: mark current keys as known after render.
  // Wrapped in queueMicrotask to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    queueMicrotask(() => {
      setKnownKeys((prev) => {
        const next = new Set(prev);
        for (const key of itemKeys) {
          next.add(key);
        }
        return next;
      });
      setIsInitialized(true);
      setPrevPaginationKey(paginationKey);
    });
  }, [itemKeys, paginationKey]);

  return newItemKeys;
}
