import { isMixedOpenCodeSideLanePlan, planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import { isNativeBootstrapControlText } from '@shared/utils/teamInternalControlMessages';
import {
  hasBootstrapConfirmationProofForLaunchFailure,
  hasUnsafeProvisionedButNotAliveRuntimeEvidence,
  isProvisionedButNotAliveLaunchFailure,
} from '@shared/utils/teamLaunchFailureReason';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { isBootstrapMemberEvidenceCurrentForMember } from './provisioning/TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { shouldIgnoreTerminalBootstrapOnlyPendingSnapshot } from './TeamBootstrapStateReader';
import {
  deriveTeamLaunchAggregateState,
  hasMixedPersistedLaunchMetadata,
  summarizePersistedLaunchMembers,
} from './TeamLaunchStateEvaluator';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  PersistedTeamLaunchSummary,
  TeamProviderId,
  TeamSummary,
} from '@shared/types';

export const TEAM_LAUNCH_SUMMARY_FILE = 'launch-summary.json';
const STALE_PENDING_SUMMARY_GRACE_MS = 5 * 60 * 1000;

export interface LaunchStateSummary {
  partialLaunchFailure?: true;
  expectedMemberCount?: number;
  confirmedMemberCount?: number;
  missingMembers?: string[];
  skippedMembers?: string[];
  teamLaunchState?: TeamSummary['teamLaunchState'];
  launchUpdatedAt?: string;
  confirmedCount?: number;
  pendingCount?: number;
  failedCount?: number;
  skippedCount?: number;
  runtimeAlivePendingCount?: number;
  shellOnlyPendingCount?: number;
  runtimeProcessPendingCount?: number;
  runtimeCandidatePendingCount?: number;
  noRuntimePendingCount?: number;
  permissionPendingCount?: number;
}

export interface PersistedTeamLaunchSummaryProjection extends LaunchStateSummary {
  version: 1;
  teamName: string;
  updatedAt: string;
  launchPhase?: PersistedTeamLaunchSnapshot['launchPhase'];
  mixedAware?: true;
}

function getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[] {
  return Array.from(new Set([...snapshot.expectedMembers, ...Object.keys(snapshot.members)]));
}

function hasBootstrapConfirmationProof(
  member: PersistedTeamLaunchMemberState,
  bootstrapMember: PersistedTeamLaunchMemberState | undefined
): boolean {
  if (hasBootstrapConfirmationProofForLaunchFailure(member)) {
    return true;
  }
  return (
    bootstrapMember != null &&
    hasBootstrapConfirmationProofForLaunchFailure(bootstrapMember) &&
    isBootstrapMemberEvidenceCurrentForMember(member, bootstrapMember, 'confirmation')
  );
}

function shouldProjectProvisionedButNotAliveAsConfirmed(params: {
  member: PersistedTeamLaunchMemberState | undefined;
  bootstrapMember?: PersistedTeamLaunchMemberState;
}): params is { member: PersistedTeamLaunchMemberState } {
  const member = params.member;
  if (member?.launchState !== 'failed_to_start' || member.hardFailure !== true) {
    return false;
  }
  if (
    hasUnsafeProvisionedButNotAliveRuntimeEvidence(member) ||
    hasUnsafeProvisionedButNotAliveRuntimeEvidence(params.bootstrapMember)
  ) {
    return false;
  }
  return (
    isProvisionedButNotAliveLaunchFailure(member) &&
    hasBootstrapConfirmationProof(member, params.bootstrapMember)
  );
}

function shouldProjectNativeBootstrapControlAsConfirmed(params: {
  member: PersistedTeamLaunchMemberState | undefined;
  bootstrapMember?: PersistedTeamLaunchMemberState;
}): params is { member: PersistedTeamLaunchMemberState } {
  const member = params.member;
  if (member?.launchState !== 'failed_to_start' || member.hardFailure !== true) {
    return false;
  }
  if (
    hasUnsafeProvisionedButNotAliveRuntimeEvidence(member) ||
    hasUnsafeProvisionedButNotAliveRuntimeEvidence(params.bootstrapMember)
  ) {
    return false;
  }
  const reason = member.hardFailureReason ?? member.runtimeDiagnostic;
  return (
    isNativeBootstrapControlText(reason) &&
    hasBootstrapConfirmationProof(member, params.bootstrapMember)
  );
}

function buildProjectedMembersForSummary(
  snapshot: PersistedTeamLaunchSnapshot,
  bootstrapSnapshot?: PersistedTeamLaunchSnapshot | null
): Record<string, PersistedTeamLaunchMemberState> | null {
  let changed = false;
  const projectedMembers: Record<string, PersistedTeamLaunchMemberState> = {};
  for (const [memberName, member] of Object.entries(snapshot.members)) {
    if (
      shouldProjectProvisionedButNotAliveAsConfirmed({
        member,
        bootstrapMember: bootstrapSnapshot?.members[memberName],
      }) ||
      shouldProjectNativeBootstrapControlAsConfirmed({
        member,
        bootstrapMember: bootstrapSnapshot?.members[memberName],
      })
    ) {
      changed = true;
      projectedMembers[memberName] = {
        ...member,
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        hardFailureReason: undefined,
        runtimeDiagnostic: undefined,
        runtimeDiagnosticSeverity: undefined,
      };
      continue;
    }
    projectedMembers[memberName] = member;
  }
  return changed ? projectedMembers : null;
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toMillis(value: string | undefined | null): number {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

export function createLaunchStateSummary(
  snapshot: PersistedTeamLaunchSnapshot,
  options: { bootstrapSnapshot?: PersistedTeamLaunchSnapshot | null } = {}
): LaunchStateSummary {
  const persistedMemberNames = getPersistedLaunchMemberNames(snapshot);
  const projectedMembers = buildProjectedMembersForSummary(snapshot, options.bootstrapSnapshot);
  const members = projectedMembers ?? snapshot.members;
  const summary = projectedMembers
    ? summarizePersistedLaunchMembers(snapshot.expectedMembers, projectedMembers)
    : snapshot.summary;
  const teamLaunchState = projectedMembers
    ? deriveTeamLaunchAggregateState(summary)
    : snapshot.teamLaunchState;
  const missingMembers = persistedMemberNames.filter((name) => {
    const member = members[name];
    return member?.launchState === 'failed_to_start';
  });
  const skippedMembers = persistedMemberNames.filter((name) => {
    const member = members[name];
    return member?.launchState === 'skipped_for_launch' || member?.skippedForLaunch === true;
  });

  return {
    ...(teamLaunchState === 'partial_failure' ? { partialLaunchFailure: true as const } : {}),
    ...(persistedMemberNames.length > 0
      ? { expectedMemberCount: persistedMemberNames.length }
      : {}),
    ...(summary.confirmedCount > 0 ? { confirmedMemberCount: summary.confirmedCount } : {}),
    ...(missingMembers.length > 0 ? { missingMembers } : {}),
    ...(skippedMembers.length > 0 ? { skippedMembers } : {}),
    teamLaunchState,
    launchUpdatedAt: snapshot.updatedAt,
    confirmedCount: summary.confirmedCount,
    pendingCount: summary.pendingCount,
    failedCount: summary.failedCount,
    skippedCount: summary.skippedCount,
    runtimeAlivePendingCount: summary.runtimeAlivePendingCount,
    shellOnlyPendingCount: summary.shellOnlyPendingCount,
    runtimeProcessPendingCount: summary.runtimeProcessPendingCount,
    runtimeCandidatePendingCount: summary.runtimeCandidatePendingCount,
    noRuntimePendingCount: summary.noRuntimePendingCount,
    permissionPendingCount: summary.permissionPendingCount,
  };
}

export function createPersistedLaunchSummaryProjection(
  snapshot: PersistedTeamLaunchSnapshot
): PersistedTeamLaunchSummaryProjection {
  return {
    version: 1,
    teamName: snapshot.teamName,
    updatedAt: snapshot.updatedAt,
    launchPhase: snapshot.launchPhase,
    ...(hasMixedPersistedLaunchMetadata(snapshot) ? { mixedAware: true as const } : {}),
    ...createLaunchStateSummary(snapshot),
  };
}

export function normalizePersistedLaunchSummaryProjection(
  teamName: string,
  value: unknown
): PersistedTeamLaunchSummaryProjection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  const updatedAt = normalizeIsoDate(record.updatedAt);
  if (!updatedAt) {
    return null;
  }

  const normalized: PersistedTeamLaunchSummaryProjection = {
    version: 1,
    teamName,
    updatedAt,
    ...(record.mixedAware === true ? { mixedAware: true as const } : {}),
  };
  if (
    record.launchPhase === 'active' ||
    record.launchPhase === 'finished' ||
    record.launchPhase === 'reconciled'
  ) {
    normalized.launchPhase = record.launchPhase;
  }

  if (record.partialLaunchFailure === true) {
    normalized.partialLaunchFailure = true;
  }
  if (typeof record.expectedMemberCount === 'number' && record.expectedMemberCount >= 0) {
    normalized.expectedMemberCount = record.expectedMemberCount;
  }
  if (typeof record.confirmedMemberCount === 'number' && record.confirmedMemberCount >= 0) {
    normalized.confirmedMemberCount = record.confirmedMemberCount;
  }
  if (Array.isArray(record.missingMembers)) {
    const missingMembers = record.missingMembers.filter(
      (member): member is string => typeof member === 'string' && member.trim().length > 0
    );
    if (missingMembers.length > 0) {
      normalized.missingMembers = missingMembers;
    }
  }
  if (Array.isArray(record.skippedMembers)) {
    const skippedMembers = record.skippedMembers.filter(
      (member): member is string => typeof member === 'string' && member.trim().length > 0
    );
    if (skippedMembers.length > 0) {
      normalized.skippedMembers = skippedMembers;
    }
  }
  if (
    record.teamLaunchState === 'partial_failure' ||
    record.teamLaunchState === 'partial_skipped' ||
    record.teamLaunchState === 'partial_pending' ||
    record.teamLaunchState === 'clean_success'
  ) {
    normalized.teamLaunchState = record.teamLaunchState;
  }
  if (typeof record.confirmedCount === 'number' && record.confirmedCount >= 0) {
    normalized.confirmedCount = record.confirmedCount;
  }
  if (typeof record.pendingCount === 'number' && record.pendingCount >= 0) {
    normalized.pendingCount = record.pendingCount;
  }
  if (typeof record.failedCount === 'number' && record.failedCount >= 0) {
    normalized.failedCount = record.failedCount;
  }
  if (typeof record.skippedCount === 'number' && record.skippedCount >= 0) {
    normalized.skippedCount = record.skippedCount;
  }
  if (typeof record.runtimeAlivePendingCount === 'number' && record.runtimeAlivePendingCount >= 0) {
    normalized.runtimeAlivePendingCount = record.runtimeAlivePendingCount;
  }
  if (typeof record.shellOnlyPendingCount === 'number' && record.shellOnlyPendingCount >= 0) {
    normalized.shellOnlyPendingCount = record.shellOnlyPendingCount;
  }
  if (
    typeof record.runtimeProcessPendingCount === 'number' &&
    record.runtimeProcessPendingCount >= 0
  ) {
    normalized.runtimeProcessPendingCount = record.runtimeProcessPendingCount;
  }
  if (
    typeof record.runtimeCandidatePendingCount === 'number' &&
    record.runtimeCandidatePendingCount >= 0
  ) {
    normalized.runtimeCandidatePendingCount = record.runtimeCandidatePendingCount;
  }
  if (typeof record.noRuntimePendingCount === 'number' && record.noRuntimePendingCount >= 0) {
    normalized.noRuntimePendingCount = record.noRuntimePendingCount;
  }
  if (typeof record.permissionPendingCount === 'number' && record.permissionPendingCount >= 0) {
    normalized.permissionPendingCount = record.permissionPendingCount;
  }
  normalized.launchUpdatedAt = updatedAt;
  return normalized;
}

function shouldIgnoreStalePendingSummaryProjection(
  projection: PersistedTeamLaunchSummaryProjection,
  nowMs: number = Date.now()
): boolean {
  if (projection.teamLaunchState !== 'partial_pending') {
    return false;
  }
  if ((projection.permissionPendingCount ?? 0) > 0) {
    return false;
  }

  const updatedAtMs = toMillis(projection.launchUpdatedAt ?? projection.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= STALE_PENDING_SUMMARY_GRACE_MS;
}

function shouldIgnoreStalePendingLaunchSnapshotSummary(
  snapshot: PersistedTeamLaunchSnapshot,
  nowMs: number = Date.now()
): boolean {
  if (snapshot.teamLaunchState !== 'partial_pending') {
    return false;
  }
  if ((snapshot.summary.permissionPendingCount ?? 0) > 0) {
    return false;
  }

  const updatedAtMs = toMillis(snapshot.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= STALE_PENDING_SUMMARY_GRACE_MS;
}

function reconcileSummaryProjectionWithBootstrap(
  projection: PersistedTeamLaunchSummaryProjection,
  bootstrapSnapshot: PersistedTeamLaunchSnapshot
): PersistedTeamLaunchSummaryProjection {
  const missingMembers = projection.missingMembers ?? [];
  if (missingMembers.length === 0) {
    return projection;
  }

  const projectionBoundary = projection.launchUpdatedAt ?? projection.updatedAt;
  const healedMembers = missingMembers.filter((memberName) => {
    const bootstrapMember = bootstrapSnapshot.members[memberName];
    return (
      bootstrapMember != null &&
      hasBootstrapConfirmationProofForLaunchFailure(bootstrapMember) &&
      !hasUnsafeProvisionedButNotAliveRuntimeEvidence(bootstrapMember) &&
      isBootstrapMemberEvidenceCurrentForMember(
        { firstSpawnAcceptedAt: projectionBoundary, lastEvaluatedAt: projectionBoundary },
        bootstrapMember,
        'confirmation'
      )
    );
  });
  if (healedMembers.length === 0) {
    return projection;
  }

  const healedMemberNames = new Set(healedMembers);
  const nextMissingMembers = missingMembers.filter(
    (memberName) => !healedMemberNames.has(memberName)
  );
  const summary: PersistedTeamLaunchSummary = {
    confirmedCount:
      (projection.confirmedCount ?? projection.confirmedMemberCount ?? 0) + healedMembers.length,
    pendingCount: projection.pendingCount ?? 0,
    failedCount: Math.max(
      0,
      (projection.failedCount ?? missingMembers.length) - healedMembers.length
    ),
    skippedCount: projection.skippedCount ?? projection.skippedMembers?.length ?? 0,
    runtimeAlivePendingCount: projection.runtimeAlivePendingCount ?? 0,
    shellOnlyPendingCount: projection.shellOnlyPendingCount,
    runtimeProcessPendingCount: projection.runtimeProcessPendingCount,
    runtimeCandidatePendingCount: projection.runtimeCandidatePendingCount,
    noRuntimePendingCount: projection.noRuntimePendingCount,
    permissionPendingCount: projection.permissionPendingCount,
  };
  const teamLaunchState = deriveTeamLaunchAggregateState(summary);

  const reconciled: PersistedTeamLaunchSummaryProjection = {
    ...projection,
    teamLaunchState,
    confirmedMemberCount: summary.confirmedCount,
    confirmedCount: summary.confirmedCount,
    pendingCount: summary.pendingCount,
    failedCount: summary.failedCount,
    skippedCount: summary.skippedCount,
    runtimeAlivePendingCount: summary.runtimeAlivePendingCount,
    shellOnlyPendingCount: summary.shellOnlyPendingCount,
    runtimeProcessPendingCount: summary.runtimeProcessPendingCount,
    runtimeCandidatePendingCount: summary.runtimeCandidatePendingCount,
    noRuntimePendingCount: summary.noRuntimePendingCount,
    permissionPendingCount: summary.permissionPendingCount,
  };
  if (nextMissingMembers.length > 0) {
    reconciled.missingMembers = nextMissingMembers;
  } else {
    delete reconciled.missingMembers;
  }
  if (teamLaunchState === 'partial_failure') {
    reconciled.partialLaunchFailure = true;
  } else {
    delete reconciled.partialLaunchFailure;
  }
  return reconciled;
}

export function choosePreferredLaunchStateSummary(params: {
  bootstrapSnapshot?: PersistedTeamLaunchSnapshot | null;
  launchSnapshot?: PersistedTeamLaunchSnapshot | null;
  launchSummaryProjection?: PersistedTeamLaunchSummaryProjection | null;
}): LaunchStateSummary | null {
  const launchSnapshot =
    params.launchSnapshot && shouldIgnoreStalePendingLaunchSnapshotSummary(params.launchSnapshot)
      ? null
      : (params.launchSnapshot ?? null);
  if (launchSnapshot) {
    return createLaunchStateSummary(launchSnapshot, {
      bootstrapSnapshot: params.bootstrapSnapshot ?? null,
    });
  }

  const bootstrapSnapshot = params.bootstrapSnapshot ?? null;
  const projection =
    params.launchSummaryProjection &&
    shouldIgnoreStalePendingSummaryProjection(params.launchSummaryProjection)
      ? null
      : (params.launchSummaryProjection ?? null);
  if (!bootstrapSnapshot) {
    return projection;
  }
  if (!projection && shouldIgnoreTerminalBootstrapOnlyPendingSnapshot(bootstrapSnapshot)) {
    return null;
  }
  if (!projection) {
    return createLaunchStateSummary(bootstrapSnapshot);
  }

  const reconciledProjection = reconcileSummaryProjectionWithBootstrap(
    projection,
    bootstrapSnapshot
  );
  const bootstrapMixedAware = hasMixedPersistedLaunchMetadata(bootstrapSnapshot);
  const projectionMixedAware = reconciledProjection.mixedAware === true;
  if (projectionMixedAware !== bootstrapMixedAware) {
    return projectionMixedAware
      ? reconciledProjection
      : createLaunchStateSummary(bootstrapSnapshot);
  }

  const projectionUpdatedAtMs = toMillis(reconciledProjection.updatedAt);
  const bootstrapUpdatedAtMs = toMillis(bootstrapSnapshot.updatedAt);
  if (!Number.isFinite(bootstrapUpdatedAtMs)) {
    return reconciledProjection;
  }
  if (!Number.isFinite(projectionUpdatedAtMs)) {
    return createLaunchStateSummary(bootstrapSnapshot);
  }
  return projectionUpdatedAtMs >= bootstrapUpdatedAtMs
    ? reconciledProjection
    : createLaunchStateSummary(bootstrapSnapshot);
}

export function shouldSuppressLegacyLaunchArtifactHeuristic(params: {
  leadProviderId?: TeamProviderId;
  members: readonly { name: string; providerId?: TeamProviderId; removedAt?: unknown }[];
}): boolean {
  const liveMembers = params.members
    .filter((member) => !member.removedAt)
    .map((member) => ({
      name: member.name.trim(),
      providerId: normalizeOptionalTeamProviderId(member.providerId),
    }))
    .filter((member) => member.name.length > 0);

  if (liveMembers.length === 0) {
    return false;
  }

  const normalizedLeadProviderId = normalizeOptionalTeamProviderId(params.leadProviderId);
  const hasOpenCodeProvider =
    normalizedLeadProviderId === 'opencode' ||
    liveMembers.some((member) => member.providerId === 'opencode');
  const hasNonOpenCodeProvider =
    (normalizedLeadProviderId != null && normalizedLeadProviderId !== 'opencode') ||
    liveMembers.some((member) => member.providerId != null && member.providerId !== 'opencode');
  if (hasOpenCodeProvider && hasNonOpenCodeProvider) {
    return true;
  }

  const plan = planTeamRuntimeLanes({
    leadProviderId: normalizedLeadProviderId,
    members: liveMembers,
  });

  return plan.ok && isMixedOpenCodeSideLanePlan(plan.plan);
}
