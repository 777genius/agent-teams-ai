import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import { getCliFlavorUiOptions, getConfiguredCliFlavor } from '../cliFlavor';

import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

export function getProviderRuntimeFailureLabel(providerId: TeamProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Claude CLI';
    case 'codex':
      return 'Codex runtime';
    case 'gemini':
      return 'Gemini runtime';
    case 'opencode':
      return 'OpenCode runtime';
  }
}

/**
 * Human-readable runtime label for failure messages. When a launch request
 * resolves to a single provider its specific label is used; a mixed-provider
 * roster falls back to the configured CLI flavor's display name.
 */
export function getRuntimeFailureLabelForRequest(
  request: Pick<TeamCreateRequest, 'providerId' | 'model' | 'members'>
): string {
  const providerIds = new Set<TeamProviderId>();
  const addProvider = (providerId: TeamProviderId | undefined): void => {
    if (providerId) {
      providerIds.add(providerId);
    }
  };

  addProvider(normalizeOptionalTeamProviderId(request.providerId));
  addProvider(inferTeamProviderIdFromModel(request.model));
  for (const member of request.members) {
    addProvider(normalizeOptionalTeamProviderId(member.providerId));
    addProvider(inferTeamProviderIdFromModel(member.model));
  }

  if (providerIds.size === 1) {
    return getProviderRuntimeFailureLabel([...providerIds][0]);
  }

  return getCliFlavorUiOptions(getConfiguredCliFlavor()).displayName;
}

export function buildMissingCliError(): Error {
  if (getConfiguredCliFlavor() === 'agent_teams_orchestrator') {
    return new Error(
      'Multimodel runtime not found. The packaged app must include resources/runtime/claude-multimodel, or development must provide CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.'
    );
  }
  return new Error('Claude CLI not found; install it or provide a valid path');
}
