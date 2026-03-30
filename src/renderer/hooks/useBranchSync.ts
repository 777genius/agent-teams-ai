/**
 * Centralized git branch sync hook.
 *
 * Provides two modes:
 * - `live: false` (default) — one-shot fetch on mount / path change
 * - `live: true` — background tracking in main with ref-counted subscriptions
 *
 * Data is stored in the Zustand store (`branchByPath`) so any component
 * can read it via `useStore(s => s.branchByPath)`.
 *
 * The module-level tracking manager guarantees:
 * - Deduplication: N components subscribing to the same path = 1 background tracker
 * - Automatic cleanup: tracking stops when all subscribers unmount
 */

import { useEffect, useMemo } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { normalizePath } from '@renderer/utils/pathNormalize';

// =============================================================================
// Module-level tracking manager (singleton, outside React lifecycle)
// =============================================================================

const livePaths = new Map<string, { actualPath: string; refCount: number }>();
function subscribe(normalizedKey: string, actualPath: string): void {
  const entry = livePaths.get(normalizedKey);
  if (entry) {
    entry.refCount++;
  } else {
    livePaths.set(normalizedKey, { actualPath, refCount: 1 });
    void api.teams?.setProjectBranchTracking?.(actualPath, true).catch(() => undefined);
  }
}

function unsubscribe(normalizedKey: string): void {
  const entry = livePaths.get(normalizedKey);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    livePaths.delete(normalizedKey);
    void api.teams?.setProjectBranchTracking?.(entry.actualPath, false).catch(() => undefined);
  }
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Sync git branch data for the given project paths into the store.
 *
 * @param paths - Raw project paths to resolve branches for
 * @param options.live - When true, enables main-side branch tracking while mounted
 */
export function useBranchSync(paths: string[], options?: { live?: boolean }): void {
  const live = options?.live ?? false;
  const fetchBranches = useStore((s) => s.fetchBranches);

  // Deduplicate and normalize paths into [normalizedKey, actualPath] entries.
  // `paths` identity should be stabilized by the caller via useMemo.
  const pathEntries = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of paths) {
      const trimmed = p.trim();
      if (trimmed) {
        const key = normalizePath(trimmed);
        if (!map.has(key)) map.set(key, trimmed);
      }
    }
    return Array.from(map.entries());
  }, [paths]);

  // Stable string key for useEffect deps — avoids re-running on same set of paths
  const pathsKey = useMemo(
    () =>
      pathEntries
        .map(([k]) => k)
        .sort((a, b) => a.localeCompare(b))
        .join('\n'),
    [pathEntries]
  );

  // Initial fetch on mount and whenever paths change (both live and one-shot modes)
  useEffect(() => {
    if (pathEntries.length === 0) return;
    void fetchBranches(pathEntries.map(([, actual]) => actual));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathsKey is a stable string derived from pathEntries, avoids re-fetching on array identity change
  }, [pathsKey, fetchBranches]);

  // Live subscription: register paths with the ref-counted polling manager
  useEffect(() => {
    if (!live || pathEntries.length === 0) return;
    for (const [key, actual] of pathEntries) {
      subscribe(key, actual);
    }
    return () => {
      for (const [key] of pathEntries) {
        unsubscribe(key);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathsKey is a stable string key; pathEntries excluded to prevent re-subscribing on array identity change
  }, [live, pathsKey]);
}
