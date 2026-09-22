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

import { useEffect, useMemo, useRef } from 'react';

import {
  TeamBranchTrackingCoordinator,
  type TeamBranchTrackingRegistration,
} from '@features/team-view-read-model/renderer';
import { createTeamBranchTrackingTransport } from '@renderer/composition/team/createTeamBranchTrackingTransport';
import { useStore } from '@renderer/store';
import { normalizePath } from '@renderer/utils/pathNormalize';

const branchTrackingCoordinator = new TeamBranchTrackingCoordinator(
  createTeamBranchTrackingTransport()
);

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
  const trackingRegistrationRef = useRef<TeamBranchTrackingRegistration | null>(null);

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
  const trackingPaths = live ? pathEntries.map(([, actual]) => actual) : [];
  const latestTrackingPathsRef = useRef(trackingPaths);
  latestTrackingPathsRef.current = trackingPaths;

  // Initial fetch on mount and whenever paths change (both live and one-shot modes)
  useEffect(() => {
    if (pathEntries.length === 0) return;
    void fetchBranches(pathEntries.map(([, actual]) => actual));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathsKey is a stable string derived from pathEntries, avoids re-fetching on array identity change
  }, [pathsKey, fetchBranches]);

  useEffect(() => {
    const registration = branchTrackingCoordinator.register(latestTrackingPathsRef.current);
    trackingRegistrationRef.current = registration;
    return () => {
      registration.dispose();
      if (trackingRegistrationRef.current === registration) {
        trackingRegistrationRef.current = null;
      }
    };
  }, []);

  // Reconcile only path-set differences so retained paths never bounce off and on.
  useEffect(() => {
    trackingRegistrationRef.current?.update(live ? pathEntries.map(([, actual]) => actual) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathsKey is the normalized path set; exact spelling stays pinned until its key reaches zero
  }, [live, pathsKey]);
}
