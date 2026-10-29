import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useStore } from '@renderer/store';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';

import { canLoadOpenCodeDashboardCatalog } from './openCodeDashboardCatalogPolicy';

import type { AnalyticsProviderCheckReason } from '@renderer/analytics/productAnalytics';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  OpenCodeRuntimeStatus,
} from '@shared/types';
import type { Dispatch, SetStateAction } from 'react';

/** Global runtime detection cannot prove a project's credentials or models. */
function projectStatusWithoutAuthority(
  global: CliProviderStatus | null,
  pending: boolean
): CliProviderStatus | null {
  if (!global) return null;
  return {
    ...global,
    authenticated: false,
    authMethod: null,
    verificationState: pending ? 'unknown' : global.verificationState,
    statusCheckOutcome: pending ? 'pending' : global.statusCheckOutcome,
    statusCheckErrorCode: pending ? 'partial_response' : global.statusCheckErrorCode,
    modelVerificationState: 'idle',
    defaultModel: null,
    effectiveDefaultModel: null,
    teamLaunchAuthorityRestriction: undefined,
    capabilities: { ...global.capabilities, teamLaunch: false, oneShot: false },
    backend: null,
    connection: null,
    models: [],
    modelAvailability: [],
    modelCatalog: null,
    modelCatalogRefreshState: pending ? 'loading' : 'error',
  };
}

function unavailableProjectStatus(
  global: CliProviderStatus | null,
  runtime: OpenCodeRuntimeStatus | null
): CliProviderStatus | null {
  if (!global) return null;
  if (
    ['checking', 'downloading', 'installing'].includes(runtime?.state ?? '') ||
    (global.statusCheckOutcome === 'pending' &&
      runtime?.installed !== false &&
      runtime?.v2Support !== 'required')
  ) {
    return projectStatusWithoutAuthority(global, true);
  }
  const hasSettledFailure =
    global.statusCheckOutcome !== 'pending' &&
    (!global.supported ||
      global.statusCheckOutcome === 'transient_error' ||
      global.statusCheckErrorCode != null);
  return projectStatusWithoutAuthority(
    {
      ...global,
      supported: false,
      ...(!hasSettledFailure && {
        verificationState: 'error',
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: runtime?.installed === false ? 'runtime_missing' : 'unavailable',
        statusMessage:
          runtime?.error ??
          (runtime?.v2Support === 'required'
            ? 'OpenCode V2 support must be installed.'
            : 'OpenCode runtime is not installed.'),
        detailMessage: runtime?.error ?? null,
      }),
    },
    false
  );
}

export function useOpenCodeDashboardStatus(input: {
  enabled: boolean;
  projectPath: string | null;
  cliStatus: CliInstallationStatus | null;
  runtimeStatus: OpenCodeRuntimeStatus | null;
}) {
  const projectPath = input.projectPath?.trim() || null;
  const scopeRevision = useStore((state) => state.cliProviderStatusScopeRevision);
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  const scoped = useStore((state) =>
    projectPath
      ? (state.cliProviderStatusByScope[getCliProviderStatusScopeKey('opencode', projectPath)] ??
        null)
      : null
  );
  const global =
    input.cliStatus?.providers.find((provider) => provider.providerId === 'opencode') ?? null;
  const canReadCatalog =
    input.runtimeStatus?.installed !== false &&
    !['checking', 'downloading', 'installing'].includes(input.runtimeStatus?.state ?? '') &&
    canLoadOpenCodeDashboardCatalog(global ?? scoped, input.runtimeStatus);
  const providerStatus = useMemo(
    () =>
      !projectPath
        ? global
        : !canReadCatalog
          ? unavailableProjectStatus(global, input.runtimeStatus)
          : (scoped ?? projectStatusWithoutAuthority(global, true)),
    [canReadCatalog, global, input.runtimeStatus, projectPath, scoped]
  );
  const enabled =
    input.enabled && input.cliStatus?.flavor === 'agent_teams_orchestrator' && canReadCatalog;
  const scopeMissing = scoped === null;
  const lastRead = useRef<{
    projectPath: string;
    revision: number;
    present: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !projectPath) {
      lastRead.current = null;
      return;
    }
    const previous = lastRead.current;
    const sameContext =
      previous?.projectPath === projectPath && previous.revision === scopeRevision;
    const shouldRead = !sameContext || (previous?.present === true && scopeMissing);
    lastRead.current = { projectPath, revision: scopeRevision, present: !scopeMissing };
    if (!shouldRead) return;
    // Read on entry, invalidation, or a real present -> missing cache eviction.
    // Completion, missing -> missing and V2 staleAt values cannot retry the read.
    void fetchCliProviderStatus('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath,
    }).catch(() => undefined);
  }, [enabled, fetchCliProviderStatus, projectPath, scopeMissing, scopeRevision]);

  return { enabled, providerStatus };
}

export function useDashboardProviderRefresh(
  projectPath: string | null,
  refreshOpenCodeProviderDirectory: () => void,
  setAnthropicRateLimitsRefreshVersion: Dispatch<SetStateAction<number>>
) {
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  return useCallback(
    async (
      providerId: CliProviderId,
      checkReason: AnalyticsProviderCheckReason = 'manual_refresh'
    ) => {
      let refreshed: boolean;
      try {
        refreshed = await fetchCliProviderStatus(providerId, {
          checkReason,
          ...(providerId === 'opencode' && projectPath?.trim()
            ? { projectPath: projectPath.trim() }
            : {}),
        });
      } finally {
        // Wait for status before refreshing directory/model reads in their shared lane.
        if (providerId === 'opencode') refreshOpenCodeProviderDirectory();
      }
      if (refreshed && providerId === 'anthropic') {
        setAnthropicRateLimitsRefreshVersion((current) => current + 1);
      }
      return refreshed;
    },
    [
      fetchCliProviderStatus,
      projectPath,
      refreshOpenCodeProviderDirectory,
      setAnthropicRateLimitsRefreshVersion,
    ]
  );
}
