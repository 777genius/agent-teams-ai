import { isLeadMember } from '@shared/utils/leadDetection';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  ResolvedTeamMember,
  TeamProvisioningProgress,
} from '@shared/types';

/** Display steps for the provisioning stepper (0-indexed). */
export const DISPLAY_STEPS = [
  { key: 'starting', label: 'Starting' },
  { key: 'configuring', label: 'Team setup' },
  { key: 'assembling', label: 'Members joining' },
  { key: 'finalizing', label: 'Finalizing' },
] as const;

export const DISPLAY_COMPLETE_STEP_INDEX = DISPLAY_STEPS.length;

export interface LaunchJoinMilestones {
  expectedTeammateCount: number;
  heartbeatConfirmedCount: number;
  processOnlyAliveCount: number;
  pendingSpawnCount: number;
  failedSpawnCount: number;
}

type DisplayStepMilestones = LaunchJoinMilestones & {
  progress: Pick<TeamProvisioningProgress, 'configReady' | 'pid' | 'state'>;
};

type MemberSpawnStatusCollection =
  | Record<string, MemberSpawnStatusEntry>
  | Map<string, MemberSpawnStatusEntry>
  | undefined;

function getSpawnEntry(
  memberSpawnStatuses: MemberSpawnStatusCollection,
  memberName: string
): MemberSpawnStatusEntry | undefined {
  if (!memberSpawnStatuses) {
    return undefined;
  }
  if (memberSpawnStatuses instanceof Map) {
    return memberSpawnStatuses.get(memberName);
  }
  return memberSpawnStatuses[memberName];
}

export function getLaunchJoinMilestonesFromMembers({
  members,
  memberSpawnStatuses,
  memberSpawnSnapshot,
}: {
  members: readonly ResolvedTeamMember[];
  memberSpawnStatuses?: MemberSpawnStatusCollection;
  memberSpawnSnapshot?: Pick<MemberSpawnStatusesSnapshot, 'expectedMembers' | 'summary'>;
}): LaunchJoinMilestones {
  const teammates = members.filter((member) => !member.removedAt && !isLeadMember(member));
  const expectedTeammateCount = memberSpawnSnapshot?.expectedMembers?.length ?? teammates.length;
  const snapshotSummary = memberSpawnSnapshot?.summary;

  if (snapshotSummary) {
    return {
      expectedTeammateCount,
      heartbeatConfirmedCount: snapshotSummary.confirmedCount,
      processOnlyAliveCount: snapshotSummary.runtimeAlivePendingCount,
      pendingSpawnCount: Math.max(
        0,
        snapshotSummary.pendingCount - snapshotSummary.runtimeAlivePendingCount
      ),
      failedSpawnCount: snapshotSummary.failedCount,
    };
  }

  let heartbeatConfirmedCount = 0;
  let processOnlyAliveCount = 0;
  let pendingSpawnCount = 0;
  let failedSpawnCount = 0;

  for (const member of teammates) {
    const entry = getSpawnEntry(memberSpawnStatuses, member.name);
    if (!entry) {
      pendingSpawnCount += 1;
      continue;
    }
    if (entry.launchState === 'failed_to_start') {
      failedSpawnCount += 1;
      continue;
    }
    if (entry.launchState === 'confirmed_alive') {
      heartbeatConfirmedCount += 1;
      continue;
    }
    if (entry.launchState === 'runtime_pending_bootstrap') {
      if (entry.runtimeAlive === true) {
        processOnlyAliveCount += 1;
      } else {
        pendingSpawnCount += 1;
      }
      continue;
    }
    if (entry.launchState === 'starting') {
      pendingSpawnCount += 1;
    }
  }

  return {
    expectedTeammateCount,
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
  };
}

export function getLaunchJoinState({
  expectedTeammateCount,
  heartbeatConfirmedCount,
  processOnlyAliveCount,
  pendingSpawnCount,
  failedSpawnCount,
}: LaunchJoinMilestones): {
  allTeammatesConfirmedAlive: boolean;
  hasMembersStillJoining: boolean;
  remainingJoinCount: number;
} {
  const allTeammatesConfirmedAlive =
    expectedTeammateCount > 0 &&
    failedSpawnCount === 0 &&
    heartbeatConfirmedCount >= expectedTeammateCount;
  const remainingJoinCount =
    expectedTeammateCount > 0 && failedSpawnCount === 0
      ? Math.max(0, expectedTeammateCount - heartbeatConfirmedCount)
      : 0;
  const hasMembersStillJoining =
    expectedTeammateCount > 0 &&
    failedSpawnCount === 0 &&
    remainingJoinCount > 0 &&
    (processOnlyAliveCount > 0 || pendingSpawnCount > 0);

  return {
    allTeammatesConfirmedAlive,
    hasMembersStillJoining,
    remainingJoinCount,
  };
}

/**
 * Maps launch progress to the visible stepper milestone.
 *
 * The renderer intentionally derives these steps from observable launch evidence
 * instead of raw backend phase names. The backend can move through
 * validating/spawning/configuring very quickly, but the UI milestones should
 * reflect what the user can actually observe:
 * - Starting: waiting for a real CLI/runtime process
 * - Team setup: process exists, but config is not readable yet
 * - Members joining: config is ready, but teammate runtimes are still attaching
 * - Finalizing: teammate runtimes are attached and bootstrap/contact is settling
 *
 * Returns DISPLAY_COMPLETE_STEP_INDEX for 'ready', -1 for failed/cancelled.
 */
export function getDisplayStepIndex({
  progress,
  expectedTeammateCount,
  heartbeatConfirmedCount,
  processOnlyAliveCount,
  pendingSpawnCount,
  failedSpawnCount,
}: DisplayStepMilestones): number {
  switch (progress.state) {
    case 'ready':
      return DISPLAY_COMPLETE_STEP_INDEX;
    case 'failed':
    case 'disconnected':
    case 'cancelled':
      return -1;
    default:
      break;
  }

  if (!progress.pid) {
    return 0;
  }

  if (progress.configReady !== true) {
    return 1;
  }

  if (expectedTeammateCount <= 0) {
    return 3;
  }

  const accountedForTeammates = heartbeatConfirmedCount + processOnlyAliveCount + failedSpawnCount;

  if (pendingSpawnCount > 0 || accountedForTeammates < expectedTeammateCount) {
    return 2;
  }

  return 3;
}
