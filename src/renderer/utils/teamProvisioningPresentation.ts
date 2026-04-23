import {
  DISPLAY_COMPLETE_STEP_INDEX,
  getDisplayStepIndex,
  getLaunchJoinMilestonesFromMembers,
  getLaunchJoinState,
} from '@renderer/components/team/provisioningSteps';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamProvisioningProgress,
} from '@shared/types';

type MemberSpawnStatusCollection =
  | Record<string, MemberSpawnStatusEntry>
  | Map<string, MemberSpawnStatusEntry>
  | undefined;

interface ProvisioningMemberLike {
  name: string;
  removedAt?: number;
  agentType?: string;
  status?: string;
  currentTaskId?: string | null;
  taskCount?: number;
  lastActiveAt?: string | null;
  messageCount?: number;
}

interface FailedSpawnDetail {
  name: string;
  reason: string | null;
}

function parseStatusUpdatedAtMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFailedSpawnEntry(entry: MemberSpawnStatusEntry | undefined): boolean {
  return entry?.launchState === 'failed_to_start' || entry?.status === 'error';
}

function shouldPreferSnapshotEntryOverLive(params: {
  liveEntry: MemberSpawnStatusEntry | undefined;
  snapshotEntry: MemberSpawnStatusEntry | undefined;
  snapshotUpdatedAt?: string;
}): boolean {
  const { liveEntry, snapshotEntry, snapshotUpdatedAt } = params;
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

function getPreferredSpawnEntry(params: {
  liveEntry: MemberSpawnStatusEntry | undefined;
  snapshotEntry: MemberSpawnStatusEntry | undefined;
  snapshotUpdatedAt?: string;
}): MemberSpawnStatusEntry | undefined {
  return shouldPreferSnapshotEntryOverLive(params)
    ? params.snapshotEntry
    : (params.liveEntry ?? params.snapshotEntry);
}

function countPermissionBlockedMembers(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): number {
  const names = new Set<string>();
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else if (params.memberSpawnStatuses) {
    for (const name of Object.keys(params.memberSpawnStatuses)) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshotStatuses ?? {})) {
    names.add(name);
  }

  let count = 0;
  for (const name of names) {
    const liveEntry =
      params.memberSpawnStatuses instanceof Map
        ? params.memberSpawnStatuses.get(name)
        : params.memberSpawnStatuses?.[name];
    const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
    const entry = getPreferredSpawnEntry({
      liveEntry,
      snapshotEntry,
      snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
    });
    if (!entry) {
      continue;
    }
    if (
      entry.launchState === 'runtime_pending_permission' ||
      (entry.pendingPermissionRequestIds?.length ?? 0) > 0
    ) {
      count += 1;
    }
  }
  return count;
}

function buildAwaitingPermissionPhrase(count: number): string {
  return count === 1
    ? '1 teammate awaiting permission approval'
    : `${count} teammates awaiting permission approval`;
}

const ACTIVE_PROVISIONING_STATES = new Set([
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
]);

function getFailedSpawnDetails(params: {
  memberSpawnStatuses: MemberSpawnStatusCollection;
  memberSpawnSnapshotStatuses?: MemberSpawnStatusesSnapshot['statuses'];
  memberSpawnSnapshotUpdatedAt?: string;
}): FailedSpawnDetail[] {
  const names = new Set<string>();
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else if (params.memberSpawnStatuses) {
    for (const name of Object.keys(params.memberSpawnStatuses)) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshotStatuses ?? {})) {
    names.add(name);
  }

  if (names.size === 0) {
    return [];
  }

  return [...names]
    .map((name) => {
      const liveEntry =
        params.memberSpawnStatuses instanceof Map
          ? params.memberSpawnStatuses.get(name)
          : params.memberSpawnStatuses?.[name];
      const snapshotEntry = params.memberSpawnSnapshotStatuses?.[name];
      return [
        name,
        getPreferredSpawnEntry({
          liveEntry,
          snapshotEntry,
          snapshotUpdatedAt: params.memberSpawnSnapshotUpdatedAt,
        }),
      ] as const;
    })
    .filter(
      ([, entry]) => entry && (entry.launchState === 'failed_to_start' || entry.status === 'error')
    )
    .map(([name, entry]) => ({
      name,
      reason:
        typeof entry?.hardFailureReason === 'string' && entry.hardFailureReason.trim().length > 0
          ? entry.hardFailureReason.trim()
          : typeof entry?.error === 'string' && entry.error.trim().length > 0
            ? entry.error.trim()
            : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function truncateFailureReason(reason: string, maxLength = 160): string {
  const normalized = reason.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildFailedSpawnPanelMessage(
  failedSpawnDetails: readonly FailedSpawnDetail[]
): string | null {
  if (failedSpawnDetails.length === 0) {
    return null;
  }
  if (failedSpawnDetails.length === 1) {
    const [failed] = failedSpawnDetails;
    return failed.reason
      ? `${failed.name} failed to start - ${truncateFailureReason(failed.reason, 220)}`
      : `${failed.name} failed to start`;
  }
  const listedFailures = failedSpawnDetails
    .slice(0, 2)
    .map((failed) =>
      failed.reason ? `${failed.name} - ${truncateFailureReason(failed.reason, 120)}` : failed.name
    )
    .join('; ');
  const remainingCount = failedSpawnDetails.length - Math.min(failedSpawnDetails.length, 2);
  return `Failed teammates: ${listedFailures}${remainingCount > 0 ? `; +${remainingCount} more` : ''}`;
}

function buildFailedSpawnCompactDetail(
  failedSpawnDetails: readonly FailedSpawnDetail[]
): string | null {
  if (failedSpawnDetails.length === 0) {
    return null;
  }
  if (failedSpawnDetails.length === 1) {
    return `${failedSpawnDetails[0].name} failed to start`;
  }
  return `${failedSpawnDetails.length} teammates failed to start`;
}

function buildGenericFailedSpawnPanelMessage(
  failedSpawnCount: number,
  expectedTeammateCount: number
): string | null {
  if (failedSpawnCount <= 0) {
    return null;
  }
  if (failedSpawnCount === 1) {
    return '1 teammate failed to start';
  }
  return `${failedSpawnCount}/${Math.max(expectedTeammateCount, failedSpawnCount)} teammates failed to start`;
}

export interface TeamProvisioningPresentation {
  progress: TeamProvisioningProgress;
  isActive: boolean;
  isReady: boolean;
  isFailed: boolean;
  canCancel: boolean;
  currentStepIndex: number;
  expectedTeammateCount: number;
  heartbeatConfirmedCount: number;
  processOnlyAliveCount: number;
  pendingSpawnCount: number;
  failedSpawnCount: number;
  allTeammatesConfirmedAlive: boolean;
  hasMembersStillJoining: boolean;
  remainingJoinCount: number;
  panelTitle: string;
  panelMessage?: string | null;
  panelMessageSeverity?: 'error' | 'warning' | 'info';
  panelTone?: 'default' | 'error';
  successMessage?: string | null;
  successMessageSeverity?: 'success' | 'warning' | 'info';
  defaultLiveOutputOpen: boolean;
  compactTitle: string;
  compactDetail?: string | null;
  compactTone: 'default' | 'warning' | 'error' | 'success';
}

export function isProvisioningProgressActive(
  progress: Pick<TeamProvisioningProgress, 'state'> | null | undefined
): boolean {
  return progress != null && ACTIVE_PROVISIONING_STATES.has(progress.state);
}

export function buildTeamProvisioningPresentation({
  progress,
  members,
  memberSpawnStatuses,
  memberSpawnSnapshot,
}: {
  progress: TeamProvisioningProgress | null | undefined;
  members: readonly ProvisioningMemberLike[];
  memberSpawnStatuses?: MemberSpawnStatusCollection;
  memberSpawnSnapshot?: Pick<
    MemberSpawnStatusesSnapshot,
    'expectedMembers' | 'summary' | 'updatedAt'
  > & {
    statuses?: MemberSpawnStatusesSnapshot['statuses'];
  };
}): TeamProvisioningPresentation | null {
  if (!progress) {
    return null;
  }

  if (progress.state === 'cancelled' || progress.state === 'disconnected') {
    return null;
  }

  const isReady = progress.state === 'ready';
  const isFailed = progress.state === 'failed';
  const isActive = isProvisioningProgressActive(progress);
  const canCancel =
    progress.state === 'spawning' ||
    progress.state === 'configuring' ||
    progress.state === 'assembling' ||
    progress.state === 'finalizing' ||
    progress.state === 'verifying';

  const {
    expectedTeammateCount,
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
  } = getLaunchJoinMilestonesFromMembers({
    members,
    memberSpawnStatuses,
    memberSpawnSnapshot,
  });
  const failedSpawnDetails = getFailedSpawnDetails({
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
  });
  const failedSpawnPanelMessage = buildFailedSpawnPanelMessage(failedSpawnDetails);
  const failedSpawnCompactDetail = buildFailedSpawnCompactDetail(failedSpawnDetails);
  const genericFailedSpawnPanelMessage = buildGenericFailedSpawnPanelMessage(
    failedSpawnCount,
    expectedTeammateCount
  );
  const permissionBlockedCount = countPermissionBlockedMembers({
    memberSpawnStatuses,
    memberSpawnSnapshotStatuses: memberSpawnSnapshot?.statuses,
    memberSpawnSnapshotUpdatedAt: memberSpawnSnapshot?.updatedAt,
  });

  const { allTeammatesConfirmedAlive, hasMembersStillJoining, remainingJoinCount } =
    getLaunchJoinState({
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
    });

  const progressStepIndex = getDisplayStepIndex({
    progress,
    expectedTeammateCount,
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
  });

  if (isFailed) {
    return {
      progress,
      isActive: false,
      isReady: false,
      isFailed: true,
      canCancel: false,
      currentStepIndex: progressStepIndex,
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
      allTeammatesConfirmedAlive,
      hasMembersStillJoining,
      remainingJoinCount,
      panelTitle: 'Launch failed',
      panelMessage: progress.error ?? failedSpawnPanelMessage ?? genericFailedSpawnPanelMessage,
      panelTone: 'error',
      defaultLiveOutputOpen: true,
      compactTitle: 'Launch failed',
      compactDetail: progress.message ?? null,
      compactTone: 'error',
    };
  }

  if (isReady) {
    const joiningPhrase =
      remainingJoinCount === 1
        ? '1 teammate still joining'
        : `${remainingJoinCount} teammates still joining`;
    const pendingMembersAwaitApproval =
      failedSpawnCount === 0 &&
      permissionBlockedCount > 0 &&
      permissionBlockedCount === remainingJoinCount;
    const pendingDetailPhrase = pendingMembersAwaitApproval
      ? buildAwaitingPermissionPhrase(permissionBlockedCount)
      : joiningPhrase;
    const readyCompactDetail =
      failedSpawnCount > 0
        ? (failedSpawnCompactDetail ??
          `${failedSpawnCount} teammate${failedSpawnCount === 1 ? '' : 's'} failed to start`)
        : hasMembersStillJoining
          ? pendingDetailPhrase
          : expectedTeammateCount === 0
            ? 'Lead online'
            : `All ${expectedTeammateCount} teammates joined`;
    const readyDetailMessage =
      failedSpawnCount > 0
        ? (failedSpawnPanelMessage ?? genericFailedSpawnPanelMessage ?? progress.message)
        : expectedTeammateCount === 0
          ? 'Team provisioned - lead online'
          : allTeammatesConfirmedAlive
            ? `Team provisioned - all ${expectedTeammateCount} teammates joined`
            : hasMembersStillJoining
              ? pendingDetailPhrase
              : 'Team provisioned - teammates are still joining';
    const readyDetailSeverity =
      failedSpawnCount > 0 ? 'warning' : hasMembersStillJoining ? 'info' : undefined;
    const readyMessage =
      failedSpawnCount > 0
        ? `Launch finished with errors - ${failedSpawnCount}/${Math.max(expectedTeammateCount, failedSpawnCount)} teammates failed to start`
        : expectedTeammateCount === 0
          ? 'Team launched - lead online'
          : allTeammatesConfirmedAlive
            ? `Team launched - all ${expectedTeammateCount} teammates joined`
            : 'Finishing launch';

    return {
      progress,
      isActive: false,
      isReady: true,
      isFailed: false,
      canCancel: false,
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
      allTeammatesConfirmedAlive,
      hasMembersStillJoining,
      remainingJoinCount,
      panelTitle: 'Launch details',
      panelMessage: failedSpawnCount > 0 || hasMembersStillJoining ? readyDetailMessage : null,
      panelMessageSeverity: readyDetailSeverity,
      successMessage: readyMessage,
      successMessageSeverity:
        failedSpawnCount > 0 ? 'warning' : hasMembersStillJoining ? 'info' : 'success',
      defaultLiveOutputOpen: false,
      compactTitle:
        failedSpawnCount > 0
          ? 'Launch finished with errors'
          : hasMembersStillJoining
            ? 'Finishing launch'
            : 'Team launched',
      compactDetail: readyCompactDetail,
      compactTone:
        failedSpawnCount > 0 ? 'warning' : hasMembersStillJoining ? 'default' : 'success',
      currentStepIndex:
        failedSpawnCount > 0 ? 2 : hasMembersStillJoining ? 2 : DISPLAY_COMPLETE_STEP_INDEX,
    };
  }

  if (isActive) {
    const activeJoiningPhrase =
      remainingJoinCount === 1
        ? '1 teammate still joining'
        : `${remainingJoinCount} teammates still joining`;
    const activePendingDetailPhrase =
      failedSpawnCount === 0 &&
      hasMembersStillJoining &&
      permissionBlockedCount > 0 &&
      permissionBlockedCount === remainingJoinCount
        ? buildAwaitingPermissionPhrase(permissionBlockedCount)
        : activeJoiningPhrase;
    return {
      progress,
      isActive: true,
      isReady: false,
      isFailed: false,
      canCancel,
      currentStepIndex: progressStepIndex >= 0 ? progressStepIndex : -1,
      expectedTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
      allTeammatesConfirmedAlive,
      hasMembersStillJoining,
      remainingJoinCount,
      panelTitle: 'Launching team',
      panelMessage:
        failedSpawnCount > 0
          ? (failedSpawnPanelMessage ?? genericFailedSpawnPanelMessage ?? progress.message)
          : hasMembersStillJoining &&
              permissionBlockedCount > 0 &&
              permissionBlockedCount === remainingJoinCount
            ? activePendingDetailPhrase
            : progress.message,
      panelMessageSeverity: failedSpawnCount > 0 ? 'warning' : progress.messageSeverity,
      defaultLiveOutputOpen: false,
      compactTitle: 'Launching team',
      compactDetail:
        failedSpawnCount > 0
          ? (failedSpawnCompactDetail ??
            `${failedSpawnCount} teammate${failedSpawnCount === 1 ? '' : 's'} failed to start`)
          : hasMembersStillJoining && failedSpawnCount === 0 && permissionBlockedCount > 0
            ? permissionBlockedCount === remainingJoinCount
              ? buildAwaitingPermissionPhrase(permissionBlockedCount)
              : `${heartbeatConfirmedCount}/${expectedTeammateCount} teammates confirmed`
            : expectedTeammateCount > 0 && progressStepIndex >= 2
              ? `${heartbeatConfirmedCount}/${expectedTeammateCount} teammates confirmed`
              : progress.message,
      compactTone: failedSpawnCount > 0 ? 'warning' : 'default',
    };
  }

  return null;
}
