import { peekAutoResumeService } from '../AutoResumeService';

import {
  removeDeterministicBootstrapSpecFile,
  removeDeterministicBootstrapUserPromptFile,
} from './TeamProvisioningBootstrapSpec';

import type { TeamProvisioningProgress } from '@shared/types';
import type { ChildProcess } from 'child_process';

export interface RetainedClaudeLogsSnapshotLike {
  lines: string[];
  updatedAt?: string;
}

interface PostCompactReminderStateRun {
  pendingPostCompactReminder: boolean;
  postCompactReminderInFlight: boolean;
  suppressPostCompactReminderOutput: boolean;
}

interface GeminiPostLaunchHydrationStateRun {
  pendingGeminiPostLaunchHydration: boolean;
  geminiPostLaunchHydrationInFlight: boolean;
  suppressGeminiPostLaunchHydrationOutput: boolean;
}

export function clearPostCompactReminderState(run: PostCompactReminderStateRun): void {
  run.pendingPostCompactReminder = false;
  run.postCompactReminderInFlight = false;
  run.suppressPostCompactReminderOutput = false;
}

export function clearGeminiPostLaunchHydrationState(run: GeminiPostLaunchHydrationStateRun): void {
  run.pendingGeminiPostLaunchHydration = false;
  run.geminiPostLaunchHydrationInFlight = false;
  run.suppressGeminiPostLaunchHydrationOutput = false;
}

export interface TeamProvisioningCleanupRun
  extends PostCompactReminderStateRun, GeminiPostLaunchHydrationStateRun {
  runId: string;
  teamName: string;
  progress: TeamProvisioningProgress;
  isLaunch: boolean;
  launchStateClearedForRun: boolean;
  provisioningComplete: boolean;
  cancelRequested: boolean;
  launchCleanupStateFinalized?: boolean;
  pendingDirectCrossTeamSendRefresh: boolean;
  timeoutHandle: NodeJS.Timeout | null;
  silentUserDmForwardClearHandle: NodeJS.Timeout | null;
  child: ChildProcess | null | undefined;
  memberSpawnStatuses: Map<string, unknown>;
  activeCrossTeamReplyHints: unknown[];
  pendingInboxRelayCandidates: unknown[];
  pendingApprovals: {
    size: number;
    keys(): IterableIterator<string>;
    clear(): void;
  };
  mcpConfigPath: string | null;
  bootstrapSpecPath: string | null;
  bootstrapUserPromptPath: string | null;
}

export interface IncompleteLaunchCleanupRun {
  progress: Pick<TeamProvisioningProgress, 'state' | 'message' | 'error'>;
  isLaunch: boolean;
  launchStateClearedForRun: boolean;
  provisioningComplete: boolean;
  cancelRequested: boolean;
  launchCleanupStateFinalized?: boolean;
}

interface GetDeleteStringMap {
  get(key: string): string | undefined;
  delete(key: string): boolean;
}

interface DeleteStringMap {
  delete(key: string): boolean | void;
}

interface KeyedDeleteStringMap extends DeleteStringMap {
  keys(): IterableIterator<string>;
}

interface TimeoutMap {
  get(key: string): NodeJS.Timeout | undefined;
  delete(key: string): boolean;
}

export interface TeamProvisioningCleanupPorts<TRun extends TeamProvisioningCleanupRun> {
  getTrackedRunId(teamName: string): string | null;
  isRunIdTracked(runId: string): boolean;
  buildRetainedClaudeLogsSnapshot(run: TRun): RetainedClaudeLogsSnapshotLike | null;
  shouldFinalizeIncompleteLaunchState(run: TRun): boolean;
  buildIncompleteLaunchCleanupReason(run: TRun): string;
  markIncompleteLaunchStateFinalized(run: TRun, cleanupReason: string): void;
  persistLaunchStateSnapshot(run: TRun, phase: 'finished'): Promise<unknown>;
  writeLaunchFailureArtifactPackBestEffort(
    run: TRun,
    options: { reason: 'launch_progress_failed' | 'launch_cleanup_unconfirmed_bootstrap' }
  ): void;
  resetRuntimeToolActivity(run: TRun): void;
  setLeadActivity(run: TRun, state: 'active' | 'idle' | 'offline'): void;
  stopStallWatchdog(run: TRun): void;
  stopFilesystemMonitor(run: TRun): void;
  provisioningRunByTeam: GetDeleteStringMap;
  aliveRunByTeam: GetDeleteStringMap;
  deleteAliveRunId(teamName: string): void;
  clearSecondaryRuntimeRuns(teamName: string): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  invalidateMemberSpawnStatusesCache(teamName: string): void;
  leadInboxRelayInFlight: DeleteStringMap;
  relayedLeadInboxMessageIds: DeleteStringMap;
  pendingCrossTeamFirstReplies: DeleteStringMap;
  recentCrossTeamLeadDeliveryMessageIds: DeleteStringMap;
  recentSameTeamNativeFingerprints: DeleteStringMap;
  clearSameTeamRetryTimers(teamName: string): void;
  clearLeadInboxFollowUpRelayTimer(teamName: string): void;
  getMemberLaunchGraceKey(run: TRun, memberName: string): string;
  pendingTimeouts: TimeoutMap;
  memberInboxRelayInFlight: KeyedDeleteStringMap;
  openCodeMemberInboxRelayInFlight: KeyedDeleteStringMap;
  openCodeMemberSendInFlightByLane: KeyedDeleteStringMap;
  openCodePromptDeliveryWatchdogScheduler: { cancelTeam(teamName: string): void };
  openCodeRuntimeDeliveryAdvisory: { cancelTeam(teamName: string): void };
  relayedMemberInboxMessageIds: KeyedDeleteStringMap;
  liveLeadProcessMessages: DeleteStringMap;
  pruneLiveLeadMessagesForCleanedRun(run: TRun): void;
  clearApprovalTimeout(requestId: string): void;
  inFlightResponses: DeleteStringMap;
  dismissApprovalNotification(requestId: string): void;
  emitToolApprovalEvent(event: { dismissed: true; teamName: string; runId: string }): void;
  mcpConfigBuilder: { removeConfigFile(filePath: string): Promise<void> | void };
  removeRunMemberMcpConfigFilesLater(run: TRun): void;
  retainedClaudeLogsByTeam: {
    set(teamName: string, snapshot: RetainedClaudeLogsSnapshotLike): unknown;
    delete(teamName: string): boolean;
  };
  retainProvisioningProgress(runId: string, progress: TeamProvisioningProgress): void;
  runs: DeleteStringMap;
}

export interface FinalizeIncompleteLaunchStateBeforeCleanupPorts<
  TRun extends IncompleteLaunchCleanupRun,
> {
  markIncompleteLaunchStateFinalized(run: TRun, cleanupReason: string): void;
  persistLaunchStateSnapshot(run: TRun, phase: 'finished'): Promise<unknown>;
}

export function shouldFinalizeIncompleteLaunchState(run: IncompleteLaunchCleanupRun): boolean {
  return (
    run.isLaunch &&
    run.launchStateClearedForRun !== false &&
    !run.provisioningComplete &&
    !run.cancelRequested &&
    run.launchCleanupStateFinalized !== true
  );
}

export function buildIncompleteLaunchCleanupReason(
  run: Pick<IncompleteLaunchCleanupRun, 'progress'>,
  fallback = 'Launch ended before teammate bootstrap completed.'
): string {
  return typeof run.progress.error === 'string' && run.progress.error.trim()
    ? run.progress.error.trim()
    : run.progress.state === 'failed' && run.progress.message.trim()
      ? run.progress.message.trim()
      : fallback;
}

export async function finalizeIncompleteLaunchStateBeforeCleanup<
  TRun extends IncompleteLaunchCleanupRun,
>(
  run: TRun,
  ports: FinalizeIncompleteLaunchStateBeforeCleanupPorts<TRun>,
  options: {
    fallbackReason?: string;
    onPersistFailure?: (run: TRun, error: unknown) => void;
  } = {}
): Promise<void> {
  if (!shouldFinalizeIncompleteLaunchState(run)) {
    return;
  }
  const cleanupReason = buildIncompleteLaunchCleanupReason(run, options.fallbackReason);
  ports.markIncompleteLaunchStateFinalized(run, cleanupReason);
  try {
    await ports.persistLaunchStateSnapshot(run, 'finished');
  } catch (error) {
    run.launchCleanupStateFinalized = false;
    options.onPersistFailure?.(run, error);
  }
}

export function cleanupProvisioningRun<TRun extends TeamProvisioningCleanupRun>(
  run: TRun,
  ports: TeamProvisioningCleanupPorts<TRun>
): void {
  const currentProvisioningRunId = ports.provisioningRunByTeam.get(run.teamName) ?? null;
  const currentAliveRunId = ports.aliveRunByTeam.get(run.teamName) ?? null;
  const currentTrackedRunId = ports.getTrackedRunId(run.teamName);
  // A residual id left behind by an already-untracked run must not masquerade as
  // a newer run: that would skip the team-scoped cleanup below with nothing left
  // to perform it later.
  const isNewerTrackedRunId = (candidateRunId: string | null): boolean =>
    candidateRunId !== null && candidateRunId !== run.runId && ports.isRunIdTracked(candidateRunId);
  const hasNewerTrackedRun =
    isNewerTrackedRunId(currentTrackedRunId) ||
    isNewerTrackedRunId(currentProvisioningRunId) ||
    isNewerTrackedRunId(currentAliveRunId);
  const retainedClaudeLogs = hasNewerTrackedRun ? null : ports.buildRetainedClaudeLogsSnapshot(run);

  if (!hasNewerTrackedRun) {
    peekAutoResumeService()?.cancelPendingAutoResume(run.teamName);
  }

  if (!hasNewerTrackedRun && ports.shouldFinalizeIncompleteLaunchState(run)) {
    const cleanupReason = ports.buildIncompleteLaunchCleanupReason(run);
    ports.markIncompleteLaunchStateFinalized(run, cleanupReason);
    void ports.persistLaunchStateSnapshot(run, 'finished').catch(() => undefined);
  }
  if (
    !hasNewerTrackedRun &&
    (run.progress.state === 'failed' ||
      (run.isLaunch &&
        run.launchStateClearedForRun !== false &&
        !run.provisioningComplete &&
        !run.cancelRequested))
  ) {
    ports.writeLaunchFailureArtifactPackBestEffort(run, {
      reason:
        run.progress.state === 'failed'
          ? 'launch_progress_failed'
          : 'launch_cleanup_unconfirmed_bootstrap',
    });
  }
  if (!hasNewerTrackedRun) {
    ports.resetRuntimeToolActivity(run);
    ports.setLeadActivity(run, 'offline');
  }
  run.pendingDirectCrossTeamSendRefresh = false;
  if (run.timeoutHandle) {
    clearTimeout(run.timeoutHandle);
    run.timeoutHandle = null;
  }
  ports.stopStallWatchdog(run);
  if (run.silentUserDmForwardClearHandle) {
    clearTimeout(run.silentUserDmForwardClearHandle);
    run.silentUserDmForwardClearHandle = null;
  }
  clearPostCompactReminderState(run);
  clearGeminiPostLaunchHydrationState(run);
  ports.stopFilesystemMonitor(run);
  if (run.child) {
    run.child.stdout?.removeAllListeners('data');
    run.child.stderr?.removeAllListeners('data');
  }
  if (ports.provisioningRunByTeam.get(run.teamName) === run.runId) {
    ports.provisioningRunByTeam.delete(run.teamName);
  }
  if (ports.aliveRunByTeam.get(run.teamName) === run.runId) {
    ports.deleteAliveRunId(run.teamName);
  }
  if (!hasNewerTrackedRun) {
    ports.clearSecondaryRuntimeRuns(run.teamName);
  }
  if (!hasNewerTrackedRun) {
    ports.invalidateRuntimeSnapshotCaches(run.teamName);
    ports.invalidateMemberSpawnStatusesCache(run.teamName);
    ports.leadInboxRelayInFlight.delete(run.teamName);
    ports.relayedLeadInboxMessageIds.delete(run.teamName);
    ports.pendingCrossTeamFirstReplies.delete(run.teamName);
    ports.recentCrossTeamLeadDeliveryMessageIds.delete(run.teamName);
    ports.recentSameTeamNativeFingerprints.delete(run.teamName);
    ports.clearSameTeamRetryTimers(run.teamName);
    ports.clearLeadInboxFollowUpRelayTimer(run.teamName);
  }
  for (const memberName of run.memberSpawnStatuses.keys()) {
    const key = ports.getMemberLaunchGraceKey(run, memberName);
    for (const timerKey of [key, `${key}:bootstrap-stall`]) {
      const timer = ports.pendingTimeouts.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        ports.pendingTimeouts.delete(timerKey);
      }
    }
  }
  run.activeCrossTeamReplyHints = [];
  run.pendingInboxRelayCandidates = [];
  if (!hasNewerTrackedRun) {
    for (const key of Array.from(ports.memberInboxRelayInFlight.keys())) {
      if (key.startsWith(`${run.teamName}:`)) {
        ports.memberInboxRelayInFlight.delete(key);
      }
    }
    for (const key of Array.from(ports.openCodeMemberInboxRelayInFlight.keys())) {
      if (key.startsWith(`opencode:${run.teamName}:`)) {
        ports.openCodeMemberInboxRelayInFlight.delete(key);
      }
    }
    for (const key of Array.from(ports.openCodeMemberSendInFlightByLane.keys())) {
      if (key.startsWith(`opencode-send:${run.teamName}:`)) {
        ports.openCodeMemberSendInFlightByLane.delete(key);
      }
    }
    ports.openCodePromptDeliveryWatchdogScheduler.cancelTeam(run.teamName);
    ports.openCodeRuntimeDeliveryAdvisory.cancelTeam(run.teamName);
    for (const key of Array.from(ports.relayedMemberInboxMessageIds.keys())) {
      if (key.startsWith(`${run.teamName}:`)) {
        ports.relayedMemberInboxMessageIds.delete(key);
      }
    }
    ports.liveLeadProcessMessages.delete(run.teamName);
  } else {
    ports.pruneLiveLeadMessagesForCleanedRun(run);
  }
  if (run.pendingApprovals.size > 0) {
    for (const requestId of run.pendingApprovals.keys()) {
      ports.clearApprovalTimeout(requestId);
      ports.inFlightResponses.delete(requestId);
      ports.dismissApprovalNotification(requestId);
    }
    ports.emitToolApprovalEvent({ dismissed: true, teamName: run.teamName, runId: run.runId });
    run.pendingApprovals.clear();
  }
  if (run.mcpConfigPath) {
    void Promise.resolve(ports.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath)).catch(
      () => undefined
    );
    run.mcpConfigPath = null;
  }
  ports.removeRunMemberMcpConfigFilesLater(run);
  if (run.bootstrapSpecPath) {
    void Promise.resolve(removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath)).catch(
      () => undefined
    );
    run.bootstrapSpecPath = null;
  }
  if (run.bootstrapUserPromptPath) {
    void Promise.resolve(
      removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath)
    ).catch(() => undefined);
    run.bootstrapUserPromptPath = null;
  }
  if (!hasNewerTrackedRun) {
    if (retainedClaudeLogs) {
      ports.retainedClaudeLogsByTeam.set(run.teamName, retainedClaudeLogs);
    } else {
      ports.retainedClaudeLogsByTeam.delete(run.teamName);
    }
  }
  if (run.progress) {
    ports.retainProvisioningProgress(run.runId, run.progress);
  }
  ports.runs.delete(run.runId);
}
