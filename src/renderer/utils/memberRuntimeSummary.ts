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
  const configuredProvider: TeamProviderId =
    member.providerId ?? launchParams?.providerId ?? 'anthropic';
  const inheritsLeadRuntimeDefaults =
    member.providerId == null ||
    launchParams?.providerId == null ||
    member.providerId === launchParams.providerId;
  const configuredModel =
    member.model?.trim() || (inheritsLeadRuntimeDefaults ? launchParams?.model?.trim() || '' : '');
  const configuredEffort =
    member.effort ?? (inheritsLeadRuntimeDefaults ? launchParams?.effort : undefined);
  const runtimeModel = spawnEntry?.runtimeModel?.trim() || runtimeEntry?.runtimeModel?.trim();
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
    return undefined;
  }

  const summary = formatTeamModelSummary(configuredProvider, configuredModel, configuredEffort);
  return `${summary}${backendLabel ? ` · ${backendLabel}` : ''}${memorySuffix}`;
}
