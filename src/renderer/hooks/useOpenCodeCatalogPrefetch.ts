import { useEffect, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { isTeamProviderModelCatalogFresh } from '@renderer/utils/teamModelAvailability';

import type { CliProviderStatus } from '@shared/types';

const OPENCODE_CATALOG_PREFETCH_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;
const OPENCODE_BACKGROUND_PREFETCH_FALLBACK_DELAY_MS = 1_500;
const OPENCODE_BACKGROUND_PREFETCH_IDLE_TIMEOUT_MS = 5_000;
const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

type OpenCodeCatalogPrefetchPriority = 'background' | 'required';

export interface OpenCodeCatalogPrefetchState {
  requiredCatalogPending: boolean;
}

function getCatalogStaleAtMs(providerStatus: CliProviderStatus | null): number | null {
  const staleAt = providerStatus?.modelCatalog?.staleAt;
  if (!staleAt) {
    return null;
  }

  const staleAtMs = Date.parse(staleAt);
  return Number.isFinite(staleAtMs) ? staleAtMs : null;
}

function schedulePrefetch(
  callback: () => void,
  priority: OpenCodeCatalogPrefetchPriority
): () => void {
  if (priority === 'required') {
    const timeoutId = window.setTimeout(callback, 0);
    return () => window.clearTimeout(timeoutId);
  }

  if (
    typeof window.requestIdleCallback === 'function' &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    const idleHandle = window.requestIdleCallback(callback, {
      timeout: OPENCODE_BACKGROUND_PREFETCH_IDLE_TIMEOUT_MS,
    });
    return () => window.cancelIdleCallback(idleHandle);
  }

  const timeoutId = window.setTimeout(callback, OPENCODE_BACKGROUND_PREFETCH_FALLBACK_DELAY_MS);
  return () => window.clearTimeout(timeoutId);
}

export function useOpenCodeCatalogPrefetch({
  enabled,
  projectPath,
  priority = 'background',
  deferBackground = false,
}: {
  enabled: boolean;
  projectPath: string | null | undefined;
  priority?: OpenCodeCatalogPrefetchPriority;
  deferBackground?: boolean;
}): OpenCodeCatalogPrefetchState {
  const [refreshSequence, setRefreshSequence] = useState(0);
  const mountedRef = useRef(true);
  const enabledRef = useRef(enabled);
  const activeScopeRef = useRef('');
  const scopeRevisionRef = useRef(0);
  const previousScopeRef = useRef('');
  const requestRevisionByScopeRef = useRef(new Map<string, number>());
  const retryCountByScopeRef = useRef(new Map<string, number>());
  const retryTimerByScopeRef = useRef(new Map<string, number>());
  const retryExhaustedRevisionByScopeRef = useRef(new Map<string, number>());
  const normalizedProjectPath = projectPath?.trim() || '';
  const cliStatus = useStore((state) => state.cliStatus);
  const scopeRevision = useStore((state) => state.cliProviderStatusScopeRevision) ?? 0;
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  const scopedProviderStatus = useStore((state) =>
    normalizedProjectPath
      ? (state.cliProviderStatusByScope?.[
          getCliProviderStatusScopeKey('opencode', normalizedProjectPath)
        ] ?? null)
      : null
  );
  const catalogFresh = isTeamProviderModelCatalogFresh('opencode', scopedProviderStatus);
  const catalogStaleAtMs = getCatalogStaleAtMs(scopedProviderStatus);

  activeScopeRef.current = normalizedProjectPath;
  scopeRevisionRef.current = scopeRevision;
  enabledRef.current = enabled;

  useEffect(() => {
    const previousScope = previousScopeRef.current;
    previousScopeRef.current = normalizedProjectPath;
    if (!previousScope || previousScope === normalizedProjectPath) {
      return;
    }

    const previousRetryTimer = retryTimerByScopeRef.current.get(previousScope);
    if (previousRetryTimer !== undefined) {
      window.clearTimeout(previousRetryTimer);
      retryTimerByScopeRef.current.delete(previousScope);
    }
    retryCountByScopeRef.current.delete(previousScope);
    retryExhaustedRevisionByScopeRef.current.delete(previousScope);
  }, [normalizedProjectPath]);

  useEffect(() => {
    const retryTimers = retryTimerByScopeRef.current;
    const requestRevisions = requestRevisionByScopeRef.current;
    const retryCounts = retryCountByScopeRef.current;
    const exhaustedRevisions = retryExhaustedRevisionByScopeRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timeoutId of retryTimers.values()) {
        window.clearTimeout(timeoutId);
      }
      retryTimers.clear();
      requestRevisions.clear();
      retryCounts.clear();
      exhaustedRevisions.clear();
    };
  }, []);

  useEffect(() => {
    const clearRetryTimer = (): void => {
      const retryTimer = retryTimerByScopeRef.current.get(normalizedProjectPath);
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimerByScopeRef.current.delete(normalizedProjectPath);
      }
    };

    if (
      !enabled ||
      !normalizedProjectPath ||
      cliStatus?.flavor !== 'agent_teams_orchestrator' ||
      typeof fetchCliProviderStatus !== 'function'
    ) {
      if (!enabled && normalizedProjectPath) {
        clearRetryTimer();
        retryCountByScopeRef.current.delete(normalizedProjectPath);
        retryExhaustedRevisionByScopeRef.current.delete(normalizedProjectPath);
      }
      return;
    }

    if (catalogFresh) {
      clearRetryTimer();
      retryCountByScopeRef.current.delete(normalizedProjectPath);
      retryExhaustedRevisionByScopeRef.current.delete(normalizedProjectPath);
      if (catalogStaleAtMs == null) {
        return;
      }

      const timeoutId = window.setTimeout(
        () => setRefreshSequence((sequence) => sequence + 1),
        Math.min(MAX_BROWSER_TIMEOUT_MS, Math.max(0, catalogStaleAtMs - Date.now() + 1))
      );
      return () => window.clearTimeout(timeoutId);
    }

    if (priority === 'background' && deferBackground) {
      return;
    }
    if (requestRevisionByScopeRef.current.get(normalizedProjectPath) === scopeRevision) {
      return;
    }
    if (retryTimerByScopeRef.current.has(normalizedProjectPath)) {
      return;
    }

    return schedulePrefetch(() => {
      const requestScope = normalizedProjectPath;
      const requestScopeRevision = scopeRevision;
      const scheduleRetry = (): void => {
        if (
          !mountedRef.current ||
          !enabledRef.current ||
          activeScopeRef.current !== requestScope ||
          scopeRevisionRef.current !== requestScopeRevision
        ) {
          return;
        }
        const retryCount = retryCountByScopeRef.current.get(requestScope) ?? 0;
        const retryDelay = OPENCODE_CATALOG_PREFETCH_RETRY_DELAYS_MS[retryCount];
        if (retryDelay === undefined) {
          retryExhaustedRevisionByScopeRef.current.set(requestScope, requestScopeRevision);
          setRefreshSequence((sequence) => sequence + 1);
          return;
        }
        retryExhaustedRevisionByScopeRef.current.delete(requestScope);
        retryCountByScopeRef.current.set(requestScope, retryCount + 1);
        const existingRetryTimer = retryTimerByScopeRef.current.get(requestScope);
        if (existingRetryTimer !== undefined) {
          window.clearTimeout(existingRetryTimer);
        }
        const retryTimer = window.setTimeout(() => {
          retryTimerByScopeRef.current.delete(requestScope);
          if (mountedRef.current && activeScopeRef.current === requestScope) {
            setRefreshSequence((sequence) => sequence + 1);
          }
        }, retryDelay);
        retryTimerByScopeRef.current.set(requestScope, retryTimer);
      };

      requestRevisionByScopeRef.current.set(requestScope, requestScopeRevision);
      void fetchCliProviderStatus('opencode', {
        silent: true,
        checkReason: 'launch_preflight',
        projectPath: requestScope,
      }).then(
        (loaded) => {
          if (requestRevisionByScopeRef.current.get(requestScope) === requestScopeRevision) {
            requestRevisionByScopeRef.current.delete(requestScope);
          }
          if (
            !mountedRef.current ||
            activeScopeRef.current !== requestScope ||
            scopeRevisionRef.current !== requestScopeRevision
          ) {
            return;
          }
          if (loaded) {
            // The fetch result is written to Zustand before this promise resolves. Re-render
            // once to read it, but keep a bounded retry armed until that render confirms a
            // genuinely fresh catalog. A hydrated provider status alone is not enough.
            scheduleRetry();
            setRefreshSequence((sequence) => sequence + 1);
            return;
          }
          scheduleRetry();
        },
        () => {
          if (requestRevisionByScopeRef.current.get(requestScope) === requestScopeRevision) {
            requestRevisionByScopeRef.current.delete(requestScope);
          }
          scheduleRetry();
        }
      );
    }, priority);
  }, [
    catalogFresh,
    catalogStaleAtMs,
    cliStatus?.flavor,
    deferBackground,
    enabled,
    fetchCliProviderStatus,
    normalizedProjectPath,
    priority,
    refreshSequence,
    scopeRevision,
  ]);

  return {
    requiredCatalogPending:
      enabled &&
      priority === 'required' &&
      Boolean(normalizedProjectPath) &&
      cliStatus?.flavor === 'agent_teams_orchestrator' &&
      !catalogFresh &&
      retryExhaustedRevisionByScopeRef.current.get(normalizedProjectPath) !== scopeRevision,
  };
}
