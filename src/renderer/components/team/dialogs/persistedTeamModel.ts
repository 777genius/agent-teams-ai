import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';

import { resolveRuntimeDefaultModelLabel } from './runtimeDefaultModelLabel';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

interface PersistedTeamModelInput {
  model: string | undefined;
  selectedModel: string;
  providerId: TeamProviderId | undefined;
  globalStatus: CliProviderStatus | null | undefined;
  scopedStatus: CliProviderStatus | null | undefined;
  projectSelectionReady: boolean;
  probedCwd: string;
  persistedCwd: string | undefined;
  limitContext: boolean;
}

/** An unresolved configured default stays inherited when saving for a later launch. */
export function resolvePersistedTeamModel(input: PersistedTeamModelInput): string | undefined {
  if (
    input.providerId !== 'anthropic' ||
    (input.selectedModel.trim() && !isDefaultProviderModelSelection(input.selectedModel)) ||
    input.globalStatus?.effectiveDefaultModel === undefined
  ) {
    return input.model;
  }
  const scope = input.probedCwd.trim();
  if (!input.projectSelectionReady || !scope || input.persistedCwd?.trim() !== scope) {
    return undefined;
  }
  return resolveRuntimeDefaultModelLabel('anthropic', input.scopedStatus, input.limitContext)
    ?.modelLabel;
}
