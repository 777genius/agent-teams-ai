import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import type { TeamMetaFile } from './TeamMetaStore';
import type { TeamMemberSnapshot } from '@shared/types';

type SyntheticLeadRuntimeSettings = Pick<
  TeamMemberSnapshot,
  | 'providerId'
  | 'providerBackendId'
  | 'model'
  | 'effort'
  | 'selectedFastMode'
  | 'configuredRuntimeSettings'
  | 'resolvedFastMode'
  | 'laneOwnerProviderId'
>;

export function resolveSyntheticLeadRuntimeSettings(
  teamMeta: TeamMetaFile | null | undefined
): SyntheticLeadRuntimeSettings {
  const identity = teamMeta?.launchIdentity;
  const providerId = identity?.providerId ?? teamMeta?.providerId;
  const providerBackendId =
    migrateProviderBackendId(
      providerId,
      identity?.providerBackendId ?? teamMeta?.providerBackendId
    ) ?? undefined;
  const selectedEffort = identity
    ? (identity.selectedEffort ?? undefined)
    : isTeamEffortLevel(teamMeta?.effort)
      ? teamMeta.effort
      : undefined;

  return {
    providerId,
    providerBackendId,
    model: identity?.resolvedLaunchModel ?? identity?.selectedModel ?? teamMeta?.model,
    effort:
      identity?.resolvedEffort ??
      identity?.selectedEffort ??
      (isTeamEffortLevel(teamMeta?.effort) ? teamMeta.effort : undefined),
    selectedFastMode: identity?.selectedFastMode ?? teamMeta?.fastMode ?? undefined,
    configuredRuntimeSettings: {
      providerId,
      providerBackendId,
      model: identity
        ? identity.selectedModelKind === 'explicit'
          ? (identity.selectedModel ?? undefined)
          : undefined
        : teamMeta?.model,
      effort: selectedEffort,
      fastMode: identity?.selectedFastMode ?? teamMeta?.fastMode ?? undefined,
    },
    resolvedFastMode:
      typeof identity?.resolvedFastMode === 'boolean' ? identity.resolvedFastMode : undefined,
    laneOwnerProviderId: providerId ?? 'anthropic',
  };
}
