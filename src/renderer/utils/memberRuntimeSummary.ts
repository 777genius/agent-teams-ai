import { formatTeamModelSummary } from '@renderer/components/team/dialogs/TeamModelSelector';
import { formatBytes } from '@renderer/utils/formatters';
import { formatTeamProviderBackendLabel } from '@renderer/utils/providerBackendIdentity';
import { inferTeamProviderIdFromModel } from '@shared/utils/teamProvider';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamProviderId,
} from '@shared/types';

function normalizeMemberBackendLabel(
  providerId: TeamProviderId,
  backendLabel: string | undefined
): string | undefined {
  if (!backendLabel) {
    return undefined;
  }

  if (providerId === 'codex' && backendLabel === 'Codex native') {
    return 'Codex';
  }

  return backendLabel;
}

function isMemberLaunchPending(spawnEntry: MemberSpawnStatusEntry | undefined): boolean {
  if (!spawnEntry) {
    return false;
  }

  return (
    spawnEntry.launchState === 'starting' ||
    spawnEntry.launchState === 'runtime_pending_bootstrap' ||
    spawnEntry.launchState === 'runtime_pending_permission' ||
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
  const memberProviderBackendId = (member as ResolvedTeamMember & { providerBackendId?: string })
    .providerBackendId;
  const memberModel = member.model?.trim() || '';
  const runtimeModel = spawnEntry?.runtimeModel?.trim() || runtimeEntry?.runtimeModel?.trim();
  const inferredMemberProvider =
    inferTeamProviderIdFromModel(memberModel) ?? inferTeamProviderIdFromModel(runtimeModel);
  const configuredProvider: TeamProviderId =
    member.providerId ?? inferredMemberProvider ?? launchParams?.providerId ?? 'anthropic';
  const memberProviderForInheritance = member.providerId ?? inferredMemberProvider;
  const inheritsLeadRuntimeDefaults =
    memberProviderForInheritance == null ||
    launchParams?.providerId == null ||
    memberProviderForInheritance === launchParams.providerId;
  const configuredModel =
    memberModel || (inheritsLeadRuntimeDefaults ? launchParams?.model?.trim() || '' : '');
  const configuredEffort =
    member.effort ?? (inheritsLeadRuntimeDefaults ? launchParams?.effort : undefined);
  const configuredProviderBackendId =
    memberProviderBackendId ??
    (inheritsLeadRuntimeDefaults ? launchParams?.providerBackendId : undefined);
  const backendLabel = normalizeMemberBackendLabel(
    configuredProvider,
    formatTeamProviderBackendLabel(configuredProvider, configuredProviderBackendId)
  );
  const memorySuffix =
    typeof runtimeEntry?.rssBytes === 'number' && runtimeEntry.rssBytes > 0
      ? ` · ${formatBytes(runtimeEntry.rssBytes)}`
      : '';

  if (runtimeModel && (isMemberLaunchPending(spawnEntry) || configuredModel.length === 0)) {
    const runtimeProvider = inferTeamProviderIdFromModel(runtimeModel) ?? configuredProvider;
    const summary = formatTeamModelSummary(runtimeProvider, runtimeModel, configuredEffort);
    return `${summary}${backendLabel ? ` · ${backendLabel}` : ''}${memorySuffix}`;
  }

  if (isMemberLaunchPending(spawnEntry)) {
    if (!configuredModel.length && !memorySuffix) {
      return undefined;
    }
    const summary = formatTeamModelSummary(configuredProvider, configuredModel, configuredEffort);
    return `${summary}${backendLabel ? ` · ${backendLabel}` : ''}${memorySuffix}`;
  }

  const summary = formatTeamModelSummary(configuredProvider, configuredModel, configuredEffort);
  return `${summary}${backendLabel ? ` · ${backendLabel}` : ''}${memorySuffix}`;
}
