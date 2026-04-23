import { isMixedOpenCodeSideLanePlan, planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { shouldIgnoreTerminalBootstrapOnlyPendingSnapshot } from './TeamBootstrapStateReader';
import { hasMixedPersistedLaunchMetadata } from './TeamLaunchStateEvaluator';

import type { PersistedTeamLaunchSnapshot, TeamProviderId, TeamSummary } from '@shared/types';

export const TEAM_LAUNCH_SUMMARY_FILE = 'launch-summary.json';

export interface LaunchStateSummary {
  partialLaunchFailure?: true;
  expectedMemberCount?: number;
  confirmedMemberCount?: number;
  missingMembers?: string[];
  teamLaunchState?: TeamSummary['teamLaunchState'];
  launchUpdatedAt?: string;
  confirmedCount?: number;
  pendingCount?: number;
  failedCount?: number;
  runtimeAlivePendingCount?: number;
}

export interface PersistedTeamLaunchSummaryProjection extends LaunchStateSummary {
  version: 1;
  teamName: string;
  updatedAt: string;
  mixedAware?: true;
}

function getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[] {
  return Array.from(new Set([...snapshot.expectedMembers, ...Object.keys(snapshot.members)]));
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
  snapshot: PersistedTeamLaunchSnapshot
): LaunchStateSummary {
  const persistedMemberNames = getPersistedLaunchMemberNames(snapshot);
  const missingMembers = persistedMemberNames.filter((name) => {
    const member = snapshot.members[name];
    return member?.launchState === 'failed_to_start';
  });

  return {
    ...(snapshot.teamLaunchState === 'partial_failure'
      ? { partialLaunchFailure: true as const }
      : {}),
    ...(persistedMemberNames.length > 0
      ? { expectedMemberCount: persistedMemberNames.length }
      : {}),
    ...(snapshot.summary.confirmedCount > 0
      ? { confirmedMemberCount: snapshot.summary.confirmedCount }
      : {}),
    ...(missingMembers.length > 0 ? { missingMembers } : {}),
    teamLaunchState: snapshot.teamLaunchState,
    launchUpdatedAt: snapshot.updatedAt,
    confirmedCount: snapshot.summary.confirmedCount,
    pendingCount: snapshot.summary.pendingCount,
    failedCount: snapshot.summary.failedCount,
    runtimeAlivePendingCount: snapshot.summary.runtimeAlivePendingCount,
  };
}

export function createPersistedLaunchSummaryProjection(
  snapshot: PersistedTeamLaunchSnapshot
): PersistedTeamLaunchSummaryProjection {
  return {
    version: 1,
    teamName: snapshot.teamName,
    updatedAt: snapshot.updatedAt,
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
  if (
    record.teamLaunchState === 'partial_failure' ||
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
  if (typeof record.runtimeAlivePendingCount === 'number' && record.runtimeAlivePendingCount >= 0) {
    normalized.runtimeAlivePendingCount = record.runtimeAlivePendingCount;
  }
  normalized.launchUpdatedAt = updatedAt;
  return normalized;
}

export function choosePreferredLaunchStateSummary(params: {
  bootstrapSnapshot?: PersistedTeamLaunchSnapshot | null;
  launchSnapshot?: PersistedTeamLaunchSnapshot | null;
  launchSummaryProjection?: PersistedTeamLaunchSummaryProjection | null;
}): LaunchStateSummary | null {
  if (params.launchSnapshot) {
    return createLaunchStateSummary(params.launchSnapshot);
  }

  const bootstrapSnapshot = params.bootstrapSnapshot ?? null;
  const projection = params.launchSummaryProjection ?? null;
  if (!bootstrapSnapshot) {
    return projection;
  }
  if (!projection && shouldIgnoreTerminalBootstrapOnlyPendingSnapshot(bootstrapSnapshot)) {
    return null;
  }
  if (!projection) {
    return createLaunchStateSummary(bootstrapSnapshot);
  }

  const bootstrapMixedAware = hasMixedPersistedLaunchMetadata(bootstrapSnapshot);
  const projectionMixedAware = projection.mixedAware === true;
  if (projectionMixedAware !== bootstrapMixedAware) {
    return projectionMixedAware ? projection : createLaunchStateSummary(bootstrapSnapshot);
  }

  const projectionUpdatedAtMs = toMillis(projection.updatedAt);
  const bootstrapUpdatedAtMs = toMillis(bootstrapSnapshot.updatedAt);
  if (!Number.isFinite(bootstrapUpdatedAtMs)) {
    return projection;
  }
  if (!Number.isFinite(projectionUpdatedAtMs)) {
    return createLaunchStateSummary(bootstrapSnapshot);
  }
  return projectionUpdatedAtMs >= bootstrapUpdatedAtMs
    ? projection
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
