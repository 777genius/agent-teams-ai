import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

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
  error: string | null;
  refresh: () => void;
}

const INITIAL_LOAD_DELAY_MS = 200;

export function useRuntimeProviderQuickConnect({
  enabled,
  projectPath = null,
  refreshKey = 0,
}: UseRuntimeProviderQuickConnectOptions): RuntimeProviderQuickConnectDirectoryState {
  const requestSequence = useRef(0);
  const previousRefreshKey = useRef(refreshKey);
  const previousManualRefreshSequence = useRef(0);
  const hasStartedLoad = useRef(false);
  const [entries, setEntries] = useState<readonly RuntimeProviderDirectoryEntryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshSequence, setManualRefreshSequence] = useState(0);

  const refresh = useCallback(() => {
    setManualRefreshSequence((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
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

    const loadDelay = hasStartedLoad.current ? 0 : INITIAL_LOAD_DELAY_MS;
    const timeout = window.setTimeout(() => {
      hasStartedLoad.current = true;
      setLoading(true);
      setError(null);
      void api.runtimeProviderManagement
        .loadProviderDirectory({
          runtimeId: 'opencode',
          projectPath,
          query: null,
          filter: 'all',
          // Quick-connect cards include curated providers near the end of the
          // OpenCode catalog (for example Xiaomi MiMo regional plans).
          limit: 250,
          cursor: null,
          refresh: refreshRequested,
        })
        .then((response) => {
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
          setLoaded(true);
        })
        .catch((loadError) => {
          if (cancelled || requestSequence.current !== requestId) {
            return;
          }
          setError(
            loadError instanceof Error ? loadError.message : 'Failed to load provider status'
          );
        })
        .finally(() => {
          if (!cancelled && requestSequence.current === requestId) {
            setLoading(false);
          }
        });
    }, loadDelay);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [enabled, manualRefreshSequence, projectPath, refreshKey]);

  return { entries, loading, loaded, error, refresh };
}
