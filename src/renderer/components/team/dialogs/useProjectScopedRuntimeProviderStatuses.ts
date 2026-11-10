import { useMemo } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';

import { useTeamModelProviderStatus } from './useTeamModelProviderStatus';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

export interface ProjectScopedRuntimeProviderStatuses {
  projectScopedCliStatus: CliInstallationStatus | null;
  projectScopedOpenCodeStatus: CliProviderStatus | null;
  runtimeProviderStatusById: Map<CliProviderId, CliProviderStatus>;
}

/** Claude defaults and OpenCode routes use the launch project's runtime status. */
export function useProjectScopedRuntimeProviderStatuses(
  globalRuntimeProviderStatusById: ReadonlyMap<CliProviderId, CliProviderStatus>,
  projectPath: string,
  enabled = true
): ProjectScopedRuntimeProviderStatuses {
  const { cliStatus: projectScopedCliStatus, providerStatus: projectScopedOpenCodeStatus } =
    useEffectiveCliProviderStatus('opencode', { projectPath: projectPath || null });
  const { providerStatus: anthropicStatus } = useTeamModelProviderStatus(
    'anthropic',
    projectPath,
    enabled
  );
  const runtimeProviderStatusById = useMemo(() => {
    const statuses = new Map(globalRuntimeProviderStatusById);
    if (projectPath && projectScopedOpenCodeStatus) {
      statuses.set('opencode', projectScopedOpenCodeStatus);
    }
    if (projectPath && anthropicStatus) statuses.set('anthropic', anthropicStatus);
    return statuses;
  }, [globalRuntimeProviderStatusById, projectPath, projectScopedOpenCodeStatus, anthropicStatus]);

  return { projectScopedCliStatus, projectScopedOpenCodeStatus, runtimeProviderStatusById };
}
