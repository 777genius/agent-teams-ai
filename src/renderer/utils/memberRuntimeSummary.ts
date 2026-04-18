import { formatTeamModelSummary } from '@renderer/components/team/dialogs/TeamModelSelector';
import { formatBytes } from '@renderer/utils/formatters';
import { inferTeamProviderIdFromModel } from '@shared/utils/teamProvider';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamProviderId,
} from '@shared/types';

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
  spawnEntry: MemberSpawnStatusEntry | undefined,
  runtimeEntry?: TeamAgentRuntimeEntry
): string | undefined {
  const configuredProvider: TeamProviderId =
    member.providerId ?? launchParams?.providerId ?? 'anthropic';
  const configuredModel = member.model?.trim() || launchParams?.model?.trim() || '';
  const configuredEffort = member.effort ?? launchParams?.effort;
  const runtimeModel = spawnEntry?.runtimeModel?.trim() || runtimeEntry?.runtimeModel?.trim();
  const memorySuffix =
    typeof runtimeEntry?.rssBytes === 'number' && runtimeEntry.rssBytes > 0
      ? ` · ${formatBytes(runtimeEntry.rssBytes)}`
      : '';

  if (runtimeModel && (isMemberLaunchPending(spawnEntry) || configuredModel.length === 0)) {
    const runtimeProvider = inferTeamProviderIdFromModel(runtimeModel) ?? configuredProvider;
    return `${formatTeamModelSummary(runtimeProvider, runtimeModel, configuredEffort)}${memorySuffix}`;
  }

  if (isMemberLaunchPending(spawnEntry)) {
    return undefined;
  }

  return `${formatTeamModelSummary(configuredProvider, configuredModel, configuredEffort)}${memorySuffix}`;
}
