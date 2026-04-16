import { formatTeamModelSummary } from '@renderer/components/team/dialogs/TeamModelSelector';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type { MemberSpawnStatusEntry, ResolvedTeamMember, TeamProviderId } from '@shared/types';
import { inferTeamProviderIdFromModel } from '@shared/utils/teamProvider';

function isMemberLaunchPending(spawnEntry: MemberSpawnStatusEntry | undefined): boolean {
  if (!spawnEntry) {
    return false;
  }

  return (
    spawnEntry.launchState === 'starting' ||
    spawnEntry.launchState === 'runtime_pending_bootstrap' ||
    spawnEntry.status === 'waiting' ||
    spawnEntry.status === 'spawning'
  );
}

export function resolveMemberRuntimeSummary(
  member: ResolvedTeamMember,
  launchParams: TeamLaunchParams | undefined,
  spawnEntry: MemberSpawnStatusEntry | undefined
): string | undefined {
  const configuredProvider: TeamProviderId =
    member.providerId ?? launchParams?.providerId ?? 'anthropic';
  const configuredModel = member.model?.trim() || launchParams?.model?.trim() || '';
  const configuredEffort = member.effort ?? launchParams?.effort;
  const runtimeModel = spawnEntry?.runtimeModel?.trim();

  if (runtimeModel && (isMemberLaunchPending(spawnEntry) || configuredModel.length === 0)) {
    const runtimeProvider = inferTeamProviderIdFromModel(runtimeModel) ?? configuredProvider;
    return formatTeamModelSummary(runtimeProvider, runtimeModel, configuredEffort);
  }

  if (isMemberLaunchPending(spawnEntry)) {
    return undefined;
  }

  return formatTeamModelSummary(configuredProvider, configuredModel, configuredEffort);
}
