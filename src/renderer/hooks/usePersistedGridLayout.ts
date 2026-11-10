import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createPersistedGridLayoutState,
  mergeGridLayoutItems,
  normalizePersistedGridLayoutState,
  projectVisibleGridLayoutItems,
} from '@renderer/services/layout-system/gridLayoutSchema';

import type { GridLayoutRepository } from '@renderer/services/layout-system/GridLayoutRepository';
import type {
  PersistedGridLayoutItem,
  PersistedGridLayoutState,
} from '@renderer/services/layout-system/gridLayoutTypes';

interface UsePersistedGridLayoutOptions {
  scopeKey: string;
  allItemIds: string[];
  visibleItemIds: string[];
  cols: number;
  repository: GridLayoutRepository<PersistedGridLayoutState>;
  buildDefaultItems: (itemIds: string[]) => PersistedGridLayoutItem[];
}

interface UsePersistedGridLayoutResult {
  allItems: PersistedGridLayoutItem[];
  visibleItems: PersistedGridLayoutItem[];
  isLoaded: boolean;
  applyVisibleItems: (items: PersistedGridLayoutItem[], options?: { persist?: boolean }) => void;
}

export function usePersistedGridLayout({
  scopeKey,
  allItemIds,
  visibleItemIds,
  cols,
  repository,
  buildDefaultItems,
}: UsePersistedGridLayoutOptions): UsePersistedGridLayoutResult {
  const defaultItems = useMemo(
    () => buildDefaultItems(allItemIds),
    [allItemIds, buildDefaultItems]
  );
  const initialState = useMemo(
    () => normalizePersistedGridLayoutState(repository.peek?.(scopeKey) ?? null, defaultItems),
    [defaultItems, repository, scopeKey]
  );
  const [layoutState, setLayoutState] = useState<PersistedGridLayoutState>(() => initialState);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const resolvedLayoutState = useMemo(
    () => normalizePersistedGridLayoutState(layoutState, defaultItems),
    [defaultItems, layoutState]
  );

  useEffect(() => {
    let cancelled = false;

    void repository
      .load(scopeKey)
      .then((stored) => {
        if (cancelled) return;
        setLayoutState(normalizePersistedGridLayoutState(stored, defaultItems));
        setLoadedScopeKey(scopeKey);
      })
      .catch(() => {
        if (cancelled) return;
        setLayoutState(normalizePersistedGridLayoutState(null, defaultItems));
        setLoadedScopeKey(scopeKey);
      });

    return () => {
      cancelled = true;
    };
  }, [defaultItems, repository, scopeKey]);

  const visibleItems = useMemo(
    () => projectVisibleGridLayoutItems(resolvedLayoutState.items, visibleItemIds, cols),
    [cols, resolvedLayoutState.items, visibleItemIds]
  );

  const applyVisibleItems = useCallback(
    (items: PersistedGridLayoutItem[], options?: { persist?: boolean }) => {
      setLayoutState((current) => {
        const mergedItems = mergeGridLayoutItems(
          normalizePersistedGridLayoutState(current, defaultItems).items,
          items
        );
        const nextState = normalizePersistedGridLayoutState(
          createPersistedGridLayoutState(mergedItems),
          defaultItems
        );

        if (options?.persist) {
          void repository.save(scopeKey, nextState);
        }

        return nextState;
      });
    },
    [defaultItems, repository, scopeKey]
  );

  return {
    allItems: resolvedLayoutState.items,
    visibleItems,
    isLoaded: loadedScopeKey === scopeKey,
    applyVisibleItems,
  };
}
