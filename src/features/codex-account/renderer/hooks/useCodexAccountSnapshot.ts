import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { scheduleStartupIdleTask } from '@renderer/utils/startupIdleTask';

import type {
  CodexAccountSnapshotDto,
  CodexChatgptLoginMode,
} from '@features/codex-account/contracts';

const CODEX_PENDING_LOGIN_REFRESH_MS = 3_000;
const CODEX_VISIBLE_RATE_LIMITS_REFRESH_MS = 10_000;
const CODEX_VISIBLE_STANDARD_REFRESH_MS = 20_000;
const CODEX_HIDDEN_REFRESH_MS = 60_000;
export const CODEX_ACCOUNT_STARTUP_IDLE_MIN_DELAY_MS = 2_000;
export const CODEX_ACCOUNT_STARTUP_IDLE_MAX_DELAY_MS = 30_000;
export const CODEX_ACCOUNT_STARTUP_IDLE_DELAY_MS = CODEX_ACCOUNT_STARTUP_IDLE_MAX_DELAY_MS;

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

function getSnapshotUpdatedAtMs(snapshot: CodexAccountSnapshotDto): number | null {
  const updatedAtMs = Date.parse(snapshot.updatedAt);
  return Number.isFinite(updatedAtMs) ? updatedAtMs : null;
}

export function useCodexAccountSnapshot(options: {
  enabled: boolean;
  includeRateLimits?: boolean;
  initialRefreshDelayMs?: number;
  initialRefreshMaxDelayMs?: number;
}): {
  snapshot: CodexAccountSnapshotDto | null;
  loading: boolean;
  rateLimitsLoading: boolean;
  error: string | null;
  refresh: (options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
    silent?: boolean;
  }) => Promise<boolean>;
  startChatgptLogin: (mode?: CodexChatgptLoginMode) => Promise<boolean>;
  cancelChatgptLogin: () => Promise<boolean>;
  logout: () => Promise<boolean>;
} {
  const electronMode = isElectronMode();
  const [snapshot, setSnapshot] = useState<CodexAccountSnapshotDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => isDocumentVisible());
  const lastUpdatedAtRef = useRef<number | null>(null);
  const snapshotUpdatedAtRef = useRef<number | null>(null);
  const initialRefreshDelayMs = options.initialRefreshDelayMs ?? 0;
  const initialRefreshMaxDelayMs = options.initialRefreshMaxDelayMs;
  const [initialRefreshAttempted, setInitialRefreshAttempted] = useState(
    () => initialRefreshDelayMs <= 0
  );

  const applySnapshot = useCallback((nextSnapshot: CodexAccountSnapshotDto) => {
    const nextUpdatedAtMs = getSnapshotUpdatedAtMs(nextSnapshot);
    if (
      nextUpdatedAtMs !== null &&
      snapshotUpdatedAtRef.current !== null &&
      nextUpdatedAtMs < snapshotUpdatedAtRef.current
    ) {
      return;
    }

    snapshotUpdatedAtRef.current = nextUpdatedAtMs ?? Date.now();
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
        return false;
      }

      const silent = refreshOptions?.silent === true;
      const includeRateLimits = refreshOptions?.includeRateLimits ?? options.includeRateLimits;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      if (includeRateLimits) {
        setRateLimitsLoading(true);
      }
      try {
        const nextSnapshot = await api.refreshCodexAccountSnapshot({
          includeRateLimits,
          forceRefreshToken: refreshOptions?.forceRefreshToken,
        });
        applySnapshot(nextSnapshot);
        return true;
      } catch (nextError) {
        if (!silent) {
          setError(
            nextError instanceof Error ? nextError.message : 'Failed to refresh Codex account'
          );
        }
        return false;
      } finally {
        if (!silent) {
          setLoading(false);
        }
        if (includeRateLimits) {
          setRateLimitsLoading(false);
        }
      }
    },
    [applySnapshot, electronMode, options.enabled, options.includeRateLimits]
  );

  useEffect(() => {
    if (!electronMode || !options.enabled) {
      return;
    }

    let active = true;
    let cancelInitialRefresh: (() => void) | null = null;

    const startInitialSnapshotRequest = (): void => {
      if (!active || lastUpdatedAtRef.current !== null) {
        return;
      }

      setLoading(true);
      if (options.includeRateLimits) {
        setRateLimitsLoading(true);
      }
      setError(null);

      const initialSnapshotRequest = options.includeRateLimits
        ? api.refreshCodexAccountSnapshot({
            includeRateLimits: true,
          })
        : api.getCodexAccountSnapshot();

      void initialSnapshotRequest
        .then((nextSnapshot) => {
          if (active) {
            applySnapshot(nextSnapshot);
          }
        })
        .catch((nextError) => {
          if (active) {
            setError(
              nextError instanceof Error ? nextError.message : 'Failed to load Codex account'
            );
          }
        })
        .finally(() => {
          if (!active) {
            return;
          }
          setInitialRefreshAttempted(true);
          setLoading(false);
          if (options.includeRateLimits) {
            setRateLimitsLoading(false);
          }
        });
    };

    if (initialRefreshDelayMs > 0) {
      if (typeof initialRefreshMaxDelayMs === 'number') {
        cancelInitialRefresh = scheduleStartupIdleTask(startInitialSnapshotRequest, {
          minDelayMs: initialRefreshDelayMs,
          maxDelayMs: initialRefreshMaxDelayMs,
        });
      } else {
        const initialRefreshTimer = window.setTimeout(
          startInitialSnapshotRequest,
          initialRefreshDelayMs
        );
        cancelInitialRefresh = () => window.clearTimeout(initialRefreshTimer);
      }
    } else {
      startInitialSnapshotRequest();
    }

    const unsubscribe = api.onCodexAccountSnapshotChanged((_event, nextSnapshot) => {
      applySnapshot(nextSnapshot);
    });

    return () => {
      active = false;
      cancelInitialRefresh?.();
      unsubscribe();
    };
  }, [
    applySnapshot,
    electronMode,
    initialRefreshDelayMs,
    initialRefreshMaxDelayMs,
    options.enabled,
    options.includeRateLimits,
  ]);

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
        initialRefreshDelayMs > 0 &&
        lastUpdatedAtRef.current === null &&
        snapshot === null &&
        !initialRefreshAttempted
      ) {
        return;
      }

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
  }, [
    electronMode,
    initialRefreshAttempted,
    initialRefreshDelayMs,
    options.enabled,
    options.includeRateLimits,
    refresh,
    snapshot,
  ]);

  useEffect(() => {
    if (!electronMode || !options.enabled) {
      return;
    }
    if (initialRefreshDelayMs > 0 && snapshot === null && !initialRefreshAttempted) {
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
    initialRefreshAttempted,
    initialRefreshDelayMs,
    options.enabled,
    options.includeRateLimits,
    refresh,
    snapshot,
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

  const waitingForInitialRefresh =
    electronMode &&
    options.enabled &&
    initialRefreshDelayMs > 0 &&
    snapshot === null &&
    !initialRefreshAttempted;
  const effectiveLoading = loading || waitingForInitialRefresh;
  const effectiveRateLimitsLoading =
    rateLimitsLoading || (waitingForInitialRefresh && options.includeRateLimits === true);

  return useMemo(
    () => ({
      snapshot,
      loading: effectiveLoading,
      rateLimitsLoading: effectiveRateLimitsLoading,
      error,
      refresh,
      startChatgptLogin: (mode) => runAction(() => api.startCodexChatgptLogin({ mode })),
      cancelChatgptLogin: () => runAction(() => api.cancelCodexChatgptLogin()),
      logout: () => runAction(() => api.logoutCodexAccount()),
    }),
    [effectiveLoading, effectiveRateLimitsLoading, error, refresh, runAction, snapshot]
  );
}
