/**
 * Centralized git branch polling hook.
 *
 * Provides two modes:
 * - `live: false` (default) — one-shot fetch on mount / path change
 * - `live: true` — continuous polling with ref-counted shared timer
 *
 * Data is stored in the Zustand store (`branchByPath`) so any component
 * can read it via `useStore(s => s.branchByPath)`.
 *
 * The module-level polling manager guarantees:
 * - A single shared `setInterval` across all live subscribers
 * - Deduplication: N components subscribing to the same path = 1 poll
 * - Automatic cleanup: timer stops when all subscribers unmount
 */

import { useEffect, useMemo } from 'react';

import { useStore } from '@renderer/store';
import { normalizePath } from '@renderer/utils/pathNormalize';

// =============================================================================
// Constants
// =============================================================================

const POLL_INTERVAL_MS = 6_000;

// =============================================================================
// Module-level polling manager (singleton, outside React lifecycle)
// =============================================================================

const livePaths = new Map<string, { actualPath: string; refCount: number }>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPollingIfNeeded(): void {
  if (pollTimer || livePaths.size === 0) return;
  pollTimer = setInterval(() => {
    const paths = Array.from(livePaths.values()).map((v) => v.actualPath);
    void useStore.getState().fetchBranches(paths);
  }, POLL_INTERVAL_MS);
}

function stopPollingIfEmpty(): void {
  if (pollTimer && livePaths.size === 0) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function subscribe(normalizedKey: string, actualPath: string): void {
  const entry = livePaths.get(normalizedKey);
  if (entry) {
    entry.refCount++;
  } else {
    livePaths.set(normalizedKey, { actualPath, refCount: 1 });
  }
  startPollingIfNeeded();
}

function unsubscribe(normalizedKey: string): void {
  const entry = livePaths.get(normalizedKey);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    livePaths.delete(normalizedKey);
  }
  stopPollingIfEmpty();
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Sync git branch data for the given project paths into the store.
 *
 * @param paths - Raw project paths to resolve branches for
 * @param options.live - When true, keeps polling every 6s while mounted
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
        .sort()
        .join('\n'),
    [pathEntries]
  );

  // Initial fetch on mount and whenever paths change (both live and one-shot modes)
  useEffect(() => {
    if (pathEntries.length === 0) return;
    void fetchBranches(pathEntries.map(([, actual]) => actual));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, pathsKey]);
}
