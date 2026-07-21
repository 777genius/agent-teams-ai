import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { scheduleStartupIdleTask } from '@renderer/utils/startupIdleTask';

import type {
  CodexAccountSnapshotDto,
  CodexChatgptLoginMode,
} from '@features/codex-account/contracts';

const CODEX_PENDING_LOGIN_REFRESH_MS = 3_000;
const CODEX_VISIBLE_RATE_LIMITS_REFRESH_MS = 60_000;
const CODEX_VISIBLE_STANDARD_REFRESH_MS = 60_000;
const CODEX_HIDDEN_REFRESH_MS = 5 * 60_000;
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

export function isCodexAccountSnapshotPending(
  loading: boolean,
  snapshot: CodexAccountSnapshotDto | null
): boolean {
  if (!loading || snapshot?.login.status === 'starting' || snapshot?.login.status === 'pending') {
    return false;
  }

  return (
    snapshot === null ||
    snapshot.launchReadinessState === 'missing_auth' ||
    snapshot.launchReadinessState === 'runtime_missing'
  );
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
  const latestSnapshotRef = useRef<CodexAccountSnapshotDto | null>(null);
  const loadingTokensRef = useRef(new Set<symbol>());
  const rateLimitsLoadingTokensRef = useRef(new Set<symbol>());
  const mountedRef = useRef(true);
  const enabledRef = useRef(false);
  const lifecycleIdRef = useRef(0);
  const snapshotRevisionRef = useRef(0);
  const latestErrorRequestIdRef = useRef(0);
  // A deferred callback must see rate-limit fulfillment from pushes/manual refreshes immediately.
  const initialRateLimitsAttemptedRef = useRef(false);
  const lastUpdatedAtRef = useRef<number | null>(null);
  const snapshotUpdatedAtRef = useRef<number | null>(null);
  const initialRefreshDelayMs = options.initialRefreshDelayMs ?? 0;
  const initialRefreshMaxDelayMs = options.initialRefreshMaxDelayMs;
  // "Attempted" means settled (success or failure) within the current enabled lifecycle.
  const [initialRefreshAttempted, setInitialRefreshAttempted] = useState(false);
  const [initialRateLimitsAttempted, setInitialRateLimitsAttempted] = useState(false);
  const enabled = electronMode && options.enabled;

  useEffect(() => {
    const loadingTokens = loadingTokensRef.current;
    const rateLimitsLoadingTokens = rateLimitsLoadingTokensRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleIdRef.current += 1;
      loadingTokens.clear();
      rateLimitsLoadingTokens.clear();
    };
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      if (options.includeRateLimits !== true) {
        initialRateLimitsAttemptedRef.current = false;
        setInitialRateLimitsAttempted(false);
      }
      return;
    }

    lifecycleIdRef.current += 1;
    snapshotRevisionRef.current += 1;
    latestSnapshotRef.current = null;
    lastUpdatedAtRef.current = null;
    snapshotUpdatedAtRef.current = null;
    setSnapshot(null);
    setInitialRefreshAttempted(false);
    initialRateLimitsAttemptedRef.current = false;
    setInitialRateLimitsAttempted(false);
    loadingTokensRef.current.clear();
    rateLimitsLoadingTokensRef.current.clear();
    setLoading(false);
    setRateLimitsLoading(false);
    setError(null);
  }, [enabled, options.includeRateLimits]);

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
    latestSnapshotRef.current = nextSnapshot;
    snapshotRevisionRef.current += 1;
    setSnapshot(nextSnapshot);
    if (nextSnapshot.rateLimits !== null) {
      initialRateLimitsAttemptedRef.current = true;
      setInitialRateLimitsAttempted(true);
    }
    setError(null);
  }, []);

  const refresh = useCallback(
    async (refreshOptions?: {
      includeRateLimits?: boolean;
      forceRefreshToken?: boolean;
      silent?: boolean;
    }) => {
      if (!electronMode || !mountedRef.current || !enabledRef.current) {
        return false;
      }

      const silent = refreshOptions?.silent === true;
      const includeRateLimits = refreshOptions?.includeRateLimits ?? options.includeRateLimits;
      const lifecycleId = lifecycleIdRef.current;
      const snapshotRevision = snapshotRevisionRef.current;
      const errorRequestId = silent ? null : ++latestErrorRequestIdRef.current;
      const loadingToken = silent ? null : Symbol('codex-account-refresh');
      const rateLimitsLoadingToken = includeRateLimits ? Symbol('codex-rate-limits-refresh') : null;
      if (!silent) {
        loadingTokensRef.current.add(loadingToken!);
        setLoading(true);
        setError(null);
      }
      if (includeRateLimits) {
        rateLimitsLoadingTokensRef.current.add(rateLimitsLoadingToken!);
        setRateLimitsLoading(true);
      }
      try {
        const nextSnapshot = await api.refreshCodexAccountSnapshot({
          includeRateLimits,
          forceRefreshToken: refreshOptions?.forceRefreshToken,
        });
        if (!mountedRef.current || !enabledRef.current || lifecycleIdRef.current !== lifecycleId) {
          return false;
        }
        applySnapshot(nextSnapshot);
        if (includeRateLimits) {
          initialRateLimitsAttemptedRef.current = true;
          setInitialRateLimitsAttempted(true);
        }
        return true;
      } catch (nextError) {
        if (
          !silent &&
          mountedRef.current &&
          enabledRef.current &&
          lifecycleIdRef.current === lifecycleId &&
          snapshotRevisionRef.current === snapshotRevision &&
          latestErrorRequestIdRef.current === errorRequestId
        ) {
          setError(
            nextError instanceof Error ? nextError.message : 'Failed to refresh Codex account'
          );
        }
        return false;
      } finally {
        if (loadingToken) {
          loadingTokensRef.current.delete(loadingToken);
          if (mountedRef.current) {
            setLoading(loadingTokensRef.current.size > 0);
          }
        }
        if (rateLimitsLoadingToken) {
          rateLimitsLoadingTokensRef.current.delete(rateLimitsLoadingToken);
          if (mountedRef.current) {
            setRateLimitsLoading(rateLimitsLoadingTokensRef.current.size > 0);
          }
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
      if (!active) {
        return;
      }

      const latestSnapshot = latestSnapshotRef.current;
      const needsAccountSnapshot = latestSnapshot === null;
      const needsRateLimits =
        options.includeRateLimits === true &&
        latestSnapshot?.rateLimits == null &&
        !initialRateLimitsAttemptedRef.current;
      if (!needsAccountSnapshot && !needsRateLimits) {
        return;
      }

      setError(null);

      const lifecycleId = lifecycleIdRef.current;
      const snapshotRevision = snapshotRevisionRef.current;
      const errorRequestId = ++latestErrorRequestIdRef.current;
      const initialSnapshotRequest = Promise.resolve().then(() =>
        options.includeRateLimits
          ? api.refreshCodexAccountSnapshot({
              includeRateLimits: true,
            })
          : api.getCodexAccountSnapshot()
      );

      void initialSnapshotRequest
        .then((nextSnapshot) => {
          if (
            active &&
            mountedRef.current &&
            enabledRef.current &&
            lifecycleIdRef.current === lifecycleId
          ) {
            applySnapshot(nextSnapshot);
          }
        })
        .catch((nextError) => {
          if (
            active &&
            mountedRef.current &&
            enabledRef.current &&
            lifecycleIdRef.current === lifecycleId &&
            snapshotRevisionRef.current === snapshotRevision &&
            latestErrorRequestIdRef.current === errorRequestId
          ) {
            setError(
              nextError instanceof Error ? nextError.message : 'Failed to load Codex account'
            );
          }
        })
        .finally(() => {
          if (
            !active ||
            !mountedRef.current ||
            !enabledRef.current ||
            lifecycleIdRef.current !== lifecycleId
          ) {
            return;
          }
          setInitialRefreshAttempted(true);
          if (options.includeRateLimits) {
            initialRateLimitsAttemptedRef.current = true;
            setInitialRateLimitsAttempted(true);
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

    // Visibility may have changed while this hook was disabled and unsubscribed.
    setVisible(isDocumentVisible());

    const handleVisibilityChange = (): void => {
      const nextVisible = isDocumentVisible();
      setVisible(nextVisible);

      if (!nextVisible) {
        return;
      }

      const staleAfterMs = options.includeRateLimits
        ? CODEX_VISIBLE_RATE_LIMITS_REFRESH_MS
        : CODEX_VISIBLE_STANDARD_REFRESH_MS;

      if (lastUpdatedAtRef.current === null && snapshot === null && !initialRefreshAttempted) {
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
    if (snapshot === null && !initialRefreshAttempted) {
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
      if (!electronMode || !mountedRef.current || !enabledRef.current) {
        return false;
      }

      const lifecycleId = lifecycleIdRef.current;
      const errorRequestId = ++latestErrorRequestIdRef.current;
      const loadingToken = Symbol('codex-account-action');
      loadingTokensRef.current.add(loadingToken);
      setLoading(true);
      setError(null);
      try {
        const nextSnapshot = await runner();
        if (!mountedRef.current || !enabledRef.current || lifecycleIdRef.current !== lifecycleId) {
          return false;
        }
        applySnapshot(nextSnapshot);
        return true;
      } catch (nextError) {
        if (
          mountedRef.current &&
          enabledRef.current &&
          lifecycleIdRef.current === lifecycleId &&
          latestErrorRequestIdRef.current === errorRequestId
        ) {
          setError(nextError instanceof Error ? nextError.message : 'Codex account action failed');
        }
        return false;
      } finally {
        loadingTokensRef.current.delete(loadingToken);
        if (mountedRef.current) {
          setLoading(loadingTokensRef.current.size > 0);
        }
      }
    },
    [applySnapshot, electronMode, options.enabled]
  );

  // Derived pending state covers the first render, before the initial effect can run.
  const waitingForInitialRefresh = enabled && snapshot === null && !initialRefreshAttempted;
  const waitingForInitialRateLimits =
    enabled &&
    options.includeRateLimits === true &&
    snapshot?.rateLimits == null &&
    !initialRateLimitsAttempted;
  const effectiveLoading = enabled && (loading || waitingForInitialRefresh);
  const effectiveRateLimitsLoading = enabled && (rateLimitsLoading || waitingForInitialRateLimits);
  const effectiveSnapshot = enabled ? snapshot : null;
  const effectiveError = enabled ? error : null;

  return useMemo(
    () => ({
      snapshot: effectiveSnapshot,
      loading: effectiveLoading,
      rateLimitsLoading: effectiveRateLimitsLoading,
      error: effectiveError,
      refresh,
      startChatgptLogin: (mode) => runAction(() => api.startCodexChatgptLogin({ mode })),
      cancelChatgptLogin: () => runAction(() => api.cancelCodexChatgptLogin()),
      logout: () => runAction(() => api.logoutCodexAccount()),
    }),
    [
      effectiveError,
      effectiveLoading,
      effectiveRateLimitsLoading,
      effectiveSnapshot,
      refresh,
      runAction,
    ]
  );
}
