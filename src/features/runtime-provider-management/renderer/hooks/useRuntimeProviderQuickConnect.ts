import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import { countCompleteDirectoryConnections } from '../connectedCountObservationPolicy';
import {
  beginRuntimeProviderConnectedCountCheck,
  getRuntimeProviderDirectoryCacheSnapshot,
  getRuntimeProviderDirectoryReadToken,
  observeRuntimeProviderDirectoryRevision,
  publishRuntimeProviderConnectedCount,
  publishRuntimeProviderDirectoryCache,
} from '../runtimeProviderDirectoryCache';

import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';

interface UseRuntimeProviderQuickConnectOptions {
  enabled: boolean;
  projectPath?: string | null;
  refreshKey?: number;
  /**
   * Settled identity of the OpenCode runtime, or null while it is unknown or
   * changing. See `resolveOpenCodeQuickConnectRuntimeRevision`.
   */
  runtimeRevision: string | null;
}

export interface RuntimeProviderQuickConnectDirectoryState {
  entries: readonly RuntimeProviderDirectoryEntryDto[];
  loading: boolean;
  loaded: boolean;
  authoritativeLoaded: boolean;
  authoritativePending: boolean;
  error: string | null;
  refresh: () => void;
}

const INITIAL_LOAD_DELAY_MS = 200;

export function useRuntimeProviderQuickConnect({
  enabled,
  projectPath = null,
  refreshKey = 0,
  runtimeRevision,
}: UseRuntimeProviderQuickConnectOptions): RuntimeProviderQuickConnectDirectoryState {
  const currentProjectScope = projectPath?.trim() ?? '';
  const initialDirectoryCache = getRuntimeProviderDirectoryCacheSnapshot(projectPath, runtimeRevision);
  const cacheSeenOnMount = useRef(initialDirectoryCache);
  const requestSequence = useRef(0);
  const previousRefreshKey = useRef(refreshKey);
  const previousRefreshRequestSequence = useRef(0);
  const previousProjectScope = useRef(projectPath?.trim() ?? '');
  const previousRuntimeRevision = useRef(runtimeRevision);
  const hasStartedLoad = useRef(false);
  const [entries, setEntries] = useState<readonly RuntimeProviderDirectoryEntryDto[]>(
    initialDirectoryCache?.entries ?? []
  );
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(Boolean(initialDirectoryCache));
  const [authoritativeLoaded, setAuthoritativeLoaded] = useState(
    initialDirectoryCache?.authoritative ?? false
  );
  const [authoritativePending, setAuthoritativePending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshRequestSequence, setRefreshRequestSequence] = useState(0);
  const [settledRuntimeRevision, setSettledRuntimeRevision] = useState(runtimeRevision);
  const [directoryProjectScope, setDirectoryProjectScope] = useState(currentProjectScope);

  // Adjusted during render so the load effect sees the runtime change and the
  // refresh request in one commit, instead of first starting a cached read.
  if (runtimeRevision !== null && runtimeRevision !== settledRuntimeRevision) {
    setSettledRuntimeRevision(runtimeRevision);
    // The first settled identity is only a baseline. A later change means the
    // runtime was installed, removed or replaced, so cached reads are obsolete.
    if (settledRuntimeRevision !== null) {
      setRefreshRequestSequence((current) => current + 1);
    }
  }

  const refresh = useCallback(() => {
    setRefreshRequestSequence((current) => current + 1);
  }, []);

  useEffect(() => {
    if (runtimeRevision !== null) {
      observeRuntimeProviderDirectoryRevision(runtimeRevision);
      if (
        (previousRuntimeRevision.current !== null &&
          runtimeRevision !== previousRuntimeRevision.current) ||
        (cacheSeenOnMount.current &&
          cacheSeenOnMount.current.runtimeRevision !== runtimeRevision)
      ) {
        setEntries([]);
        setLoaded(false);
        setAuthoritativeLoaded(false);
      }
      cacheSeenOnMount.current = null;
      previousRuntimeRevision.current = runtimeRevision;
    }
  }, [runtimeRevision]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    const requestRuntimeRevision = previousRuntimeRevision.current;
    const refreshRequested =
      refreshRequestSequence !== previousRefreshRequestSequence.current ||
      refreshKey !== previousRefreshKey.current;
    let cancelled = false;
    let stopCountCheck: (() => void) | null = null;
    const projectScope = projectPath?.trim() ?? '';
    const projectScopeChanged = previousProjectScope.current !== projectScope;
    previousProjectScope.current = projectScope;
    if (projectScopeChanged) {
      const cachedDirectory = getRuntimeProviderDirectoryCacheSnapshot(
        projectPath,
        requestRuntimeRevision
      );
      cacheSeenOnMount.current = cachedDirectory;
      setDirectoryProjectScope(projectScope);
      setEntries(cachedDirectory?.entries ?? []);
      setLoaded(Boolean(cachedDirectory));
      setAuthoritativeLoaded(cachedDirectory?.authoritative ?? false);
      setError(null);
    }
    setAuthoritativePending(true);

    const loadDirectory = async (): Promise<void> => {
      const readToken = getRuntimeProviderDirectoryReadToken(projectPath);
      stopCountCheck = beginRuntimeProviderConnectedCountCheck(projectPath, readToken);
      let connectedProbeStarted = false;
      setLoading(true);
      setError(null);

      try {
        const response = await api.runtimeProviderManagement.loadProviderDirectory({
          runtimeId: 'opencode',
          summary: true,
          projectPath,
          query: null,
          filter: 'all',
          limit: 100,
          cursor: null,
          refresh: refreshRequested,
        });
        if (cancelled || requestSequence.current !== requestId) {
          return;
        }
        if (response.error) {
          setError(response.error.message);
          return;
        }
        if (!response.directory) {
          setError('Provider directory response was empty');
          return;
        }
        setEntries(response.directory.entries);
        publishRuntimeProviderDirectoryCache({
          projectPath,
          entries: response.directory.entries,
          fetchedAt: response.directory.fetchedAt,
          authoritative: false,
          runtimeRevision: requestRuntimeRevision,
          readToken,
        });
        // A complete, healthy summary is enough for a display-only connected
        // count. No models or full directory need to be loaded.
        const observedCount = countCompleteDirectoryConnections(response.directory, 'all');
        if (requestRuntimeRevision && observedCount !== null) {
          publishRuntimeProviderConnectedCount({
            projectPath,
            readToken,
            runtimeRevision: requestRuntimeRevision,
            connected: observedCount,
            fetchedAt: response.directory.fetchedAt,
            source: 'summary-all',
          });
        } else if (
          requestRuntimeRevision &&
          (response.directory.nextCursor != null ||
            response.directory.totalCount > response.directory.entries.length)
        ) {
          // Spike: read only connected sources when the legacy all-provider
          // summary is truncated. The existing all-summary rows remain the
          // fallback for cards; never escalate to model or full inventory reads.
          connectedProbeStarted = true;
          void api.runtimeProviderManagement
            .loadProviderDirectory({
              runtimeId: 'opencode',
              summary: true,
              projectPath,
              query: null,
              filter: 'connected',
              limit: 100,
              cursor: null,
              refresh: false,
            })
            .then((connectedResponse) => {
              if (cancelled || requestSequence.current !== requestId || connectedResponse.error) {
                return;
              }
              const count = countCompleteDirectoryConnections(
                connectedResponse.directory,
                'connected'
              );
              if (count !== null && connectedResponse.directory) {
                publishRuntimeProviderConnectedCount({
                  projectPath,
                  readToken,
                  runtimeRevision: requestRuntimeRevision,
                  connected: count,
                  fetchedAt: connectedResponse.directory.fetchedAt,
                  source: 'summary-connected',
                });
              }
            })
            .catch(() => undefined)
            .finally(() => stopCountCheck?.());
        }
        setError(null);
        setLoaded(true);
        setAuthoritativeLoaded(false);
      } catch (loadError) {
        if (cancelled || requestSequence.current !== requestId) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load provider status');
      } finally {
        if (!connectedProbeStarted) stopCountCheck?.();
        if (!cancelled && requestSequence.current === requestId) {
          setLoading(false);
        }
      }
    };

    const loadDelay = hasStartedLoad.current ? 0 : INITIAL_LOAD_DELAY_MS;
    const timeout = window.setTimeout(() => {
      hasStartedLoad.current = true;
      // Consume refresh requests only when the read really starts: if the grid
      // is disabled before the timer fires, the next enabled read still bypasses
      // the cache.
      previousRefreshKey.current = refreshKey;
      previousRefreshRequestSequence.current = refreshRequestSequence;
      void loadDirectory().then(() => {
        if (!cancelled && requestSequence.current === requestId) {
          setAuthoritativePending(false);
        }
      });
    }, loadDelay);

    return () => {
      cancelled = true;
      stopCountCheck?.();
      window.clearTimeout(timeout);
    };
  }, [enabled, projectPath, refreshKey, refreshRequestSequence]);

  // Passive effects run after React commits. Gate the returned snapshot during
  // that short transition so providers from the previous project or runtime
  // cannot appear in the picker for its replacement.
  const isScopeTransition =
    directoryProjectScope !== currentProjectScope ||
    (runtimeRevision !== null &&
      ((previousRuntimeRevision.current !== null &&
        previousRuntimeRevision.current !== runtimeRevision) ||
        (cacheSeenOnMount.current !== null &&
          cacheSeenOnMount.current.runtimeRevision !== runtimeRevision)));
  const transitionDirectoryCache = isScopeTransition
    ? getRuntimeProviderDirectoryCacheSnapshot(projectPath, runtimeRevision)
    : null;

  return {
    entries: isScopeTransition ? (transitionDirectoryCache?.entries ?? []) : entries,
    loading: isScopeTransition ? enabled : loading,
    loaded: isScopeTransition ? Boolean(transitionDirectoryCache) : loaded,
    authoritativeLoaded: isScopeTransition
      ? (transitionDirectoryCache?.authoritative ?? false)
      : authoritativeLoaded,
    authoritativePending: isScopeTransition ? true : authoritativePending,
    error: isScopeTransition ? null : error,
    refresh,
  };
}
