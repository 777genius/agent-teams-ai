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
const AUTHORITATIVE_LOAD_DELAY_MS = 3_000;
const AUTHORITATIVE_RETRY_DELAYS_MS = [5_000, 10_000] as const;

type DirectoryLoadOutcome = 'loaded' | 'cancelled' | 'recoverable-error' | 'terminal-error';

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
    let authoritativeTimeout: number | null = null;
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

    const loadDirectory = async (input: {
      summary: boolean;
      refresh: boolean;
      silent: boolean;
      reportErrors?: boolean;
    }): Promise<DirectoryLoadOutcome> => {
      if (!input.silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const response = await api.runtimeProviderManagement.loadProviderDirectory({
          runtimeId: 'opencode',
          summary: input.summary,
          projectPath,
          query: null,
          filter: 'all',
          // The live pass needs the complete provider set so every curated
          // dashboard card is reconciled against the managed OpenCode host.
          limit: input.summary ? 100 : 250,
          cursor: null,
          refresh: input.refresh,
        });
        if (cancelled || requestSequence.current !== requestId) {
          return 'cancelled';
        }
        if (response.error) {
          if (!input.silent || input.reportErrors || !response.error.recoverable) {
            setError(response.error.message);
          }
          return response.error.recoverable ? 'recoverable-error' : 'terminal-error';
        }
        if (!response.directory) {
          if (!input.silent || input.reportErrors) {
            setError('Provider directory response was empty');
          }
          return 'terminal-error';
        }
        setEntries(response.directory.entries);
        publishRuntimeProviderDirectoryCache({
          projectPath,
          entries: response.directory.entries,
          fetchedAt: response.directory.fetchedAt,
          authoritative: !input.summary,
        });
        setError(null);
        setLoaded(true);
        setAuthoritativeLoaded(!input.summary);
        return 'loaded';
      } catch (loadError) {
        if (cancelled || requestSequence.current !== requestId) {
          return 'cancelled';
        }
        if (!input.silent || input.reportErrors) {
          setError(
            loadError instanceof Error ? loadError.message : 'Failed to load provider status'
          );
        }
        return 'recoverable-error';
      } finally {
        if (!input.silent && !cancelled && requestSequence.current === requestId) {
          setLoading(false);
        }
      }
    };

    const loadAuthoritativeWithRetry = async (input: {
      refresh: boolean;
      silent: boolean;
      retryIndex?: number;
    }): Promise<void> => {
      const retryIndex = input.retryIndex ?? 0;
      const isFinalAttempt = retryIndex >= AUTHORITATIVE_RETRY_DELAYS_MS.length;
      const outcome = await loadDirectory({
        summary: false,
        refresh: input.refresh,
        silent: input.silent,
        reportErrors: isFinalAttempt,
      });
      if (cancelled || requestSequence.current !== requestId) {
        return;
      }
      if (outcome === 'loaded') {
        setAuthoritativePending(false);
        return;
      }
      if (outcome === 'cancelled') {
        return;
      }
      if (outcome === 'terminal-error') {
        setAuthoritativePending(false);
        return;
      }
      const retryDelay = AUTHORITATIVE_RETRY_DELAYS_MS[retryIndex];
      if (retryDelay === undefined) {
        setAuthoritativePending(false);
        return;
      }
      authoritativeTimeout = window.setTimeout(() => {
        void loadAuthoritativeWithRetry({
          refresh: true,
          silent: true,
          retryIndex: retryIndex + 1,
        });
      }, retryDelay);
    };

    const loadDelay = hasStartedLoad.current ? 0 : INITIAL_LOAD_DELAY_MS;
    const timeout = window.setTimeout(() => {
      hasStartedLoad.current = true;
      if (refreshRequested) {
        void loadAuthoritativeWithRetry({ refresh: true, silent: false });
        return;
      }

      void loadDirectory({ summary: true, refresh: false, silent: false }).then(
        (summaryOutcome) => {
          if (cancelled || requestSequence.current !== requestId) {
            return;
          }
          authoritativeTimeout = window.setTimeout(() => {
            void loadAuthoritativeWithRetry({
              refresh: summaryOutcome !== 'loaded',
              silent: summaryOutcome === 'loaded',
            });
          }, AUTHORITATIVE_LOAD_DELAY_MS);
        }
      );
    }, loadDelay);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (authoritativeTimeout !== null) {
        window.clearTimeout(authoritativeTimeout);
      }
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
