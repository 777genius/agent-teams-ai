import { resolveRuntimeDefaultModelLabel } from './runtimeDefaultModelLabel';
import { useTeamModelProviderStatus } from './useTeamModelProviderStatus';

import type { TeamDefaultModelLabel } from './runtimeDefaultModelLabel';
import type { TeamProviderId } from '@shared/types';

/** Reads the same provider status as the selector without turning Default into a selection. */
export function useRuntimeDefaultModelLabel(
  providerId: TeamProviderId,
  limitContext = false,
  enabled = true,
  projectPath?: string | null
): TeamDefaultModelLabel | null {
  const { providerStatus } = useTeamModelProviderStatus(
    enabled && providerId !== 'opencode' ? providerId : undefined,
    projectPath
  );
  return enabled ? resolveRuntimeDefaultModelLabel(providerId, providerStatus, limitContext) : null;
}
