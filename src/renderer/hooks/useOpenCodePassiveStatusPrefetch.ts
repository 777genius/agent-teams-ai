import { useEffect, useReducer, useRef } from 'react';

import { useStore } from '@renderer/store';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { isTeamProviderModelCatalogFresh } from '@renderer/utils/teamModelAvailability';

const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

export function useOpenCodePassiveStatusPrefetch({
  enabled,
  projectPath,
  catalogRecovery,
}: {
  enabled: boolean;
  projectPath: string | null | undefined;
  catalogRecovery?: { projectPath: string | null; freshUntil: string | null } | null;
}): void {
  const normalizedProjectPath = projectPath?.trim() || '';
  const recoveryProjectPath = catalogRecovery?.projectPath?.trim() || '';
  const recoveryFreshUntil = catalogRecovery?.freshUntil;
  const cliStatus = useStore((state) => state.cliStatus);
  const runtimeStatus = useStore((state) => state.openCodeRuntimeStatus);
  const scopeRevision = useStore((state) => state.cliProviderStatusScopeRevision) ?? 0;
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  const scopedProviderStatus = useStore((state) =>
    normalizedProjectPath
      ? (state.cliProviderStatusByScope?.[
          getCliProviderStatusScopeKey('opencode', normalizedProjectPath)
        ] ?? null)
      : null
  );
  const requestedRevisionByScopeRef = useRef(new Map<string, number>());
  const refreshedExpiryByScopeRef = useRef(new Map<string, string>());
  const scopesWithObservedStatusRef = useRef(new Set<string>());
  const recoveredFailuresByScopeRef = useRef(new Set<string>());
  const activeScopeRef = useRef('');
  const [refreshSequence, publishCompletion] = useReducer((sequence: number) => sequence + 1, 0);

  activeScopeRef.current = normalizedProjectPath;

  useEffect(() => {
    if (!enabled || !isTeamProviderModelCatalogFresh('opencode', scopedProviderStatus)) return;
    const staleAt = Date.parse(scopedProviderStatus!.modelCatalog!.staleAt);
    const timeout = window.setTimeout(
      publishCompletion,
      Math.min(Math.max(0, staleAt - Date.now()), MAX_BROWSER_TIMEOUT_MS)
    );
    return () => window.clearTimeout(timeout);
  }, [enabled, normalizedProjectPath, scopedProviderStatus, scopeRevision, refreshSequence]);

  useEffect(() => {
    if (scopedProviderStatus?.statusCheckOutcome === 'authoritative') {
      recoveredFailuresByScopeRef.current.delete(normalizedProjectPath);
    }
    // A catalog proves that runtime reads work again, but does not grant launch
    // authority. Recheck the failed project status once per unresolved incident.
    const catalogRecoveryDue =
      normalizedProjectPath !== '' &&
      recoveryProjectPath === normalizedProjectPath &&
      Date.parse(recoveryFreshUntil ?? '') > Date.now() &&
      runtimeStatus?.installed === true &&
      runtimeStatus.state === 'ready' &&
      scopedProviderStatus?.statusCheckOutcome === 'transient_error' &&
      scopedProviderStatus.statusCheckErrorCode !== 'project_missing' &&
      !recoveredFailuresByScopeRef.current.has(normalizedProjectPath);
    const catalog = scopedProviderStatus?.modelCatalog;
    const staleAt = Date.parse(catalog?.staleAt ?? '');
    const expiryKey =
      catalog &&
      catalog.status === 'ready' &&
      scopedProviderStatus.modelCatalogRefreshState === 'ready' &&
      !isTeamProviderModelCatalogFresh('opencode', scopedProviderStatus) &&
      Number.isFinite(staleAt) &&
      staleAt <= Date.now()
        ? JSON.stringify([scopeRevision, catalog.fetchedAt, catalog.staleAt])
        : null;
    const expiryRefreshDue =
      expiryKey !== null &&
      refreshedExpiryByScopeRef.current.get(normalizedProjectPath) !== expiryKey;
    if (scopedProviderStatus) {
      scopesWithObservedStatusRef.current.add(normalizedProjectPath);
      if (
        !requestedRevisionByScopeRef.current.has(normalizedProjectPath) &&
        !expiryRefreshDue &&
        !catalogRecoveryDue &&
        scopedProviderStatus.statusCheckOutcome !== 'pending'
      ) {
        requestedRevisionByScopeRef.current.set(normalizedProjectPath, scopeRevision);
        return;
      }
    } else if (scopesWithObservedStatusRef.current.delete(normalizedProjectPath)) {
      // A bounded scoped-status cache can evict a previously loaded project while
      // this hook still remembers its requested revision. Make that scope eligible
      // for another request without disturbing requests that are still in flight.
      requestedRevisionByScopeRef.current.delete(normalizedProjectPath);
      refreshedExpiryByScopeRef.current.delete(normalizedProjectPath);
    }
    if (
      !enabled ||
      !normalizedProjectPath ||
      cliStatus?.flavor !== 'agent_teams_orchestrator' ||
      typeof fetchCliProviderStatus !== 'function' ||
      (requestedRevisionByScopeRef.current.get(normalizedProjectPath) === scopeRevision &&
        !expiryRefreshDue &&
        !catalogRecoveryDue)
    ) {
      return;
    }

    requestedRevisionByScopeRef.current.set(normalizedProjectPath, scopeRevision);
    if (catalogRecoveryDue) recoveredFailuresByScopeRef.current.add(normalizedProjectPath);
    if (expiryKey !== null) refreshedExpiryByScopeRef.current.set(normalizedProjectPath, expiryKey);
    let cancelled = false;
    // A settled failure (including the same expired payload) gets one attempt.
    // Explicit scope invalidation or a newer catalog can authorize another read.
    void fetchCliProviderStatus('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: normalizedProjectPath,
    }).then(
      () => {
        if (!cancelled && activeScopeRef.current === normalizedProjectPath) publishCompletion();
      },
      () => {
        if (!cancelled && activeScopeRef.current === normalizedProjectPath) publishCompletion();
      }
    );

    return () => {
      cancelled = true;
    };
  }, [
    cliStatus?.flavor,
    enabled,
    fetchCliProviderStatus,
    normalizedProjectPath,
    recoveryProjectPath,
    recoveryFreshUntil,
    runtimeStatus?.installed,
    runtimeStatus?.state,
    scopedProviderStatus,
    scopeRevision,
    refreshSequence,
  ]);
}
