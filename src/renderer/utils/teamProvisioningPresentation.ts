import {
  DISPLAY_COMPLETE_STEP_INDEX,
  getDisplayStepIndex,
  getLaunchJoinMilestonesFromMembers,
  getLaunchJoinState,
} from '@renderer/components/team/provisioningSteps';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  ResolvedTeamMember,
  TeamProvisioningProgress,
} from '@shared/types';

type MemberSpawnStatusCollection =
  | Record<string, MemberSpawnStatusEntry>
  | Map<string, MemberSpawnStatusEntry>
  | undefined;

const ACTIVE_PROVISIONING_STATES = new Set([
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
]);

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
  members: readonly ResolvedTeamMember[];
  memberSpawnStatuses?: MemberSpawnStatusCollection;
  memberSpawnSnapshot?: Pick<MemberSpawnStatusesSnapshot, 'expectedMembers' | 'summary'>;
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
      panelMessage: progress.error ?? null,
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
    const readyCompactDetail =
      failedSpawnCount > 0
        ? `${failedSpawnCount} teammate${failedSpawnCount === 1 ? '' : 's'} failed to start`
        : hasMembersStillJoining
          ? joiningPhrase
          : expectedTeammateCount === 0
            ? 'Lead online'
            : `All ${expectedTeammateCount} teammates joined`;
    const readyDetailMessage =
      failedSpawnCount > 0
        ? progress.message
        : expectedTeammateCount === 0
          ? 'Team provisioned - lead online'
          : allTeammatesConfirmedAlive
            ? `Team provisioned - all ${expectedTeammateCount} teammates joined`
            : hasMembersStillJoining
              ? joiningPhrase
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
      currentStepIndex: hasMembersStillJoining ? 2 : DISPLAY_COMPLETE_STEP_INDEX,
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
    };
  }

  if (isActive) {
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
      panelMessage: progress.message,
      panelMessageSeverity: progress.messageSeverity,
      defaultLiveOutputOpen: true,
      compactTitle: 'Launching team',
      compactDetail:
        expectedTeammateCount > 0 && progressStepIndex >= 2
          ? `${heartbeatConfirmedCount}/${expectedTeammateCount} teammates confirmed`
          : progress.message,
      compactTone: 'default',
    };
  }

  return null;
}
