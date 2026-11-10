import { useEffect, useMemo, useState } from 'react';

import {
  useOpenCodeDashboardConnectedCountProbe,
  useRuntimeProviderConnectedCount,
  useRuntimeProviderDirectoryCache,
} from '@features/runtime-provider-management/renderer';
import { isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';

import {
  DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS,
  getDashboardConnectionSummary,
} from './providerConnectionSummary';

import type { CliInstallationStatus } from '@shared/types';

/** Passive by default; visible Settings may opt into a connected-summary refresh. */
export function useProviderConnectionSummary(
  cliStatusOverride?: CliInstallationStatus | null,
  refreshConnectedCount = false
) {
  const storedCliStatus = useStore((state) => state.cliStatus);
  const cliStatus = cliStatusOverride === undefined ? storedCliStatus : cliStatusOverride;
  const cliStatusLoading = useStore((state) => state.cliStatusLoading);
  const cliStatusError = useStore((state) => state.cliStatusError);
  const cliProviderStatusLoading = useStore((state) => state.cliProviderStatusLoading);
  const openCodeRuntimeStatus = useStore((state) => state.openCodeRuntimeStatus);
  const openCodeRuntimeStatusLoading = useStore((state) => state.openCodeRuntimeStatusLoading);
  const selectedProjectId = useStore((state) => state.selectedProjectId);
  const projects = useStore((state) => state.projects);
  const repositoryGroups = useStore((state) => state.repositoryGroups);
  const multimodelEnabled = useStore(
    (state) => state.appConfig?.general?.multimodelEnabled ?? true
  );
  const projectPath = useMemo(
    () => resolveProjectPathById(selectedProjectId, projects, repositoryGroups)?.path ?? null,
    [selectedProjectId, projects, repositoryGroups]
  );

  const globalDirectory = useRuntimeProviderDirectoryCache(null);
  const projectDirectory = useRuntimeProviderDirectoryCache(projectPath);
  const countEvidence = useRuntimeProviderConnectedCount(projectPath);
  const observedOpenCodeCount = countEvidence?.observation ?? null;
  const openCodeIsChecking = Boolean(
    countEvidence?.checking ||
    openCodeRuntimeStatusLoading ||
    cliProviderStatusLoading?.opencode ||
    openCodeRuntimeStatus?.state === 'checking'
  );
  const [expiryRevision, expire] = useState(0);
  useEffect(() => {
    const snapshots = [
      globalDirectory?.fetchedAt,
      ...(projectPath ? [projectDirectory?.fetchedAt] : []),
      observedOpenCodeCount?.fetchedAt,
    ];
    // No provider read: this timer only expires the readiness title when
    // authenticated model evidence stops authorizing launch.
    const catalogExpiries = (cliStatus?.providers ?? [])
      .map((provider) => Date.parse(provider.modelCatalog?.staleAt ?? ''))
      .filter((time) => Number.isFinite(time) && time > Date.now());
    const expiries = snapshots
      .map((fetchedAt) => Date.parse(fetchedAt ?? '') + DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS)
      .filter((time) => Number.isFinite(time) && time > Date.now());
    const deadlines = [...expiries, ...catalogExpiries];
    if (deadlines.length === 0) return;
    const delay = Math.max(1, Math.min(...deadlines) - Date.now() + 10);
    const timer = window.setTimeout(() => expire((n) => n + 1), delay);
    return () => window.clearTimeout(timer);
  }, [
    cliStatus,
    globalDirectory,
    projectDirectory,
    projectPath,
    observedOpenCodeCount,
    expiryRevision,
  ]);

  const summary = getDashboardConnectionSummary({
    cliStatus,
    cliStatusLoading,
    providerStatusLoading: cliProviderStatusLoading,
    projectPath,
    globalDirectory,
    projectDirectory,
    observedOpenCodeCount,
    countInvalidated: countEvidence?.invalidated ?? false,
    runtimeStatus: openCodeRuntimeStatus,
  });

  useOpenCodeDashboardConnectedCountProbe({
    enabled:
      refreshConnectedCount &&
      isElectronMode() &&
      multimodelEnabled &&
      cliStatus?.installed === true &&
      cliStatus.flavor === 'agent_teams_orchestrator',
    projectPath,
    runtimeStatus: openCodeRuntimeStatus,
    connectedCount: summary.openCodeConnected,
  });

  return {
    summary,
    cliStatus,
    cliStatusLoading,
    cliStatusError,
    cliProviderStatusLoading,
    multimodelEnabled,
    openCodeIsChecking,
    projectPath,
    openCodeRuntimeStatus,
  };
}
