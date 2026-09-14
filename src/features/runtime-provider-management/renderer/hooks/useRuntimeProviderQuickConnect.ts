import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import {
  getRuntimeProviderDirectoryCacheSnapshot,
  publishRuntimeProviderDirectoryCache,
} from '../runtimeProviderDirectoryCache';

import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';

interface UseRuntimeProviderQuickConnectOptions {
  enabled: boolean;
  projectPath?: string | null;
  refreshKey?: number;
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
}: UseRuntimeProviderQuickConnectOptions): RuntimeProviderQuickConnectDirectoryState {
  const currentProjectScope = projectPath?.trim() ?? '';
  const initialDirectoryCache = getRuntimeProviderDirectoryCacheSnapshot(projectPath);
  const requestSequence = useRef(0);
  const previousRefreshKey = useRef(refreshKey);
  const previousManualRefreshSequence = useRef(0);
  const previousProjectScope = useRef(projectPath?.trim() ?? '');
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
  const [manualRefreshSequence, setManualRefreshSequence] = useState(0);
  const [directoryProjectScope, setDirectoryProjectScope] = useState(currentProjectScope);

  const refresh = useCallback(() => {
    setManualRefreshSequence((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    const refreshRequested =
      manualRefreshSequence !== previousManualRefreshSequence.current ||
      refreshKey !== previousRefreshKey.current;
    previousRefreshKey.current = refreshKey;
    previousManualRefreshSequence.current = manualRefreshSequence;
    let cancelled = false;
    const projectScope = projectPath?.trim() ?? '';
    const projectScopeChanged = previousProjectScope.current !== projectScope;
    previousProjectScope.current = projectScope;
    if (projectScopeChanged) {
      const cachedDirectory = getRuntimeProviderDirectoryCacheSnapshot(projectPath);
      setDirectoryProjectScope(projectScope);
      setEntries(cachedDirectory?.entries ?? []);
      setLoaded(Boolean(cachedDirectory));
      setAuthoritativeLoaded(cachedDirectory?.authoritative ?? false);
      setError(null);
    }
    setAuthoritativePending(true);

    const loadDirectory = async (): Promise<void> => {
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
        });
        setError(null);
        setLoaded(true);
        setAuthoritativeLoaded(false);
      } catch (loadError) {
        if (cancelled || requestSequence.current !== requestId) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load provider status');
      } finally {
        if (!cancelled && requestSequence.current === requestId) {
          setLoading(false);
        }
      }
    };

    const loadDelay = hasStartedLoad.current ? 0 : INITIAL_LOAD_DELAY_MS;
    const timeout = window.setTimeout(() => {
      hasStartedLoad.current = true;
      void loadDirectory().then(() => {
        if (!cancelled && requestSequence.current === requestId) {
          setAuthoritativePending(false);
        }
      });
    }, loadDelay);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [enabled, manualRefreshSequence, projectPath, refreshKey]);

  // Passive effects run after React commits. Gate the returned snapshot during
  // that short transition so a project-only provider can never flash in the
  // picker for a different project.
  const transitionDirectoryCache =
    directoryProjectScope === currentProjectScope
      ? null
      : getRuntimeProviderDirectoryCacheSnapshot(projectPath);
  const isProjectScopeTransition = directoryProjectScope !== currentProjectScope;

  return {
    entries: isProjectScopeTransition ? (transitionDirectoryCache?.entries ?? []) : entries,
    loading: isProjectScopeTransition ? enabled : loading,
    loaded: isProjectScopeTransition ? Boolean(transitionDirectoryCache) : loaded,
    authoritativeLoaded: isProjectScopeTransition
      ? (transitionDirectoryCache?.authoritative ?? false)
      : authoritativeLoaded,
    authoritativePending: isProjectScopeTransition ? true : authoritativePending,
    error: isProjectScopeTransition ? null : error,
    refresh,
  };
}
