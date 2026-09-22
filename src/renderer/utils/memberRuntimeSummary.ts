import { formatTeamModelSummary } from '@renderer/components/team/dialogs/TeamModelSelector';
import { formatBytes } from '@renderer/utils/formatters';
import { formatTeamProviderBackendLabel } from '@renderer/utils/providerBackendIdentity';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { isLeadMember } from '@shared/utils/leadDetection';
import { inferTeamProviderIdFromModel } from '@shared/utils/teamProvider';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamProviderId,
} from '@shared/types';

function shouldShowRuntimeMemory(
  spawnEntry: MemberSpawnStatusEntry | undefined,
  runtimeEntry: TeamAgentRuntimeEntry | undefined
): boolean {
  if (typeof runtimeEntry?.rssBytes !== 'number' || runtimeEntry.rssBytes <= 0) {
    return false;
  }

  if (
    spawnEntry?.status === 'offline' ||
    spawnEntry?.status === 'skipped' ||
    spawnEntry?.launchState === 'skipped_for_launch'
  ) {
    return false;
  }

  if (!spawnEntry) {
    return runtimeEntry.alive === true;
  }

  return (
    runtimeEntry.alive === true ||
    spawnEntry.runtimeAlive === true ||
    spawnEntry.bootstrapConfirmed === true ||
    spawnEntry.livenessSource === 'process' ||
    spawnEntry.livenessSource === 'heartbeat'
  );
}

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

function appendRuntimeSummarySuffixes(
  summary: string,
  backendLabel: string | undefined,
  memorySuffix: string
): string {
  const summaryParts = new Set(summary.split(' · '));
  const backendSuffix = backendLabel && !summaryParts.has(backendLabel) ? ` · ${backendLabel}` : '';
  return `${summary}${backendSuffix}${memorySuffix}`;
}

export function getRuntimeMemorySourceLabel(
  runtimeEntry: TeamAgentRuntimeEntry | undefined
): string | undefined {
  if (runtimeEntry?.runtimeLoadScope === 'shared-host') {
    return 'RSS source: shared OpenCode host';
  }
  if (!runtimeEntry?.pidSource) {
    return undefined;
  }
  if (runtimeEntry.pidSource === 'tmux_pane') {
    return 'RSS source: tmux pane shell';
  }
  if (
    runtimeEntry.providerId === 'opencode' &&
    runtimeEntry.restartable === false &&
    runtimeEntry.pidSource === 'opencode_bridge'
  ) {
    return 'RSS source: shared OpenCode host';
  }
  if (runtimeEntry.pidSource === 'tmux_child' || runtimeEntry.pidSource === 'agent_process_table') {
    return 'RSS source: runtime process';
  }
  if (runtimeEntry.pidSource === 'lead_process') {
    return 'RSS source: lead process';
  }
  if (runtimeEntry.pidSource === 'runtime_bootstrap') {
    return 'RSS source: runtime bootstrap process';
  }
  if (runtimeEntry.pidSource === 'persisted_metadata') {
    return 'RSS source: persisted runtime metadata';
  }
  return `PID source: ${runtimeEntry.pidSource}`;
}

export function resolveMemberRuntimeSummary(
  member: ResolvedTeamMember,
  launchParams: TeamLaunchParams | undefined,
  spawnEntry: MemberSpawnStatusEntry | undefined,
  runtimeEntry?: TeamAgentRuntimeEntry
): string | undefined {
  const leadLaunchParams = isLeadMember(member) ? launchParams : undefined;
  const memberProviderBackendId = (member as ResolvedTeamMember & { providerBackendId?: string })
    .providerBackendId;
  const memberModel = member.model?.trim() || '';
  const runtimeModel = spawnEntry?.runtimeModel?.trim() || runtimeEntry?.runtimeModel?.trim();
  const runtimeModelProvider = inferTeamProviderIdFromModel(runtimeModel);
  const inferredMemberProvider = inferTeamProviderIdFromModel(memberModel) ?? runtimeModelProvider;
  const launchPending = isMemberLaunchPending(spawnEntry);
  const stalePrimaryLaneConflictsWithLaunch =
    !leadLaunchParams &&
    launchPending &&
    launchParams?.providerId != null &&
    member.laneKind === 'primary' &&
    member.laneOwnerProviderId != null &&
    member.laneOwnerProviderId !== launchParams.providerId;
  const authoritativeLaunchParams =
    leadLaunchParams ?? (stalePrimaryLaneConflictsWithLaunch ? launchParams : undefined);
  const configuredProvider: TeamProviderId =
    authoritativeLaunchParams?.providerId ??
    member.providerId ??
    inferredMemberProvider ??
    launchParams?.providerId ??
    'anthropic';
  const memberProviderForInheritance =
    authoritativeLaunchParams?.providerId ?? member.providerId ?? inferredMemberProvider;
  const inheritsLeadRuntimeDefaults =
    memberProviderForInheritance == null ||
    launchParams?.providerId == null ||
    memberProviderForInheritance === launchParams.providerId;
  const configuredModel = authoritativeLaunchParams
    ? authoritativeLaunchParams.model?.trim() || ''
    : memberModel || (inheritsLeadRuntimeDefaults ? launchParams?.model?.trim() || '' : '');
  const configuredEffort = authoritativeLaunchParams
    ? authoritativeLaunchParams.effort
    : (member.effort ?? (inheritsLeadRuntimeDefaults ? launchParams?.effort : undefined));
  const configuredProviderBackendId = authoritativeLaunchParams
    ? authoritativeLaunchParams.providerBackendId
    : (memberProviderBackendId ??
      (inheritsLeadRuntimeDefaults ? launchParams?.providerBackendId : undefined));
  const runtimeProviderId = runtimeModelProvider ?? runtimeEntry?.providerId;
  const runtimeModelConflictsWithAuthoritativeLaunch =
    launchPending &&
    authoritativeLaunchParams != null &&
    runtimeModel != null &&
    (authoritativeLaunchParams.model == null ||
      extractProviderScopedBaseModel(runtimeModel, runtimeProviderId ?? configuredProvider) !==
        extractProviderScopedBaseModel(
          authoritativeLaunchParams.model,
          authoritativeLaunchParams.providerId
        ));
  const runtimeConflictsWithAuthoritativeLaunch =
    authoritativeLaunchParams?.providerId != null &&
    (stalePrimaryLaneConflictsWithLaunch ||
      (runtimeProviderId != null && runtimeProviderId !== authoritativeLaunchParams.providerId) ||
      runtimeModelConflictsWithAuthoritativeLaunch);
  const displayRuntimeModel = runtimeConflictsWithAuthoritativeLaunch ? undefined : runtimeModel;
  const backendLabel = normalizeMemberBackendLabel(
    configuredProvider,
    formatTeamProviderBackendLabel(configuredProvider, configuredProviderBackendId)
  );
  const memorySuffix =
    !runtimeConflictsWithAuthoritativeLaunch && shouldShowRuntimeMemory(spawnEntry, runtimeEntry)
      ? ` · ${formatBytes(runtimeEntry!.rssBytes!)}`
      : '';

  if (displayRuntimeModel && (launchPending || configuredModel.length === 0)) {
    const runtimeProvider = runtimeModelProvider ?? configuredProvider;
    const summary = formatTeamModelSummary(runtimeProvider, displayRuntimeModel, configuredEffort);
    return appendRuntimeSummarySuffixes(summary, backendLabel, memorySuffix);
  }

  if (launchPending) {
    if (!authoritativeLaunchParams && !configuredModel.length && !memorySuffix) {
      return undefined;
    }
    const summary = formatTeamModelSummary(configuredProvider, configuredModel, configuredEffort);
    return appendRuntimeSummarySuffixes(summary, backendLabel, memorySuffix);
  }

  const summary = formatTeamModelSummary(configuredProvider, configuredModel, configuredEffort);
  return appendRuntimeSummarySuffixes(summary, backendLabel, memorySuffix);
}
