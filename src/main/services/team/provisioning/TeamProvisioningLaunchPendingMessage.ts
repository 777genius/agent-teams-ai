import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';

import type { MemberSpawnStatusEntry, PersistedTeamLaunchSnapshot } from '@shared/types';

export interface PendingLaunchMessageRunLike {
  expectedMembers?: readonly string[];
  memberSpawnStatuses?: ReadonlyMap<string, MemberSpawnStatusEntry>;
  mixedSecondaryLanes?: readonly unknown[];
}

export interface PendingLaunchMessageSummaryLike {
  confirmedCount: number;
  pendingCount: number;
  failedCount?: number;
  runtimeAlivePendingCount: number;
  shellOnlyPendingCount?: number;
  runtimeProcessPendingCount?: number;
  runtimeCandidatePendingCount?: number;
  noRuntimePendingCount?: number;
  permissionPendingCount?: number;
}

export interface BuildPendingBootstrapStatusMessageInput {
  prefix: string;
  run: PendingLaunchMessageRunLike;
  launchSummary: PendingLaunchMessageSummaryLike;
  snapshot?: PersistedTeamLaunchSnapshot | null;
}

export interface BuildAggregatePendingLaunchMessageInput {
  prefix: string;
  run: PendingLaunchMessageRunLike;
  launchSummary: PendingLaunchMessageSummaryLike;
  snapshot?: PersistedTeamLaunchSnapshot | null;
}

export interface HasPendingLaunchMembersInput {
  run: PendingLaunchMessageRunLike;
  launchSummary: Pick<PendingLaunchMessageSummaryLike, 'pendingCount'>;
  snapshot?: PersistedTeamLaunchSnapshot | null;
}

export function countRunPermissionPendingMembers(run: PendingLaunchMessageRunLike): number {
  let count = 0;
  for (const expected of run.expectedMembers ?? []) {
    const entry = run.memberSpawnStatuses?.get(expected) ?? createInitialMemberSpawnStatusEntry();
    if (entry.launchState === 'runtime_pending_permission') {
      count += 1;
    }
  }
  return count;
}

export function countSnapshotPermissionPendingMembers(
  snapshot: PersistedTeamLaunchSnapshot
): number {
  let count = 0;
  for (const memberName of getPersistedLaunchMemberNames(snapshot)) {
    const member = snapshot.members[memberName];
    if (!member) {
      continue;
    }
    if (
      member.launchState === 'runtime_pending_permission' ||
      (member.pendingPermissionRequestIds?.length ?? 0) > 0
    ) {
      count += 1;
    }
  }
  return count;
}

export function hasPendingLaunchMembers({
  run,
  launchSummary,
  snapshot,
}: HasPendingLaunchMembersInput): boolean {
  const expectedCount = snapshot
    ? getPersistedLaunchMemberNames(snapshot).length
    : (run.expectedMembers?.length ?? 0);
  return launchSummary.pendingCount > 0 && expectedCount > 0;
}

export function buildPendingBootstrapStatusMessage({
  prefix,
  run,
  launchSummary,
  snapshot,
}: BuildPendingBootstrapStatusMessageInput): string {
  const expectedTeammateCount = snapshot
    ? getPersistedLaunchMemberNames(snapshot).length
    : (run.expectedMembers?.length ?? 0);
  const permissionPendingCount = snapshot
    ? countSnapshotPermissionPendingMembers(snapshot)
    : countRunPermissionPendingMembers(run);
  if (
    launchSummary.pendingCount > 0 &&
    permissionPendingCount > 0 &&
    permissionPendingCount === launchSummary.pendingCount
  ) {
    return `${prefix} — ${
      permissionPendingCount === 1
        ? '1 teammate awaiting permission approval'
        : `${permissionPendingCount} teammates awaiting permission approval`
    }`;
  }

  const runtimeProcessPendingCount = launchSummary.runtimeProcessPendingCount ?? 0;
  const stillStartingCount = Math.max(0, launchSummary.pendingCount - runtimeProcessPendingCount);
  const diagnosticParts = [
    launchSummary.shellOnlyPendingCount ? `${launchSummary.shellOnlyPendingCount} shell-only` : '',
    launchSummary.runtimeProcessPendingCount
      ? `${launchSummary.runtimeProcessPendingCount} waiting for bootstrap`
      : '',
    launchSummary.runtimeCandidatePendingCount
      ? `${launchSummary.runtimeCandidatePendingCount} bootstrap unconfirmed`
      : '',
    launchSummary.noRuntimePendingCount
      ? `${launchSummary.noRuntimePendingCount} waiting for runtime`
      : '',
  ].filter(Boolean);
  const diagnosticSuffix = diagnosticParts.length > 0 ? ` - ${diagnosticParts.join(', ')}` : '';
  if (launchSummary.confirmedCount === 0) {
    const allRuntimeAlive =
      runtimeProcessPendingCount > 0 && runtimeProcessPendingCount === expectedTeammateCount;
    return allRuntimeAlive
      ? `${prefix} — teammates online`
      : runtimeProcessPendingCount > 0
        ? `${prefix} — ${runtimeProcessPendingCount}/${expectedTeammateCount} teammate${runtimeProcessPendingCount === 1 ? '' : 's'} online${stillStartingCount > 0 ? `, ${stillStartingCount} still starting` : ''}`
        : `${prefix} — teammates are still starting${diagnosticSuffix}`;
  }

  return `${prefix} — ${launchSummary.confirmedCount}/${expectedTeammateCount} teammates made contact${runtimeProcessPendingCount > 0 ? `, ${runtimeProcessPendingCount} teammate${runtimeProcessPendingCount === 1 ? '' : 's'} online` : ''}${stillStartingCount > 0 ? `${runtimeProcessPendingCount > 0 ? ', ' : ', '}${stillStartingCount} still joining${diagnosticSuffix}` : ''}`;
}

export function buildAggregatePendingLaunchMessage({
  prefix,
  run,
  launchSummary,
  snapshot,
}: BuildAggregatePendingLaunchMessageInput): string {
  const mixedSecondaryLanes = run.mixedSecondaryLanes ?? [];
  if (!snapshot || mixedSecondaryLanes.length === 0) {
    return buildPendingBootstrapStatusMessage({ prefix, run, launchSummary, snapshot });
  }

  const persistedMemberNames = getPersistedLaunchMemberNames(snapshot);
  const allPendingMembers = persistedMemberNames
    .filter((memberName) => {
      const member = snapshot.members[memberName];
      if (!member) {
        return false;
      }
      return member.launchState !== 'confirmed_alive' && member.launchState !== 'failed_to_start';
    })
    .filter((memberName) => {
      const member = snapshot.members[memberName];
      return member?.launchState !== 'skipped_for_launch';
    });
  if (
    allPendingMembers.length > 0 &&
    allPendingMembers.every((memberName) => {
      const member = snapshot.members[memberName];
      return (
        member?.launchState === 'runtime_pending_permission' ||
        (member?.pendingPermissionRequestIds?.length ?? 0) > 0
      );
    })
  ) {
    return `${prefix} — ${
      allPendingMembers.length === 1
        ? '1 teammate awaiting permission approval'
        : `${allPendingMembers.length} teammates awaiting permission approval`
    }`;
  }

  const primaryExpectedMembers = new Set(snapshot.bootstrapExpectedMembers ?? run.expectedMembers);
  const secondaryPendingMembers = persistedMemberNames.filter((memberName) => {
    if (primaryExpectedMembers.has(memberName)) {
      return false;
    }
    const member = snapshot.members[memberName];
    if (!member) {
      return true;
    }
    return (
      member.launchState !== 'confirmed_alive' &&
      member.launchState !== 'failed_to_start' &&
      member.launchState !== 'skipped_for_launch'
    );
  });
  if (secondaryPendingMembers.length === 0) {
    return buildPendingBootstrapStatusMessage({ prefix, run, launchSummary });
  }

  return `${prefix} - waiting for secondary runtime lane: ${secondaryPendingMembers.join(', ')}`;
}
