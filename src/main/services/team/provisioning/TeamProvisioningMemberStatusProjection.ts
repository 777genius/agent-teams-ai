import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';

import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import { deriveMemberLaunchState } from './TeamProvisioningLaunchFailurePolicy';
import {
  matchesExactTeamMemberName,
  matchesTeamMemberIdentity,
} from './TeamProvisioningMemberIdentity';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import { normalizeTeamMemberProviderId } from './TeamProvisioningMemberSpecs';

import type {
  EffortLevel,
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamCreateRequest,
  TeamFastMode,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface EffectiveConfiguredMember {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
  cwd?: string;
  agentType?: string;
  removedAt?: number | string;
}

export interface EffectiveRunMemberSource {
  allEffectiveMembers?: TeamCreateRequest['members'];
  effectiveMembers?: TeamCreateRequest['members'];
  memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
}

export interface FailedSpawnMember {
  name: string;
  error?: string;
  updatedAt: string;
}

export interface PendingMemberRestartProjection {
  requestedAt: string;
}

export interface RuntimeSpawnStatusProjectionSource {
  expectedMembers: readonly string[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  pendingMemberRestarts?: Map<string, PendingMemberRestartProjection>;
}

export function findConfiguredMemberModel(
  configuredMembers: TeamConfig['members'] | undefined,
  memberName: string
): string | undefined {
  for (const member of configuredMembers ?? []) {
    const candidateName = typeof member?.name === 'string' ? member.name.trim() : '';
    if (!candidateName || !matchesExactTeamMemberName(candidateName, memberName)) {
      continue;
    }
    const model = member.model?.trim();
    if (model) {
      return model;
    }
  }
  return undefined;
}

export function findMetaMemberModel(
  metaMembers: readonly TeamMember[],
  memberName: string
): string | undefined {
  for (const member of metaMembers) {
    const candidateName = member.name?.trim() ?? '';
    if (!candidateName || !matchesExactTeamMemberName(candidateName, memberName)) {
      continue;
    }
    const model = member.model?.trim();
    if (model) {
      return model;
    }
  }
  return undefined;
}

export function resolveEffectiveConfiguredMember(
  configuredMembers: TeamConfig['members'] | undefined,
  metaMembers: readonly TeamMember[],
  memberName: string
): EffectiveConfiguredMember | null {
  const configuredMember = (configuredMembers ?? []).find((member) => {
    const candidateName = typeof member?.name === 'string' ? member.name.trim() : '';
    return candidateName.length > 0 && matchesExactTeamMemberName(candidateName, memberName);
  });
  const metaMember = metaMembers.find((member) => {
    const candidateName = member.name?.trim() ?? '';
    return candidateName.length > 0 && matchesExactTeamMemberName(candidateName, memberName);
  });

  if (!configuredMember && !metaMember) {
    return null;
  }

  const name =
    metaMember?.name?.trim() || configuredMember?.name?.trim() || memberName.trim() || memberName;
  const role = metaMember?.role?.trim() || configuredMember?.role?.trim() || undefined;
  const workflow = metaMember?.workflow?.trim() || configuredMember?.workflow?.trim() || undefined;
  const isolation =
    metaMember?.isolation === 'worktree' || configuredMember?.isolation === 'worktree'
      ? 'worktree'
      : undefined;
  const providerId =
    normalizeTeamMemberProviderId(metaMember?.providerId) ??
    normalizeTeamMemberProviderId(configuredMember?.providerId);
  const providerBackendId =
    migrateProviderBackendId(metaMember?.providerId, metaMember?.providerBackendId) ??
    migrateProviderBackendId(configuredMember?.providerId, configuredMember?.providerBackendId);
  const model = metaMember?.model?.trim() || configuredMember?.model?.trim() || undefined;
  const effort = isTeamEffortLevel(metaMember?.effort)
    ? metaMember.effort
    : isTeamEffortLevel(configuredMember?.effort)
      ? configuredMember.effort
      : undefined;
  const fastMode =
    metaMember?.fastMode === 'inherit' ||
    metaMember?.fastMode === 'on' ||
    metaMember?.fastMode === 'off'
      ? metaMember.fastMode
      : configuredMember?.fastMode === 'inherit' ||
          configuredMember?.fastMode === 'on' ||
          configuredMember?.fastMode === 'off'
        ? configuredMember.fastMode
        : undefined;
  const agentType =
    metaMember?.agentType?.trim() || configuredMember?.agentType?.trim() || undefined;
  const mcpPolicy =
    normalizeTeamMemberMcpPolicy(metaMember?.mcpPolicy) ??
    normalizeTeamMemberMcpPolicy(configuredMember?.mcpPolicy);
  const cwd = metaMember?.cwd?.trim() || configuredMember?.cwd?.trim() || undefined;
  const removedAt = metaMember?.removedAt ?? configuredMember?.removedAt;

  return {
    name,
    ...(role ? { role } : {}),
    ...(workflow ? { workflow } : {}),
    ...(isolation ? { isolation } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerBackendId ? { providerBackendId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode } : {}),
    ...(mcpPolicy ? { mcpPolicy } : {}),
    ...(cwd ? { cwd } : {}),
    ...(agentType ? { agentType } : {}),
    ...(removedAt != null ? { removedAt } : {}),
  };
}

export function resolveLeadMemberName(
  configuredMembers: TeamConfig['members'] | undefined,
  metaMembers: readonly TeamMember[]
): string {
  const configuredLead = (configuredMembers ?? []).find((member) => isLeadMember(member));
  const configuredLeadName = configuredLead?.name?.trim();
  if (configuredLeadName) {
    return configuredLeadName;
  }

  const metaLead = metaMembers.find((member) => isLeadMember(member));
  const metaLeadName = metaLead?.name?.trim();
  if (metaLeadName) {
    return metaLeadName;
  }

  return 'team-lead';
}

export function isMemberRemovedInMeta(
  metaMembers: readonly TeamMember[],
  memberName: string
): boolean {
  const normalizedMemberName = memberName.trim().toLowerCase();
  if (!normalizedMemberName) {
    return false;
  }
  return metaMembers.some((member) => {
    const candidateName = member.name?.trim().toLowerCase() ?? '';
    return (
      candidateName.length > 0 &&
      candidateName === normalizedMemberName &&
      Boolean(member.removedAt)
    );
  });
}

export function filterRemovedMembersFromLaunchSnapshot(
  snapshot: PersistedTeamLaunchSnapshot,
  metaMembers: readonly TeamMember[],
  persistedLaunchMemberNames: readonly string[]
): PersistedTeamLaunchSnapshot {
  const removedNames = new Set(
    metaMembers
      .filter((member) => Boolean(member.removedAt))
      .map((member) => member.name?.trim().toLowerCase() ?? '')
      .filter((name) => name.length > 0)
  );
  if (removedNames.size === 0) {
    return snapshot;
  }

  const isRemoved = (name: string | undefined): boolean => {
    const normalized = name?.trim().toLowerCase() ?? '';
    return normalized.length > 0 && removedNames.has(normalized);
  };
  const expectedMembers = persistedLaunchMemberNames.filter((name) => !isRemoved(name));
  const members: Record<string, PersistedTeamLaunchMemberState> = {};
  for (const [memberName, member] of Object.entries(snapshot.members)) {
    if (isRemoved(memberName) || isRemoved(member.name)) {
      continue;
    }
    members[memberName] = { ...member };
  }

  return createPersistedLaunchSnapshot({
    teamName: snapshot.teamName,
    expectedMembers,
    bootstrapExpectedMembers: snapshot.bootstrapExpectedMembers?.filter((name) => !isRemoved(name)),
    leadSessionId: snapshot.leadSessionId,
    launchPhase: snapshot.launchPhase,
    members,
    updatedAt: snapshot.updatedAt,
  });
}

export function findEffectiveRunMemberModel(
  run: EffectiveRunMemberSource | null,
  memberName: string
): string | undefined {
  const member = findEffectiveRunMember(run, memberName);
  const model = member?.model?.trim();
  return model || undefined;
}

export function findEffectiveRunMember(
  run: EffectiveRunMemberSource | null,
  memberName: string
): TeamCreateRequest['members'][number] | undefined {
  if (!run) {
    return undefined;
  }
  for (const member of [...(run.allEffectiveMembers ?? []), ...(run.effectiveMembers ?? [])]) {
    const candidateName = member.name?.trim() ?? '';
    if (
      !candidateName ||
      (!matchesExactTeamMemberName(candidateName, memberName) &&
        !matchesTeamMemberIdentity(candidateName, memberName))
    ) {
      continue;
    }
    return member;
  }
  return undefined;
}

export function findTrackedMemberSpawnStatus(
  run: EffectiveRunMemberSource | null,
  memberName: string
): MemberSpawnStatusEntry | undefined {
  if (!run) {
    return undefined;
  }
  const statusMap = run.memberSpawnStatuses instanceof Map ? run.memberSpawnStatuses : undefined;
  if (!statusMap) {
    return undefined;
  }
  const direct = statusMap.get(memberName);
  if (direct) {
    return direct;
  }
  for (const [candidateName, entry] of statusMap.entries()) {
    if (
      matchesExactTeamMemberName(candidateName, memberName) ||
      matchesTeamMemberIdentity(candidateName, memberName)
    ) {
      return entry;
    }
  }
  return undefined;
}

export function buildLaunchMemberSpawnStatus(
  member: PersistedTeamLaunchMemberState | undefined,
  runtimeModel?: string
): MemberSpawnStatusEntry | undefined {
  if (!member) {
    return undefined;
  }
  return {
    status: member.hardFailure
      ? 'error'
      : member.bootstrapConfirmed || member.launchState === 'confirmed_alive'
        ? 'online'
        : member.agentToolAccepted
          ? 'waiting'
          : 'spawning',
    launchState: member.launchState,
    ...(member.hardFailureReason ? { hardFailureReason: member.hardFailureReason } : {}),
    ...(member.pendingPermissionRequestIds?.length
      ? { pendingPermissionRequestIds: member.pendingPermissionRequestIds }
      : {}),
    agentToolAccepted: member.agentToolAccepted,
    runtimeAlive: member.runtimeAlive,
    bootstrapConfirmed: member.bootstrapConfirmed,
    hardFailure: member.hardFailure,
    ...(runtimeModel ? { runtimeModel } : {}),
    ...(member.livenessKind ? { livenessKind: member.livenessKind } : {}),
    ...(member.runtimeDiagnostic ? { runtimeDiagnostic: member.runtimeDiagnostic } : {}),
    ...(member.runtimeDiagnosticSeverity
      ? { runtimeDiagnosticSeverity: member.runtimeDiagnosticSeverity }
      : {}),
    ...(member.bootstrapStalled ? { bootstrapStalled: true } : {}),
    ...(member.firstSpawnAcceptedAt ? { firstSpawnAcceptedAt: member.firstSpawnAcceptedAt } : {}),
    ...(member.lastHeartbeatAt ? { lastHeartbeatAt: member.lastHeartbeatAt } : {}),
    updatedAt: member.lastEvaluatedAt,
  };
}

export function shouldPreferCurrentLaunchMemberStatus(
  trackedStatus: MemberSpawnStatusEntry | undefined,
  launchStatus: MemberSpawnStatusEntry | undefined
): boolean {
  if (!launchStatus?.bootstrapConfirmed && launchStatus?.launchState !== 'confirmed_alive') {
    return false;
  }
  if (!trackedStatus) {
    return true;
  }
  return (
    trackedStatus.hardFailure !== true &&
    trackedStatus.launchState !== 'failed_to_start' &&
    trackedStatus.launchState !== 'runtime_pending_permission'
  );
}

export function isLaunchMemberStatusRelevantToRuntimeRun(
  member: PersistedTeamLaunchMemberState | undefined,
  activeRuntimeRunId: string
): boolean {
  if (!member || activeRuntimeRunId.length === 0) {
    return false;
  }
  const memberRuntimeRunId = member.runtimeRunId?.trim() ?? '';
  if (member.providerId === 'opencode') {
    return memberRuntimeRunId.length > 0 && memberRuntimeRunId === activeRuntimeRunId;
  }
  return memberRuntimeRunId.length === 0 || memberRuntimeRunId === activeRuntimeRunId;
}

export function getFailedSpawnMembersFromStatuses(
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry> | undefined
): FailedSpawnMember[] {
  const statuses = memberSpawnStatuses ?? new Map<string, MemberSpawnStatusEntry>();
  return [...statuses.entries()]
    .filter(([, entry]) => entry.launchState === 'failed_to_start')
    .map(([name, entry]) => ({
      name,
      error: entry.hardFailureReason ?? entry.error,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function projectPendingRestartStatusForSnapshot(
  memberName: string,
  current: MemberSpawnStatusEntry,
  pendingMemberRestarts: Map<string, PendingMemberRestartProjection> | undefined
): MemberSpawnStatusEntry {
  const pendingRestart = pendingMemberRestarts?.get(memberName);
  if (!pendingRestart) {
    return current;
  }
  if (
    current.launchState === 'confirmed_alive' ||
    current.launchState === 'failed_to_start' ||
    current.launchState === 'skipped_for_launch' ||
    current.skippedForLaunch === true
  ) {
    return current;
  }

  // Manual restarts requested after launch completion must not be persisted as
  // old `starting` entries, because launch-state evaluation treats those as
  // never-spawned failures.
  const updatedAt = current.updatedAt ?? pendingRestart.requestedAt;
  const next: MemberSpawnStatusEntry = {
    ...current,
    status: 'waiting',
    updatedAt,
    skippedForLaunch: false,
    skipReason: undefined,
    skippedAt: undefined,
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    hardFailureReason: undefined,
    error: undefined,
    livenessSource: undefined,
    bootstrapStalled: undefined,
    runtimeDiagnostic:
      current.runtimeDiagnostic ??
      'Manual restart is already in progress; waiting for teammate bootstrap.',
    runtimeDiagnosticSeverity: current.runtimeDiagnosticSeverity ?? 'info',
    firstSpawnAcceptedAt: current.firstSpawnAcceptedAt ?? pendingRestart.requestedAt,
  };
  next.launchState = deriveMemberLaunchState(next);
  return next;
}

export function buildRuntimeSpawnStatusRecord(
  source: RuntimeSpawnStatusProjectionSource
): Record<string, MemberSpawnStatusEntry> {
  const statuses: Record<string, MemberSpawnStatusEntry> = {};
  for (const expected of source.expectedMembers) {
    const current =
      source.memberSpawnStatuses.get(expected) ?? createInitialMemberSpawnStatusEntry();
    statuses[expected] = projectPendingRestartStatusForSnapshot(
      expected,
      current,
      source.pendingMemberRestarts
    );
  }
  return statuses;
}
