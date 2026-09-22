import { isLeadMember } from '@shared/utils/leadDetection';
import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidence,
  hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
  mentionsProcessTableUnavailable,
} from '@shared/utils/teamLaunchFailureReason';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeEntry,
  TeamProvisioningProgress,
} from '@shared/types';

interface LaunchJoinMemberLike {
  name: string;
  removedAt?: number;
}

/** Display steps for the provisioning stepper (0-indexed). */
export const DISPLAY_STEPS = [
  { key: 'starting', labelKey: 'provisioning.steps.starting' },
  { key: 'configuring', labelKey: 'provisioning.steps.configuring' },
  { key: 'assembling', labelKey: 'provisioning.steps.assembling' },
  { key: 'finalizing', labelKey: 'provisioning.steps.finalizing' },
] as const;

export const DISPLAY_COMPLETE_STEP_INDEX = DISPLAY_STEPS.length;

export interface LaunchJoinMilestones {
  expectedTeammateCount: number;
  heartbeatConfirmedCount: number;
  processOnlyAliveCount: number;
  pendingSpawnCount: number;
  failedSpawnCount: number;
  skippedSpawnCount: number;
}

type DisplayStepMilestones = LaunchJoinMilestones & {
  progress: Pick<TeamProvisioningProgress, 'configReady' | 'pid' | 'state'>;
};

type MemberSpawnStatusCollection =
  | Record<string, MemberSpawnStatusEntry>
  | Map<string, MemberSpawnStatusEntry>
  | undefined;

type TeamAgentRuntimeEntryCollection =
  | Record<string, TeamAgentRuntimeEntry>
  | Map<string, TeamAgentRuntimeEntry>
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

function getRuntimeEntry(
  memberRuntimeEntries: TeamAgentRuntimeEntryCollection,
  memberName: string
): TeamAgentRuntimeEntry | undefined {
  if (!memberRuntimeEntries) {
    return undefined;
  }
  if (memberRuntimeEntries instanceof Map) {
    return memberRuntimeEntries.get(memberName);
  }
  return memberRuntimeEntries[memberName];
}

function parseStatusUpdatedAtMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFailedSpawnEntry(entry: MemberSpawnStatusEntry | undefined): boolean {
  if (isBootstrapConfirmedProvisionedButNotAliveFailure(entry)) {
    return hasUnsafeProvisionedButNotAliveRuntimeEvidence(entry);
  }
  return entry?.launchState === 'failed_to_start' || entry?.status === 'error';
}

function isStrongRuntimeProcessSpawnEntry(entry: MemberSpawnStatusEntry): boolean {
  return (
    entry.runtimeAlive === true &&
    entry.livenessKind === 'runtime_process' &&
    entry.bootstrapStalled !== true
  );
}

function isConfirmedSpawnEntry(entry: MemberSpawnStatusEntry): boolean {
  if (isBootstrapConfirmedProvisionedButNotAliveFailure(entry)) {
    return !isFailedSpawnEntry(entry);
  }
  return entry.launchState === 'confirmed_alive' || entry.bootstrapConfirmed === true;
}

function spawnEntryContradictsConfirmedJoin(entry: MemberSpawnStatusEntry): boolean {
  if (!isConfirmedSpawnEntry(entry) || entry.runtimeAlive !== false) {
    return false;
  }
  if (entry.runtimeDiagnosticSeverity === 'error') {
    return true;
  }
  if (
    entry.livenessKind === 'not_found' ||
    entry.livenessKind === 'shell_only' ||
    entry.livenessKind === 'permission_blocked' ||
    entry.livenessKind === 'runtime_process_candidate'
  ) {
    return true;
  }
  const hasProcessTableUnavailableMarker =
    mentionsProcessTableUnavailable(entry.runtimeDiagnostic) ||
    mentionsProcessTableUnavailable(entry.hardFailureReason) ||
    mentionsProcessTableUnavailable(entry.error);
  if (!entry.livenessKind) {
    return !hasProcessTableUnavailableMarker;
  }
  if (entry.livenessKind !== 'registered_only' && entry.livenessKind !== 'stale_metadata') {
    return false;
  }
  return !hasProcessTableUnavailableMarker;
}

function runtimeEntryContradictsConfirmedJoin(
  entry: MemberSpawnStatusEntry,
  runtimeEntry: TeamAgentRuntimeEntry | undefined
): boolean {
  if (runtimeEntry?.alive !== false || runtimeEntry.livenessKind === 'confirmed_bootstrap') {
    return false;
  }
  if (
    isBootstrapConfirmedProvisionedButNotAliveFailure(entry) &&
    !hasUnsafeProvisionedButNotAliveRuntimeEvidence(entry) &&
    !hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(entry, runtimeEntry) &&
    (runtimeEntry.livenessKind == null ||
      runtimeEntry.livenessKind === 'registered_only' ||
      runtimeEntry.livenessKind === 'stale_metadata') &&
    (mentionsProcessTableUnavailable(runtimeEntry.runtimeDiagnostic) ||
      mentionsProcessTableUnavailable(entry.runtimeDiagnostic) ||
      mentionsProcessTableUnavailable(entry.hardFailureReason) ||
      mentionsProcessTableUnavailable(entry.error))
  ) {
    return false;
  }
  return true;
}

function shouldPreferSnapshotEntryOverLive(
  liveEntry: MemberSpawnStatusEntry | undefined,
  snapshotEntry: MemberSpawnStatusEntry | undefined,
  snapshotUpdatedAt: string | undefined
): boolean {
  if (!liveEntry || !snapshotEntry) {
    return false;
  }
  if (!isFailedSpawnEntry(liveEntry) || isFailedSpawnEntry(snapshotEntry)) {
    return false;
  }

  const liveUpdatedAtMs = parseStatusUpdatedAtMs(liveEntry.updatedAt);
  const snapshotUpdatedAtMs =
    parseStatusUpdatedAtMs(snapshotEntry.updatedAt) ?? parseStatusUpdatedAtMs(snapshotUpdatedAt);
  return (
    snapshotUpdatedAtMs != null &&
    (liveUpdatedAtMs == null || snapshotUpdatedAtMs >= liveUpdatedAtMs)
  );
}

function summarizeLiveLaunchJoinMilestones(params: {
  teammateNames: readonly string[];
  memberSpawnStatuses?: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
  memberRuntimeEntries?: TeamAgentRuntimeEntryCollection;
}): Omit<LaunchJoinMilestones, 'expectedTeammateCount'> & {
  observedTeammateCount: number;
} {
  const {
    teammateNames,
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses,
    memberSpawnSnapshotUpdatedAt,
  } = params;
  let heartbeatConfirmedCount = 0;
  let processOnlyAliveCount = 0;
  let pendingSpawnCount = 0;
  let failedSpawnCount = 0;
  let skippedSpawnCount = 0;
  let observedTeammateCount = 0;

  for (const memberName of teammateNames) {
    const liveEntry = getSpawnEntry(memberSpawnStatuses, memberName);
    const snapshotEntry = memberSpawnSnapshotStatuses?.[memberName];
    const entry = shouldPreferSnapshotEntryOverLive(
      liveEntry,
      snapshotEntry,
      memberSpawnSnapshotUpdatedAt
    )
      ? snapshotEntry
      : liveEntry;
    if (!entry) {
      pendingSpawnCount += 1;
      continue;
    }
    observedTeammateCount += 1;
    if (isFailedSpawnEntry(entry)) {
      failedSpawnCount += 1;
      continue;
    }
    if (entry.launchState === 'skipped_for_launch' || entry.skippedForLaunch === true) {
      skippedSpawnCount += 1;
      continue;
    }
    if (spawnEntryContradictsConfirmedJoin(entry)) {
      pendingSpawnCount += 1;
      continue;
    }
    if (
      isConfirmedSpawnEntry(entry) &&
      runtimeEntryContradictsConfirmedJoin(
        entry,
        getRuntimeEntry(params.memberRuntimeEntries, memberName)
      )
    ) {
      pendingSpawnCount += 1;
      continue;
    }
    if (isConfirmedSpawnEntry(entry)) {
      heartbeatConfirmedCount += 1;
      continue;
    }
    if (entry.launchState === 'runtime_pending_permission') {
      pendingSpawnCount += 1;
      continue;
    }
    if (entry.launchState === 'runtime_pending_bootstrap') {
      if (isStrongRuntimeProcessSpawnEntry(entry)) {
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
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
    skippedSpawnCount,
    observedTeammateCount,
  };
}

export function getLaunchJoinMilestonesFromMembers({
  members,
  memberSpawnStatuses,
  memberSpawnSnapshot,
  memberRuntimeEntries,
}: {
  members: readonly LaunchJoinMemberLike[];
  memberSpawnStatuses?: MemberSpawnStatusCollection;
  memberSpawnSnapshot?: Pick<
    MemberSpawnStatusesSnapshot,
    'expectedMembers' | 'summary' | 'updatedAt'
  > & {
    statuses?: MemberSpawnStatusesSnapshot['statuses'];
  };
  memberRuntimeEntries?: TeamAgentRuntimeEntryCollection;
}): LaunchJoinMilestones {
  const removedTeammateNameSet = new Set(
    members
      .filter((member) => member.removedAt && !isLeadMember(member))
      .map((member) => member.name)
  );
  const teammates = members.filter((member) => !member.removedAt && !isLeadMember(member));
  const activeTeammateNames = teammates.map((member) => member.name);
  const snapshotExpectedNames = memberSpawnSnapshot?.expectedMembers ?? [];
  const snapshotStatusNames = Object.keys(memberSpawnSnapshot?.statuses ?? {});
  const teammateNames =
    snapshotExpectedNames.length > 0 || snapshotStatusNames.length > 0
      ? Array.from(
          new Set([...snapshotExpectedNames, ...snapshotStatusNames, ...activeTeammateNames])
        ).filter(
          (memberName) =>
            memberName.trim().length > 0 &&
            !isLeadMember({ name: memberName }) &&
            !removedTeammateNameSet.has(memberName)
        )
      : activeTeammateNames;
  const expectedTeammateCount = teammateNames.length;
  const snapshotSummary = memberSpawnSnapshot?.summary;
  const liveSummary = summarizeLiveLaunchJoinMilestones({
    teammateNames,
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
    memberRuntimeEntries,
  });

  if (snapshotSummary) {
    const snapshotProcessOnlyAliveCount = snapshotSummary.runtimeProcessPendingCount ?? 0;
    const snapshotMilestones = {
      expectedTeammateCount,
      heartbeatConfirmedCount: snapshotSummary.confirmedCount,
      processOnlyAliveCount: snapshotProcessOnlyAliveCount,
      pendingSpawnCount: Math.max(0, snapshotSummary.pendingCount - snapshotProcessOnlyAliveCount),
      failedSpawnCount: snapshotSummary.failedCount,
      skippedSpawnCount: snapshotSummary.skippedCount ?? 0,
    };

    const snapshotAccountedFor =
      snapshotMilestones.heartbeatConfirmedCount +
      snapshotMilestones.processOnlyAliveCount +
      snapshotMilestones.failedSpawnCount +
      snapshotMilestones.skippedSpawnCount;
    const liveAccountedFor =
      liveSummary.heartbeatConfirmedCount +
      liveSummary.processOnlyAliveCount +
      liveSummary.failedSpawnCount +
      liveSummary.skippedSpawnCount;

    const liveSummaryContradictsCleanSnapshot =
      snapshotMilestones.pendingSpawnCount === 0 &&
      snapshotMilestones.failedSpawnCount === 0 &&
      snapshotMilestones.skippedSpawnCount === 0 &&
      liveSummary.observedTeammateCount > 0 &&
      (liveSummary.pendingSpawnCount > 0 ||
        liveSummary.failedSpawnCount > 0 ||
        liveSummary.skippedSpawnCount > 0);

    const liveSummaryIsMoreAdvanced =
      liveSummary.failedSpawnCount > snapshotMilestones.failedSpawnCount ||
      liveSummary.skippedSpawnCount > snapshotMilestones.skippedSpawnCount ||
      liveSummary.heartbeatConfirmedCount > snapshotMilestones.heartbeatConfirmedCount ||
      liveSummary.processOnlyAliveCount > snapshotMilestones.processOnlyAliveCount ||
      (snapshotMilestones.failedSpawnCount === 0 &&
        liveSummary.observedTeammateCount > 0 &&
        liveSummary.pendingSpawnCount > snapshotMilestones.pendingSpawnCount) ||
      liveAccountedFor > snapshotAccountedFor;

    return liveSummaryIsMoreAdvanced || liveSummaryContradictsCleanSnapshot
      ? {
          expectedTeammateCount,
          ...liveSummary,
        }
      : snapshotMilestones;
  }

  return {
    expectedTeammateCount,
    ...liveSummary,
  };
}

export function getLaunchJoinState({
  expectedTeammateCount,
  heartbeatConfirmedCount,
  processOnlyAliveCount,
  pendingSpawnCount,
  failedSpawnCount,
  skippedSpawnCount,
}: LaunchJoinMilestones): {
  allTeammatesConfirmedAlive: boolean;
  hasMembersStillJoining: boolean;
  remainingJoinCount: number;
} {
  const allTeammatesConfirmedAlive =
    expectedTeammateCount > 0 &&
    failedSpawnCount === 0 &&
    skippedSpawnCount === 0 &&
    heartbeatConfirmedCount >= expectedTeammateCount;
  const remainingJoinCount =
    expectedTeammateCount > 0 && failedSpawnCount === 0 && skippedSpawnCount === 0
      ? Math.max(0, expectedTeammateCount - heartbeatConfirmedCount)
      : 0;
  const hasMembersStillJoining =
    expectedTeammateCount > 0 &&
    failedSpawnCount === 0 &&
    skippedSpawnCount === 0 &&
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
  skippedSpawnCount,
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

  if (failedSpawnCount > 0) {
    return 2;
  }
  if (skippedSpawnCount > 0) {
    return 2;
  }

  const accountedForTeammates =
    heartbeatConfirmedCount + processOnlyAliveCount + failedSpawnCount + skippedSpawnCount;

  if (pendingSpawnCount > 0 || accountedForTeammates < expectedTeammateCount) {
    return 2;
  }

  return 3;
}
