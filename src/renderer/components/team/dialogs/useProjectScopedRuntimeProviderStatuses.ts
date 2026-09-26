import { useMemo } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

export interface ProjectScopedRuntimeProviderStatuses {
  projectScopedCliStatus: CliInstallationStatus | null;
  projectScopedOpenCodeStatus: CliProviderStatus | null;
  runtimeProviderStatusById: Map<CliProviderId, CliProviderStatus>;
}

/** OpenCode launch authority is project-scoped; other providers keep their global status. */
export function useProjectScopedRuntimeProviderStatuses(
  globalRuntimeProviderStatusById: ReadonlyMap<CliProviderId, CliProviderStatus>,
  projectPath: string
): ProjectScopedRuntimeProviderStatuses {
  const { cliStatus: projectScopedCliStatus, providerStatus: projectScopedOpenCodeStatus } =
    useEffectiveCliProviderStatus('opencode', { projectPath: projectPath || null });
  const runtimeProviderStatusById = useMemo(() => {
    const statuses = new Map(globalRuntimeProviderStatusById);
    if (projectPath && projectScopedOpenCodeStatus) {
      statuses.set('opencode', projectScopedOpenCodeStatus);
    }
    return statuses;
  }, [globalRuntimeProviderStatusById, projectPath, projectScopedOpenCodeStatus]);

  return { projectScopedCliStatus, projectScopedOpenCodeStatus, runtimeProviderStatusById };
}
