import { randomUUID } from 'crypto';

import {
  killTeamProcess as killTeamProcessDefault,
  nowIso as nowIsoDefault,
  updateProgress as updateProgressDefault,
} from './TeamProvisioningRunProgress';
import {
  cancelRuntimeAdapterProvisioning as cancelRuntimeAdapterProvisioningHelper,
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned as clearOpenCodeRuntimeAdapterPrimaryLaneIfOwnedHelper,
  isCancellableRuntimeAdapterProgress as isCancellableRuntimeAdapterProgressHelper,
  recordCancelledOpenCodeRuntimeAdapterLaunch as recordCancelledOpenCodeRuntimeAdapterLaunchHelper,
  type RuntimeAdapterCancellationPorts,
  type RuntimeAdapterRunEntry,
} from './TeamProvisioningRuntimeAdapterCancellation';
import { createTeamProvisioningRuntimeAdapterCancellationPorts } from './TeamProvisioningRuntimeAdapterCancellationPortsFactory';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';

export interface TeamProvisioningCancellationRun {
  runId: string;
  teamName: string;
  progress: TeamProvisioningProgress;
  cancelRequested: boolean;
  processKilled: boolean;
  child: unknown;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningCancellationBoundaryPorts<
  TRun extends TeamProvisioningCancellationRun,
> {
  runs: Map<string, TRun>;
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  cancelledRuntimeAdapterRunIds: Set<string>;
  runtimeAdapterRunByTeam: Map<string, RuntimeAdapterRunEntry>;
  provisioningRunByTeam: Map<string, string>;
  aliveRunByTeam: ReadonlyMap<string, string>;
  getTrackedRunId(teamName: string): string | null;
  deleteAliveRunId(teamName: string): void;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  killTeamProcess(child: TRun['child']): void;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string
  ): TeamProvisioningProgress;
  cleanupRun(run: TRun): void;
  nowIso(): string;
  clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options: { runId?: string; laneId?: string; emitDismiss?: boolean }
  ): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress?: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress;
  emitTeamChange(event: TeamChangeEvent): void;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  readPersistedTeamProjectPath(teamName: string): string | null;
  logWarning(message: string): void;
}

export interface TeamProvisioningCancellationBoundary {
  cancelProvisioning(runId: string): Promise<void>;
  isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean;
  cancelRuntimeAdapterProvisioning(
    runId: string,
    runtimeProgress: TeamProvisioningProgress
  ): Promise<void>;
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName: string, runId: string): Promise<void>;
  recordCancelledOpenCodeRuntimeAdapterLaunch(
    teamName: string,
    sourceWarning: string | undefined,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamLaunchResponse;
}

export interface TeamProvisioningCancellationBoundaryServiceHost<
  TRun extends TeamProvisioningCancellationRun,
> {
  runs: TeamProvisioningCancellationBoundaryPorts<TRun>['runs'];
  runtimeAdapterProgressByRunId: TeamProvisioningCancellationBoundaryPorts<TRun>['runtimeAdapterProgressByRunId'];
  cancelledRuntimeAdapterRunIds: TeamProvisioningCancellationBoundaryPorts<TRun>['cancelledRuntimeAdapterRunIds'];
  runtimeAdapterRunByTeam: TeamProvisioningCancellationBoundaryPorts<TRun>['runtimeAdapterRunByTeam'];
  provisioningRunByTeam: TeamProvisioningCancellationBoundaryPorts<TRun>['provisioningRunByTeam'];
  aliveRunByTeam: TeamProvisioningCancellationBoundaryPorts<TRun>['aliveRunByTeam'];
  runTracking: Pick<
    TeamProvisioningCancellationBoundaryPorts<TRun>,
    'getTrackedRunId' | 'deleteAliveRunId'
  >;
  hasSecondaryRuntimeRuns: TeamProvisioningCancellationBoundaryPorts<TRun>['hasSecondaryRuntimeRuns'];
  stopMixedSecondaryRuntimeLanes: TeamProvisioningCancellationBoundaryPorts<TRun>['stopMixedSecondaryRuntimeLanes'];
  stopOpenCodeRuntimeAdapterTeam: TeamProvisioningCancellationBoundaryPorts<TRun>['stopOpenCodeRuntimeAdapterTeam'];
  cleanupRun: TeamProvisioningCancellationBoundaryPorts<TRun>['cleanupRun'];
  toolApprovalFacade: {
    clearOpenCodeRuntimeToolApprovals: TeamProvisioningCancellationBoundaryPorts<TRun>['clearOpenCodeRuntimeToolApprovals'];
  };
  invalidateRuntimeSnapshotCaches: TeamProvisioningCancellationBoundaryPorts<TRun>['invalidateRuntimeSnapshotCaches'];
  runtimeAdapterProgressState: {
    setRuntimeAdapterProgress: TeamProvisioningCancellationBoundaryPorts<TRun>['setRuntimeAdapterProgress'];
  };
  teamChangeEmitter?: TeamProvisioningCancellationBoundaryPorts<TRun>['emitTeamChange'];
  launchStateStore: {
    read: TeamProvisioningCancellationBoundaryPorts<TRun>['readLaunchState'];
  };
  appShellBoundary: {
    getOpenCodeRuntimeAdapter: TeamProvisioningCancellationBoundaryPorts<TRun>['getOpenCodeRuntimeAdapter'];
  };
  readPersistedTeamProjectPath: TeamProvisioningCancellationBoundaryPorts<TRun>['readPersistedTeamProjectPath'];
}

export interface TeamProvisioningCancellationBoundaryServiceHostOptions<
  TRun extends TeamProvisioningCancellationRun,
> {
  killTeamProcess?: TeamProvisioningCancellationBoundaryPorts<TRun>['killTeamProcess'];
  updateProgress?: TeamProvisioningCancellationBoundaryPorts<TRun>['updateProgress'];
  nowIso?: TeamProvisioningCancellationBoundaryPorts<TRun>['nowIso'];
  logWarning?: TeamProvisioningCancellationBoundaryPorts<TRun>['logWarning'];
}

const CANCELLABLE_PROVISIONING_STATES: ReadonlySet<TeamProvisioningProgress['state']> = new Set([
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
]);

export function createTeamProvisioningCancellationBoundaryPortsFromService<
  TRun extends TeamProvisioningCancellationRun,
>(
  service: TeamProvisioningCancellationBoundaryServiceHost<TRun>,
  options: TeamProvisioningCancellationBoundaryServiceHostOptions<TRun> = {}
): TeamProvisioningCancellationBoundaryPorts<TRun> {
  return {
    runs: service.runs,
    runtimeAdapterProgressByRunId: service.runtimeAdapterProgressByRunId,
    cancelledRuntimeAdapterRunIds: service.cancelledRuntimeAdapterRunIds,
    runtimeAdapterRunByTeam: service.runtimeAdapterRunByTeam,
    provisioningRunByTeam: service.provisioningRunByTeam,
    aliveRunByTeam: service.aliveRunByTeam,
    getTrackedRunId: (teamName) => service.runTracking.getTrackedRunId(teamName),
    deleteAliveRunId: (teamName) => service.runTracking.deleteAliveRunId(teamName),
    hasSecondaryRuntimeRuns: (teamName) => service.hasSecondaryRuntimeRuns(teamName),
    stopMixedSecondaryRuntimeLanes: (teamName) => service.stopMixedSecondaryRuntimeLanes(teamName),
    stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
      service.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
    killTeamProcess:
      options.killTeamProcess ??
      (killTeamProcessDefault as TeamProvisioningCancellationBoundaryPorts<TRun>['killTeamProcess']),
    updateProgress:
      options.updateProgress ??
      (updateProgressDefault as unknown as TeamProvisioningCancellationBoundaryPorts<TRun>['updateProgress']),
    cleanupRun: (run) => service.cleanupRun(run),
    nowIso: options.nowIso ?? nowIsoDefault,
    clearOpenCodeRuntimeToolApprovals: (teamName, approvalOptions) =>
      service.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals(teamName, approvalOptions),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    setRuntimeAdapterProgress: (progress, onProgress) =>
      service.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress),
    emitTeamChange: (event) => service.teamChangeEmitter?.(event),
    readLaunchState: (teamName) => service.launchStateStore.read(teamName),
    getOpenCodeRuntimeAdapter: () => service.appShellBoundary.getOpenCodeRuntimeAdapter(),
    readPersistedTeamProjectPath: (teamName) => service.readPersistedTeamProjectPath(teamName),
    logWarning: options.logWarning ?? (() => undefined),
  };
}

export function createTeamProvisioningCancellationBoundary<
  TRun extends TeamProvisioningCancellationRun,
>(ports: TeamProvisioningCancellationBoundaryPorts<TRun>): TeamProvisioningCancellationBoundary {
  const createRuntimeAdapterCancellationPorts = (): RuntimeAdapterCancellationPorts =>
    createTeamProvisioningRuntimeAdapterCancellationPorts({
      cancelledRuntimeAdapterRunIds: ports.cancelledRuntimeAdapterRunIds,
      runtimeAdapterRunByTeam: ports.runtimeAdapterRunByTeam,
      provisioningRunByTeam: ports.provisioningRunByTeam,
      aliveRunByTeam: ports.aliveRunByTeam,
      nowIso: ports.nowIso,
      clearOpenCodeRuntimeToolApprovals: ports.clearOpenCodeRuntimeToolApprovals,
      deleteAliveRunId: ports.deleteAliveRunId,
      invalidateRuntimeSnapshotCaches: ports.invalidateRuntimeSnapshotCaches,
      setRuntimeAdapterProgress: ports.setRuntimeAdapterProgress,
      emitTeamChange: ports.emitTeamChange,
      readLaunchState: ports.readLaunchState,
      getOpenCodeRuntimeAdapter: ports.getOpenCodeRuntimeAdapter,
      readPersistedTeamProjectPath: ports.readPersistedTeamProjectPath,
      logWarning: ports.logWarning,
    });

  const cancelRuntimeAdapterProvisioning = async (
    runId: string,
    runtimeProgress: TeamProvisioningProgress
  ): Promise<void> => {
    await cancelRuntimeAdapterProvisioningHelper({
      runId,
      runtimeProgress,
      ports: createRuntimeAdapterCancellationPorts(),
    });
  };

  const clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned = async (
    teamName: string,
    runId: string
  ): Promise<void> => {
    await clearOpenCodeRuntimeAdapterPrimaryLaneIfOwnedHelper({
      teamName,
      runId,
      ports: createRuntimeAdapterCancellationPorts(),
    });
  };

  const recordCancelledOpenCodeRuntimeAdapterLaunch = (
    teamName: string,
    sourceWarning: string | undefined,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamLaunchResponse =>
    recordCancelledOpenCodeRuntimeAdapterLaunchHelper({
      teamName,
      sourceWarning,
      onProgress,
      createRunId: randomUUID,
      ports: createRuntimeAdapterCancellationPorts(),
    });

  return {
    async cancelProvisioning(runId) {
      const run = ports.runs.get(runId);
      if (!run) {
        const runtimeProgress = ports.runtimeAdapterProgressByRunId.get(runId);
        if (runtimeProgress) {
          await cancelRuntimeAdapterProvisioning(runId, runtimeProgress);
          return;
        }
        throw new Error('Unknown runId');
      }
      if (!CANCELLABLE_PROVISIONING_STATES.has(run.progress.state)) {
        throw new Error('Provisioning cannot be cancelled in current state');
      }

      run.cancelRequested = true;
      run.processKilled = true;
      // For a pure-OpenCode aggregate run, run.child is null so killTeamProcess is a
      // no-op — the runtime lanes are adapter-managed. Mirror dev's
      // stopOpenCodeAggregateRuntimeLanes: stop the owned primary OpenCode adapter
      // lane AND any secondary lanes, otherwise cancelling mid-launch (state
      // 'spawning', after the primary lane came up) orphans the primary runtime
      // process.
      ports.killTeamProcess(run.child);
      if (ports.getTrackedRunId(run.teamName) === run.runId) {
        const stops: Promise<void>[] = [];
        const primaryRun = ports.runtimeAdapterRunByTeam.get(run.teamName);
        if (primaryRun?.providerId === 'opencode' && primaryRun.runId === run.runId) {
          stops.push(ports.stopOpenCodeRuntimeAdapterTeam(run.teamName, run.runId));
        }
        if (ports.hasSecondaryRuntimeRuns(run.teamName)) {
          stops.push(ports.stopMixedSecondaryRuntimeLanes(run.teamName));
        }
        if (stops.length > 0) {
          void Promise.all(stops);
        }
      }
      const progress = ports.updateProgress(run, 'cancelled', 'Provisioning cancelled by user');
      run.onProgress(progress);
      ports.cleanupRun(run);
    },

    isCancellableRuntimeAdapterProgress(progress) {
      return isCancellableRuntimeAdapterProgressHelper(progress);
    },

    cancelRuntimeAdapterProvisioning,
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned,
    recordCancelledOpenCodeRuntimeAdapterLaunch,
  };
}
