import { getErrorMessage } from '@shared/utils/errorHandling';

import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import { isTerminalFailureProvisioningState } from './TeamProvisioningProgressState';

import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';

interface LaunchSummaryLike {
  confirmedCount: number;
  pendingCount: number;
  failedCount: number;
  skippedCount?: number;
  runtimeAlivePendingCount: number;
  shellOnlyPendingCount?: number;
  runtimeProcessPendingCount?: number;
  runtimeCandidatePendingCount?: number;
  noRuntimePendingCount?: number;
  permissionPendingCount?: number;
}

interface FailedSpawnMember {
  name: string;
  error?: string;
  updatedAt: string;
}

export interface DeterministicBootstrapCompletionRecoveryRun {
  runId: string;
  teamName: string;
  startedAt: string;
  provisioningComplete: boolean;
  cancelRequested: boolean;
  processKilled: boolean;
  deterministicBootstrap?: boolean;
  requiresFirstRealTurnSuccess: boolean;
  firstRealTurnSucceeded: boolean;
  mixedSecondaryLanes?: readonly unknown[];
  isLaunch: boolean;
  progress: TeamProvisioningProgress;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface DeterministicBootstrapCompletionRecoveryPorts<
  TRun extends DeterministicBootstrapCompletionRecoveryRun,
> {
  isProvisioningRunPromotedToAlive(run: TRun): boolean;
  hasPendingDeterministicFirstRealTurn(run: TRun): boolean;
  isProvisioningRunStillPromotable(run: TRun): boolean;
  isCurrentProvisioningRun(run: TRun): boolean;
  readBootstrapLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  syncRunMemberSpawnStatusesFromSnapshot(run: TRun, snapshot: PersistedTeamLaunchSnapshot): void;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot>;
  nowIso(): string;
  getMemberLaunchSummary(run: TRun): LaunchSummaryLike;
  hasPendingLaunchMembers(
    run: TRun,
    launchSummary: LaunchSummaryLike,
    snapshot: PersistedTeamLaunchSnapshot
  ): boolean;
  buildAggregatePendingLaunchMessage(
    prefix: string,
    run: TRun,
    launchSummary: LaunchSummaryLike,
    snapshot: PersistedTeamLaunchSnapshot
  ): string;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<TeamProvisioningProgress, 'cliLogsTail' | 'messageSeverity'>
  ): TeamProvisioningProgress;
  extractCliLogsFromRun(run: TRun): string | undefined;
  deleteProvisioningRun(teamName: string): void;
  setAliveRunId(teamName: string, runId: string): void;
  emitTeamChange(event: TeamChangeEvent): void;
  fireTeamLaunchedNotification(run: TRun): Promise<unknown>;
  fireTeamLaunchIncompleteNotification(
    run: TRun,
    failedMembers: readonly FailedSpawnMember[],
    launchSummary: LaunchSummaryLike,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<unknown>;
  warn(message: string): void;
}

export interface DeterministicBootstrapCompletionRecoveryServiceHost<
  TRun extends DeterministicBootstrapCompletionRecoveryRun,
> {
  isProvisioningRunPromotedToAlive(run: TRun): boolean;
  hasPendingDeterministicFirstRealTurn(run: TRun): boolean;
  isProvisioningRunStillPromotable(run: TRun): boolean;
  provisioningRunByTeam: {
    get(teamName: string): string | null | undefined;
    delete(teamName: string): unknown;
  };
  syncRunMemberSpawnStatusesFromSnapshot(run: TRun, snapshot: PersistedTeamLaunchSnapshot): void;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot>;
  hasPendingLaunchMembers(
    run: TRun,
    launchSummary: LaunchSummaryLike,
    snapshot: PersistedTeamLaunchSnapshot
  ): boolean;
  runTracking: {
    setAliveRunId(teamName: string, runId: string): void;
  };
  teamChangeEmitter?: ((event: TeamChangeEvent) => void) | null;
  fireTeamLaunchedNotification(run: TRun): Promise<unknown>;
  fireTeamLaunchIncompleteNotification(
    run: TRun,
    failedMembers: readonly FailedSpawnMember[],
    launchSummary: LaunchSummaryLike,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<unknown>;
}

export type DeterministicBootstrapCompletionRecoveryServiceDeps<
  TRun extends DeterministicBootstrapCompletionRecoveryRun,
> = Pick<
  DeterministicBootstrapCompletionRecoveryPorts<TRun>,
  | 'readBootstrapLaunchSnapshot'
  | 'nowIso'
  | 'getMemberLaunchSummary'
  | 'buildAggregatePendingLaunchMessage'
  | 'updateProgress'
  | 'extractCliLogsFromRun'
  | 'warn'
>;

export function createDeterministicBootstrapCompletionRecoveryPortsFromService<
  TRun extends DeterministicBootstrapCompletionRecoveryRun,
>(
  service: DeterministicBootstrapCompletionRecoveryServiceHost<TRun>,
  deps: DeterministicBootstrapCompletionRecoveryServiceDeps<TRun>
): DeterministicBootstrapCompletionRecoveryPorts<TRun> {
  return {
    isProvisioningRunPromotedToAlive: (run) => service.isProvisioningRunPromotedToAlive(run),
    hasPendingDeterministicFirstRealTurn: (run) =>
      service.hasPendingDeterministicFirstRealTurn(run),
    isProvisioningRunStillPromotable: (run) => service.isProvisioningRunStillPromotable(run),
    isCurrentProvisioningRun: (run) =>
      service.provisioningRunByTeam.get(run.teamName) === run.runId,
    readBootstrapLaunchSnapshot: deps.readBootstrapLaunchSnapshot,
    syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
      service.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      service.writeLaunchStateSnapshot(teamName, snapshot),
    nowIso: deps.nowIso,
    getMemberLaunchSummary: deps.getMemberLaunchSummary,
    hasPendingLaunchMembers: (run, launchSummary, snapshot) =>
      service.hasPendingLaunchMembers(run, launchSummary, snapshot),
    buildAggregatePendingLaunchMessage: deps.buildAggregatePendingLaunchMessage,
    updateProgress: deps.updateProgress,
    extractCliLogsFromRun: deps.extractCliLogsFromRun,
    deleteProvisioningRun: (teamName) => {
      service.provisioningRunByTeam.delete(teamName);
    },
    setAliveRunId: (teamName, runId) => service.runTracking.setAliveRunId(teamName, runId),
    emitTeamChange: (event) => service.teamChangeEmitter?.(event),
    fireTeamLaunchedNotification: (run) => service.fireTeamLaunchedNotification(run),
    fireTeamLaunchIncompleteNotification: (run, failedMembers, launchSummary, snapshot) =>
      service.fireTeamLaunchIncompleteNotification(run, failedMembers, launchSummary, snapshot),
    warn: deps.warn,
  };
}

export async function recoverDeterministicBootstrapCompletionWithService<
  TRun extends DeterministicBootstrapCompletionRecoveryRun,
>(
  run: TRun,
  service: DeterministicBootstrapCompletionRecoveryServiceHost<TRun>,
  deps: DeterministicBootstrapCompletionRecoveryServiceDeps<TRun>
): Promise<void> {
  return recoverDeterministicBootstrapCompletion(
    run,
    createDeterministicBootstrapCompletionRecoveryPortsFromService(service, deps)
  );
}

export async function recoverDeterministicBootstrapCompletion<
  TRun extends DeterministicBootstrapCompletionRecoveryRun,
>(run: TRun, ports: DeterministicBootstrapCompletionRecoveryPorts<TRun>): Promise<void> {
  if (
    !run.provisioningComplete ||
    run.cancelRequested ||
    run.processKilled ||
    isTerminalFailureProvisioningState(run.progress.state) ||
    ports.isProvisioningRunPromotedToAlive(run) ||
    ports.hasPendingDeterministicFirstRealTurn(run) ||
    !ports.isProvisioningRunStillPromotable(run) ||
    !ports.isCurrentProvisioningRun(run)
  ) {
    return;
  }

  if ((run.mixedSecondaryLanes ?? []).length > 0) {
    return;
  }

  const snapshot = await ports.readBootstrapLaunchSnapshot(run.teamName).catch(() => null);
  if (!ports.isProvisioningRunStillPromotable(run)) {
    return;
  }
  if (!snapshot || (snapshot.launchPhase !== 'finished' && snapshot.launchPhase !== 'reconciled')) {
    return;
  }

  const runStartedAtMs = Date.parse(run.startedAt);
  const snapshotUpdatedAtMs = Date.parse(snapshot.updatedAt);
  if (
    Number.isFinite(runStartedAtMs) &&
    Number.isFinite(snapshotUpdatedAtMs) &&
    snapshotUpdatedAtMs < runStartedAtMs
  ) {
    return;
  }

  const memberNames = getPersistedLaunchMemberNames(snapshot);
  if (memberNames.length === 0) {
    return;
  }

  ports.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
  await ports.writeLaunchStateSnapshot(run.teamName, snapshot).catch((error: unknown) => {
    ports.warn(
      `[${run.teamName}] Failed to persist recovered deterministic bootstrap snapshot: ${getErrorMessage(
        error
      )}`
    );
  });
  if (!ports.isProvisioningRunStillPromotable(run)) {
    return;
  }

  const failedSpawnMembers = memberNames
    .filter((memberName) => snapshot.members[memberName]?.launchState === 'failed_to_start')
    .map((memberName) => ({
      name: memberName,
      error: snapshot.members[memberName]?.hardFailureReason,
      updatedAt: snapshot.members[memberName]?.lastEvaluatedAt ?? ports.nowIso(),
    }));
  const launchSummary = snapshot.summary ?? ports.getMemberLaunchSummary(run);
  const hasSpawnFailures = failedSpawnMembers.length > 0;
  const hasPendingBootstrap =
    !hasSpawnFailures && ports.hasPendingLaunchMembers(run, launchSummary, snapshot);
  const messagePrefix = run.isLaunch ? 'Launch completed' : 'Team provisioned';
  const readyMessage = hasSpawnFailures
    ? `${messagePrefix} with teammate errors - ${failedSpawnMembers
        .map((member) => member.name)
        .join(', ')} failed to start`
    : hasPendingBootstrap
      ? ports.buildAggregatePendingLaunchMessage(messagePrefix, run, launchSummary, snapshot)
      : run.isLaunch
        ? 'Team launched - process alive and ready'
        : 'Team provisioned - process alive and ready';

  const progress = ports.updateProgress(run, 'ready', readyMessage, {
    cliLogsTail: ports.extractCliLogsFromRun(run),
    messageSeverity: hasSpawnFailures || hasPendingBootstrap ? 'warning' : undefined,
  });
  run.onProgress(progress);
  ports.deleteProvisioningRun(run.teamName);
  ports.setAliveRunId(run.teamName, run.runId);
  ports.warn(
    `[${run.teamName}] Recovered ready state from completed deterministic bootstrap snapshot after post-bootstrap finalization delay.`
  );

  ports.emitTeamChange({
    type: 'lead-message',
    teamName: run.teamName,
    runId: run.runId,
    detail: 'lead-session-sync',
  });

  if (!hasSpawnFailures && !hasPendingBootstrap) {
    void ports.fireTeamLaunchedNotification(run);
  } else if (hasSpawnFailures) {
    void ports.fireTeamLaunchIncompleteNotification(
      run,
      failedSpawnMembers,
      launchSummary,
      snapshot
    );
  }
}
