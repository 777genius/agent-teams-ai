import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';

const CODEX_PENDING_LOGIN_REFRESH_MS = 3_000;
const CODEX_VISIBLE_RATE_LIMITS_REFRESH_MS = 10_000;
const CODEX_VISIBLE_STANDARD_REFRESH_MS = 20_000;
const CODEX_HIDDEN_REFRESH_MS = 60_000;

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }

  return document.visibilityState !== 'hidden';
}

function getRefreshIntervalMs(options: {
  loginStatus: CodexAccountSnapshotDto['login']['status'] | undefined;
  includeRateLimits: boolean;
  visible: boolean;
}): number {
  if (options.loginStatus === 'starting' || options.loginStatus === 'pending') {
    return CODEX_PENDING_LOGIN_REFRESH_MS;
  }

  if (!options.visible) {
    return CODEX_HIDDEN_REFRESH_MS;
  }

  return options.includeRateLimits
    ? CODEX_VISIBLE_RATE_LIMITS_REFRESH_MS
    : CODEX_VISIBLE_STANDARD_REFRESH_MS;
}

export function useCodexAccountSnapshot(options: {
  enabled: boolean;
  includeRateLimits?: boolean;
}): {
  snapshot: CodexAccountSnapshotDto | null;
  loading: boolean;
  error: string | null;
  refresh: (options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
    silent?: boolean;
  }) => Promise<void>;
  startChatgptLogin: () => Promise<boolean>;
  cancelChatgptLogin: () => Promise<boolean>;
  logout: () => Promise<boolean>;
} {
  const electronMode = isElectronMode();
  const [snapshot, setSnapshot] = useState<CodexAccountSnapshotDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => isDocumentVisible());
  const lastUpdatedAtRef = useRef<number | null>(null);

  const applySnapshot = useCallback((nextSnapshot: CodexAccountSnapshotDto) => {
    lastUpdatedAtRef.current = Date.now();
    setSnapshot(nextSnapshot);
    setError(null);
  }, []);

  const refresh = useCallback(
    async (refreshOptions?: {
      includeRateLimits?: boolean;
      forceRefreshToken?: boolean;
      silent?: boolean;
    }) => {
      if (!electronMode || !options.enabled) {
        return;
      }

      const silent = refreshOptions?.silent === true;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const nextSnapshot = await api.refreshCodexAccountSnapshot({
          includeRateLimits: refreshOptions?.includeRateLimits ?? options.includeRateLimits,
          forceRefreshToken: refreshOptions?.forceRefreshToken,
        });
        applySnapshot(nextSnapshot);
      } catch (nextError) {
        if (!silent) {
          setError(
            nextError instanceof Error ? nextError.message : 'Failed to refresh Codex account'
          );
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [applySnapshot, electronMode, options.enabled, options.includeRateLimits]
  );

  useEffect(() => {
    if (!electronMode || !options.enabled) {
      return;
    }

    setLoading(true);
    setError(null);

    const initialSnapshotRequest = options.includeRateLimits
      ? api.refreshCodexAccountSnapshot({
          includeRateLimits: true,
        })
      : api.getCodexAccountSnapshot();

    void initialSnapshotRequest
      .then((nextSnapshot) => {
        applySnapshot(nextSnapshot);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : 'Failed to load Codex account');
      })
      .finally(() => {
        setLoading(false);
      });

    const unsubscribe = api.onCodexAccountSnapshotChanged((_event, nextSnapshot) => {
      applySnapshot(nextSnapshot);
    });

    return unsubscribe;
  }, [applySnapshot, electronMode, options.enabled, options.includeRateLimits]);

  useEffect(() => {
    if (!electronMode || !options.enabled || typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = (): void => {
      const nextVisible = isDocumentVisible();
      setVisible(nextVisible);

      if (!nextVisible) {
        return;
      }

      const staleAfterMs = options.includeRateLimits
        ? CODEX_VISIBLE_RATE_LIMITS_REFRESH_MS
        : CODEX_VISIBLE_STANDARD_REFRESH_MS;

      if (
        lastUpdatedAtRef.current === null ||
        Date.now() - lastUpdatedAtRef.current >= staleAfterMs
      ) {
        void refresh({
          includeRateLimits: options.includeRateLimits,
          silent: true,
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [electronMode, options.enabled, options.includeRateLimits, refresh]);

  useEffect(() => {
    if (!electronMode || !options.enabled) {
      return;
    }

    const refreshIntervalMs = getRefreshIntervalMs({
      loginStatus: snapshot?.login.status,
      includeRateLimits: options.includeRateLimits === true,
      visible,
    });
    const intervalId = window.setInterval(() => {
      void refresh({
        includeRateLimits: options.includeRateLimits,
        silent: true,
      });
    }, refreshIntervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    electronMode,
    options.enabled,
    options.includeRateLimits,
    refresh,
    snapshot?.login.status,
    visible,
  ]);

  const runAction = useCallback(
    async (runner: () => Promise<CodexAccountSnapshotDto>): Promise<boolean> => {
      if (!electronMode || !options.enabled) {
        return false;
      }

      setLoading(true);
      setError(null);
      try {
        const nextSnapshot = await runner();
        applySnapshot(nextSnapshot);
        return true;
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Codex account action failed');
        return false;
      } finally {
        setLoading(false);
      }
    },
    [applySnapshot, electronMode, options.enabled]
  );

  return useMemo(
    () => ({
      snapshot,
      loading,
      error,
      refresh,
      startChatgptLogin: () => runAction(() => api.startCodexChatgptLogin()),
      cancelChatgptLogin: () => runAction(() => api.cancelCodexChatgptLogin()),
      logout: () => runAction(() => api.logoutCodexAccount()),
    }),
    [error, loading, refresh, runAction, snapshot]
  );
}
