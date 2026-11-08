import { useEffect, useMemo, useState } from 'react';

import {
  useRuntimeProviderConnectedCount,
  useRuntimeProviderDirectoryCache,
} from '@features/runtime-provider-management/renderer';
import { useStore } from '@renderer/store';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';

import type { CliInstallationStatus } from '@shared/types';

import {
  DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS,
  getDashboardConnectionSummary,
} from './providerConnectionSummary';

/** Display-only selector: subscribing to snapshots never starts provider IPC. */
export function useProviderConnectionSummary(cliStatusOverride?: CliInstallationStatus | null) {
  const storedCliStatus = useStore((state) => state.cliStatus);
  const cliStatus = cliStatusOverride === undefined ? storedCliStatus : cliStatusOverride;
  const cliStatusLoading = useStore((state) => state.cliStatusLoading);
  const cliStatusError = useStore((state) => state.cliStatusError);
  const cliProviderStatusLoading = useStore((state) => state.cliProviderStatusLoading);
  const openCodeRuntimeStatus = useStore((state) => state.openCodeRuntimeStatus);
  const selectedProjectId = useStore((state) => state.selectedProjectId);
  const projects = useStore((state) => state.projects);
  const repositoryGroups = useStore((state) => state.repositoryGroups);
  const multimodelEnabled = useStore((state) => state.appConfig?.general?.multimodelEnabled ?? true);
  const projectPath = useMemo(
    () => resolveProjectPathById(selectedProjectId, projects, repositoryGroups)?.path ?? null,
    [selectedProjectId, projects, repositoryGroups]
  );

  const globalDirectory = useRuntimeProviderDirectoryCache(null);
  const projectDirectory = useRuntimeProviderDirectoryCache(projectPath);
  const countEvidence = useRuntimeProviderConnectedCount(projectPath);
  const observedOpenCodeCount = countEvidence?.observation ?? null;
  const [expiryRevision, expire] = useState(0);
  useEffect(() => {
    const snapshots = [
      globalDirectory?.fetchedAt,
      ...(projectPath ? [projectDirectory?.fetchedAt] : []),
      observedOpenCodeCount?.fetchedAt,
    ];
    const expiries = snapshots
      .map((fetchedAt) => Date.parse(fetchedAt ?? '') + DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS)
      .filter((time) => Number.isFinite(time) && time > Date.now());
    if (expiries.length === 0) return;
    const delay = Math.max(1, Math.min(...expiries) - Date.now() + 10);
    const timer = window.setTimeout(() => expire((n) => n + 1), delay);
    return () => window.clearTimeout(timer);
  }, [globalDirectory, projectDirectory, projectPath, observedOpenCodeCount, expiryRevision]);

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

  return { summary, cliStatus, cliStatusLoading, cliStatusError, multimodelEnabled };
}
