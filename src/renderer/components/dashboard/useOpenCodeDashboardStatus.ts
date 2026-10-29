import { useCallback, useEffect, useMemo } from 'react';

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

/** Global runtime detection permits discovery, but cannot prove a project's models. */
function pendingProjectStatus(global: CliProviderStatus | null): CliProviderStatus | null {
  if (!global) return null;
  return {
    ...global,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'pending',
    statusCheckErrorCode: 'partial_response',
    effectiveDefaultModel: null,
    capabilities: { ...global.capabilities, teamLaunch: false, oneShot: false },
    models: [],
    modelAvailability: [],
    modelCatalog: null,
    modelCatalogRefreshState: 'loading',
  };
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
  const providerStatus = useMemo(
    () => (projectPath ? (scoped ?? pendingProjectStatus(global)) : global),
    [global, projectPath, scoped]
  );
  const enabled =
    input.enabled &&
    input.cliStatus?.flavor === 'agent_teams_orchestrator' &&
    input.runtimeStatus?.installed !== false &&
    canLoadOpenCodeDashboardCatalog(providerStatus, input.runtimeStatus);

  useEffect(() => {
    if (!enabled || !projectPath) return;
    // One passive read on entering a project or explicit cache invalidation.
    // V2 catalog-only staleAt values must not create an automatic retry loop.
    void fetchCliProviderStatus('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath,
    }).catch(() => undefined);
  }, [enabled, fetchCliProviderStatus, projectPath, scopeRevision]);

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
