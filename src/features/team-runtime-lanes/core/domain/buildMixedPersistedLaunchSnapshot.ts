import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberSources,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningMemberInput,
} from '@shared/types';

export interface MixedLaneLeadRuntimeDefaults {
  providerId: TeamProviderId;
  providerBackendId?: TeamProviderBackendId | null;
  selectedFastMode?: TeamFastMode;
  resolvedFastMode?: boolean | null;
  launchIdentity?: ProviderModelLaunchIdentity | null;
}

export interface MixedSecondaryLaneMemberStateInput {
  laneId: string;
  member: TeamProvisioningMemberInput;
  leadDefaults: MixedLaneLeadRuntimeDefaults;
  evidence?: {
    launchState?: MemberLaunchState;
    agentToolAccepted?: boolean;
    runtimeAlive?: boolean;
    bootstrapConfirmed?: boolean;
    hardFailure?: boolean;
    hardFailureReason?: string;
    pendingPermissionRequestIds?: string[];
    runtimePid?: number;
    runtimeSessionId?: string;
    sessionId?: string;
    livenessKind?: TeamAgentRuntimeLivenessKind;
    pidSource?: TeamAgentRuntimePidSource;
    runtimeDiagnostic?: string;
    runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
    diagnostics?: string[];
  } | null;
  pendingReason?: string;
}

function deriveMemberLaunchState(params: {
  hardFailure?: boolean;
  bootstrapConfirmed?: boolean;
  runtimeAlive?: boolean;
  agentToolAccepted?: boolean;
  pendingPermissionRequestIds?: string[];
}): MemberLaunchState {
  if (params.hardFailure) {
    return 'failed_to_start';
  }
  if (params.bootstrapConfirmed) {
    return 'confirmed_alive';
  }
  if ((params.pendingPermissionRequestIds?.length ?? 0) > 0) {
    return 'runtime_pending_permission';
  }
  if (params.runtimeAlive || params.agentToolAccepted) {
    return 'runtime_pending_bootstrap';
  }
  return 'starting';
}

function preservesStrongRuntimeAlive(value: {
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
  livenessKind?: TeamAgentRuntimeLivenessKind;
}): boolean {
  return (
    value.runtimeAlive === true &&
    (value.bootstrapConfirmed === true ||
      value.livenessKind === 'confirmed_bootstrap' ||
      value.livenessKind === 'runtime_process')
  );
}

function buildDiagnostics(
  member: Pick<
    PersistedTeamLaunchMemberState,
    | 'agentToolAccepted'
    | 'runtimeAlive'
    | 'bootstrapConfirmed'
    | 'hardFailureReason'
    | 'sources'
    | 'pendingPermissionRequestIds'
  >
): string[] {
  const diagnostics: string[] = [];
  if (member.agentToolAccepted) diagnostics.push('spawn accepted');
  if (member.runtimeAlive) diagnostics.push('runtime alive');
  if (member.bootstrapConfirmed) diagnostics.push('late heartbeat received');
  if ((member.pendingPermissionRequestIds?.length ?? 0) > 0) {
    diagnostics.push('waiting for permission approval');
  } else if (member.runtimeAlive && !member.bootstrapConfirmed) {
    diagnostics.push('waiting for teammate check-in');
  }
  if (member.hardFailureReason)
    diagnostics.push(`hard failure reason: ${member.hardFailureReason}`);
  if (member.sources?.duplicateRespawnBlocked) diagnostics.push('respawn blocked as duplicate');
  if (member.sources?.configDrift) diagnostics.push('config drift detected');
  return diagnostics;
}

function createSourcesFromStatus(
  status: Pick<
    MemberSpawnStatusEntry,
    'livenessSource' | 'runtimeAlive' | 'bootstrapConfirmed' | 'livenessKind'
  >
): PersistedTeamLaunchMemberSources | undefined {
  const sources: PersistedTeamLaunchMemberSources = {};
  if (status.livenessSource === 'heartbeat') {
    sources.nativeHeartbeat = true;
    sources.inboxHeartbeat = true;
  }
  if (status.livenessSource === 'process' && preservesStrongRuntimeAlive(status)) {
    sources.processAlive = true;
  }
  return Object.values(sources).some(Boolean) ? sources : undefined;
}

function normalizeFastMode(value: TeamFastMode | undefined): TeamFastMode | undefined {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : undefined;
}

function createPrimaryLaneMemberState(params: {
  member: TeamProvisioningMemberInput;
  status?: MemberSpawnStatusEntry;
  updatedAt: string;
  leadDefaults: MixedLaneLeadRuntimeDefaults;
}): PersistedTeamLaunchMemberState {
  const providerId =
    normalizeOptionalTeamProviderId(params.member.providerId) ?? params.leadDefaults.providerId;
  const runtime = params.status;
  const strongRuntimeAlive = preservesStrongRuntimeAlive(runtime ?? {});
  const sources = runtime ? createSourcesFromStatus(runtime) : undefined;
  const base: PersistedTeamLaunchMemberState = {
    name: params.member.name.trim(),
    providerId,
    providerBackendId:
      migrateProviderBackendId(providerId, params.member.providerBackendId) ??
      (providerId === params.leadDefaults.providerId
        ? (params.leadDefaults.providerBackendId ?? undefined)
        : undefined),
    model: params.member.model?.trim() || undefined,
    effort: params.member.effort,
    selectedFastMode:
      normalizeFastMode(params.member.fastMode) ??
      (providerId === params.leadDefaults.providerId
        ? normalizeFastMode(params.leadDefaults.selectedFastMode)
        : undefined),
    resolvedFastMode:
      providerId === params.leadDefaults.providerId
        ? (params.leadDefaults.resolvedFastMode ?? undefined)
        : undefined,
    laneId: 'primary',
    laneKind: 'primary',
    laneOwnerProviderId: params.leadDefaults.providerId,
    launchIdentity:
      providerId === params.leadDefaults.providerId
        ? (params.leadDefaults.launchIdentity ?? undefined)
        : undefined,
    launchState:
      runtime?.launchState ??
      deriveMemberLaunchState({
        hardFailure: runtime?.hardFailure,
        bootstrapConfirmed: runtime?.bootstrapConfirmed,
        runtimeAlive: strongRuntimeAlive,
        agentToolAccepted: runtime?.agentToolAccepted,
        pendingPermissionRequestIds: runtime?.pendingPermissionRequestIds,
      }),
    agentToolAccepted: runtime?.agentToolAccepted === true,
    runtimeAlive: strongRuntimeAlive,
    bootstrapConfirmed: runtime?.bootstrapConfirmed === true,
    hardFailure: runtime?.hardFailure === true || runtime?.launchState === 'failed_to_start',
    hardFailureReason: runtime?.hardFailureReason ?? runtime?.error,
    pendingPermissionRequestIds: runtime?.pendingPermissionRequestIds?.length
      ? [...new Set(runtime.pendingPermissionRequestIds)]
      : undefined,
    livenessKind: runtime?.livenessKind,
    runtimeDiagnostic: runtime?.runtimeDiagnostic,
    runtimeDiagnosticSeverity: runtime?.runtimeDiagnosticSeverity,
    firstSpawnAcceptedAt: runtime?.firstSpawnAcceptedAt,
    lastHeartbeatAt: runtime?.lastHeartbeatAt,
    runtimeLastSeenAt: runtime?.livenessLastCheckedAt,
    lastRuntimeAliveAt: preservesStrongRuntimeAlive(runtime ?? {}) ? params.updatedAt : undefined,
    lastEvaluatedAt: runtime?.updatedAt ?? params.updatedAt,
    sources,
    diagnostics: undefined,
  };
  base.diagnostics = buildDiagnostics(base);
  return base;
}

function createSecondaryLaneMemberState(
  params: MixedSecondaryLaneMemberStateInput & { updatedAt: string }
): PersistedTeamLaunchMemberState {
  const providerId =
    normalizeOptionalTeamProviderId(params.member.providerId) ?? params.leadDefaults.providerId;
  const evidence = params.evidence;
  const strongRuntimeAlive = preservesStrongRuntimeAlive(evidence ?? {});
  const hardFailureReason = evidence?.hardFailureReason;
  const launchState =
    evidence?.launchState ??
    deriveMemberLaunchState({
      hardFailure: evidence?.hardFailure,
      bootstrapConfirmed: evidence?.bootstrapConfirmed,
      runtimeAlive: strongRuntimeAlive,
      agentToolAccepted: evidence?.agentToolAccepted,
      pendingPermissionRequestIds: evidence?.pendingPermissionRequestIds,
    });
  const base: PersistedTeamLaunchMemberState = {
    name: params.member.name.trim(),
    providerId,
    providerBackendId:
      migrateProviderBackendId(providerId, params.member.providerBackendId) ??
      (providerId === params.leadDefaults.providerId
        ? (params.leadDefaults.providerBackendId ?? undefined)
        : undefined),
    model: params.member.model?.trim() || undefined,
    effort: params.member.effort,
    selectedFastMode:
      normalizeFastMode(params.member.fastMode) ??
      (providerId === params.leadDefaults.providerId
        ? normalizeFastMode(params.leadDefaults.selectedFastMode)
        : undefined),
    resolvedFastMode:
      providerId === params.leadDefaults.providerId
        ? (params.leadDefaults.resolvedFastMode ?? undefined)
        : undefined,
    laneId: params.laneId,
    laneKind: 'secondary',
    laneOwnerProviderId: providerId,
    launchState,
    agentToolAccepted: evidence?.agentToolAccepted === true,
    runtimeAlive: strongRuntimeAlive,
    bootstrapConfirmed: evidence?.bootstrapConfirmed === true,
    hardFailure: evidence?.hardFailure === true || launchState === 'failed_to_start',
    hardFailureReason,
    pendingPermissionRequestIds: evidence?.pendingPermissionRequestIds?.length
      ? [...new Set(evidence.pendingPermissionRequestIds)]
      : undefined,
    runtimePid:
      typeof evidence?.runtimePid === 'number' &&
      Number.isFinite(evidence.runtimePid) &&
      evidence.runtimePid > 0
        ? Math.trunc(evidence.runtimePid)
        : undefined,
    runtimeSessionId: evidence?.runtimeSessionId ?? evidence?.sessionId,
    livenessKind: evidence?.livenessKind,
    pidSource: evidence?.pidSource,
    runtimeDiagnostic: evidence?.runtimeDiagnostic,
    runtimeDiagnosticSeverity: evidence?.runtimeDiagnosticSeverity,
    firstSpawnAcceptedAt: evidence?.agentToolAccepted ? params.updatedAt : undefined,
    lastHeartbeatAt: evidence?.bootstrapConfirmed ? params.updatedAt : undefined,
    runtimeLastSeenAt: strongRuntimeAlive ? params.updatedAt : undefined,
    lastRuntimeAliveAt: strongRuntimeAlive ? params.updatedAt : undefined,
    lastEvaluatedAt: params.updatedAt,
    sources: strongRuntimeAlive
      ? {
          processAlive: true,
          nativeHeartbeat: evidence?.bootstrapConfirmed === true || undefined,
          inboxHeartbeat: evidence?.bootstrapConfirmed === true || undefined,
        }
      : undefined,
    diagnostics: evidence?.diagnostics?.length
      ? [...evidence.diagnostics]
      : !evidence && params.pendingReason
        ? [params.pendingReason]
        : undefined,
  };
  base.diagnostics = base.diagnostics?.length ? base.diagnostics : buildDiagnostics(base);
  return base;
}

function summarizeMembers(
  expectedMembers: readonly string[],
  members: Record<string, PersistedTeamLaunchMemberState>
): PersistedTeamLaunchSnapshot['summary'] {
  let confirmedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let runtimeAlivePendingCount = 0;
  let shellOnlyPendingCount = 0;
  let runtimeProcessPendingCount = 0;
  let runtimeCandidatePendingCount = 0;
  let noRuntimePendingCount = 0;
  let permissionPendingCount = 0;

  for (const memberName of expectedMembers) {
    const entry = members[memberName];
    if (!entry) {
      pendingCount += 1;
      continue;
    }
    if (entry.launchState === 'confirmed_alive') {
      confirmedCount += 1;
      continue;
    }
    if (entry.launchState === 'failed_to_start') {
      failedCount += 1;
      continue;
    }
    pendingCount += 1;
    if (entry.runtimeAlive) {
      runtimeAlivePendingCount += 1;
    }
    if (entry.launchState === 'runtime_pending_permission') {
      permissionPendingCount += 1;
    }
    if (entry.livenessKind === 'shell_only') {
      shellOnlyPendingCount += 1;
    } else if (entry.livenessKind === 'runtime_process') {
      runtimeProcessPendingCount += 1;
    } else if (entry.livenessKind === 'runtime_process_candidate') {
      runtimeCandidatePendingCount += 1;
    } else if (
      entry.livenessKind === 'not_found' ||
      entry.livenessKind === 'stale_metadata' ||
      entry.livenessKind === 'registered_only'
    ) {
      noRuntimePendingCount += 1;
    }
  }

  return {
    confirmedCount,
    pendingCount,
    failedCount,
    runtimeAlivePendingCount,
    shellOnlyPendingCount,
    runtimeProcessPendingCount,
    runtimeCandidatePendingCount,
    noRuntimePendingCount,
    permissionPendingCount,
  };
}

function deriveTeamLaunchState(
  summary: PersistedTeamLaunchSnapshot['summary']
): PersistedTeamLaunchSnapshot['teamLaunchState'] {
  if (summary.failedCount > 0) {
    return 'partial_failure';
  }
  if (summary.pendingCount > 0) {
    return 'partial_pending';
  }
  return 'clean_success';
}

export function buildMixedPersistedLaunchSnapshot(params: {
  teamName: string;
  leadSessionId?: string;
  launchPhase: PersistedTeamLaunchPhase;
  leadDefaults: MixedLaneLeadRuntimeDefaults;
  primaryMembers: readonly TeamProvisioningMemberInput[];
  primaryStatuses: Record<string, MemberSpawnStatusEntry>;
  secondaryMembers?: readonly MixedSecondaryLaneMemberStateInput[];
  updatedAt?: string;
}): PersistedTeamLaunchSnapshot {
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  const primaryExpectedMembers = params.primaryMembers
    .map((member) => member.name.trim())
    .filter((name) => name.length > 0 && name !== 'user' && !isLeadMember({ name }));
  const members: Record<string, PersistedTeamLaunchMemberState> = {};

  for (const member of params.primaryMembers) {
    const trimmedName = member.name.trim();
    if (!trimmedName || trimmedName === 'user' || isLeadMember({ name: trimmedName })) continue;
    members[trimmedName] = createPrimaryLaneMemberState({
      member,
      status: params.primaryStatuses[trimmedName],
      updatedAt,
      leadDefaults: params.leadDefaults,
    });
  }

  for (const laneMember of params.secondaryMembers ?? []) {
    const trimmedName = laneMember.member.name.trim();
    if (!trimmedName || trimmedName === 'user' || isLeadMember({ name: trimmedName })) continue;
    members[trimmedName] = createSecondaryLaneMemberState({
      ...laneMember,
      updatedAt,
    });
  }

  const expectedMembers = Array.from(new Set([...primaryExpectedMembers, ...Object.keys(members)]));
  const summary = summarizeMembers(expectedMembers, members);

  return {
    version: 2,
    teamName: params.teamName,
    updatedAt,
    ...(params.leadSessionId ? { leadSessionId: params.leadSessionId } : {}),
    launchPhase: params.launchPhase,
    expectedMembers,
    ...(primaryExpectedMembers.join('\u0000') !== expectedMembers.join('\u0000')
      ? { bootstrapExpectedMembers: primaryExpectedMembers }
      : {}),
    members,
    summary,
    teamLaunchState: deriveTeamLaunchState(summary),
  };
}
