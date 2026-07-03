import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';

import { normalizeTokenUsageSnapshot } from '../../contracts';
import {
  type TokenUsageDashboardViewModel,
  type TokenUsageDashboardViewModelOptions,
  toTokenUsageDashboardViewModel,
} from '../adapters/tokenUsageViewModel';

import type { TokenUsageAnalyticsSnapshotDto, TokenUsageSnapshotRequest } from '../../contracts';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
type SnapshotLoadMode = 'get' | 'refresh' | 'silent';

export interface UseTokenUsageSnapshotOptions {
  request?: TokenUsageSnapshotRequest;
  pollIntervalMs?: number;
  viewModelOptions?: TokenUsageDashboardViewModelOptions;
}

export interface UseTokenUsageSnapshotResult {
  snapshot: TokenUsageAnalyticsSnapshotDto | null;
  viewModel: TokenUsageDashboardViewModel;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useTokenUsageSnapshot({
  request,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  viewModelOptions,
}: UseTokenUsageSnapshotOptions = {}): UseTokenUsageSnapshotResult {
  const [snapshot, setSnapshot] = useState<TokenUsageAnalyticsSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadSnapshot = useCallback(
    async (mode: SnapshotLoadMode, cancelledRef: { current: boolean }) => {
      if (mode === 'refresh') {
        setRefreshing(true);
      } else if (mode === 'get') {
        setLoading(true);
      }
      if (mode !== 'silent') {
        setError(null);
      }
      try {
        const nextSnapshot =
          mode === 'refresh'
            ? await api.tokenUsage.refreshSnapshot(request)
            : await api.tokenUsage.getSnapshot(request);
        if (!cancelledRef.current) {
          setSnapshot(normalizeTokenUsageSnapshot(nextSnapshot) ?? nextSnapshot);
        }
      } catch (nextError) {
        if (!cancelledRef.current && mode !== 'silent') {
          setError(getErrorMessage(nextError));
        }
      } finally {
        if (!cancelledRef.current && mode !== 'silent') {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [request]
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    void loadSnapshot('refresh', cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [loadSnapshot, refreshKey]);

  useEffect(() => {
    const cancelledRef = { current: false };
    let inFlight = false;
    let queued = false;

    const loadScopedSnapshot = (): void => {
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          do {
            queued = false;
            await loadSnapshot('silent', cancelledRef);
          } while (queued && !cancelledRef.current);
        } finally {
          inFlight = false;
        }
      })();
    };

    const unsubscribe = api.tokenUsage.onSnapshotChanged(loadScopedSnapshot);
    return () => {
      cancelledRef.current = true;
      unsubscribe();
    };
  }, [loadSnapshot]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return undefined;
    const cancelledRef = { current: false };
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadSnapshot('refresh', cancelledRef);
      }
    }, pollIntervalMs);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(intervalId);
    };
  }, [loadSnapshot, pollIntervalMs]);

  return {
    snapshot,
    viewModel: useMemo(
      () => toTokenUsageDashboardViewModel(snapshot, viewModelOptions),
      [snapshot, viewModelOptions]
    ),
    loading,
    refreshing,
    error,
    refresh: () => setRefreshKey((current) => current + 1),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load token usage.';
}
