import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { randomUUID } from 'crypto';

import {
  clearOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import {
  type OpenCodeAggregateProvisioningRun,
  runOpenCodeWorktreeRootAggregateLaunch,
  type RunOpenCodeWorktreeRootAggregateLaunchInput,
} from './TeamProvisioningOpenCodeAggregateRun';
import {
  runOpenCodeTeamRuntimeAdapterLaunch,
  type RunOpenCodeTeamRuntimeAdapterLaunchInput,
} from './TeamProvisioningOpenCodeRuntimeAdapterLaunch';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberSpec,
} from '../runtime';
import type {
  MixedSecondaryRuntimeLaneState,
  SecondaryRuntimeRunEntry,
} from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

export type { OpenCodeAggregateProvisioningRun } from './TeamProvisioningOpenCodeAggregateRun';

function nowIso(): string {
  return new Date().toISOString();
}

export interface OpenCodeLaunchWiringRuntimeRunEntry {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  members?: TeamRuntimeLaunchResult['members'];
}

export interface TeamProvisioningOpenCodeLaunchWiringHost<Run> {
  runtimeAdapterRunByTeam: Map<string, OpenCodeLaunchWiringRuntimeRunEntry>;
  provisioningRunByTeam: Map<string, string>;
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  cancelledRuntimeAdapterRunIds: Set<string>;
  runs: Map<string, Run>;
  secondaryRuntimeRunByTeam: ReadonlyMap<string, ReadonlyMap<string, SecondaryRuntimeRunEntry>>;
  runtimeAdapterProgressState: {
    setRuntimeAdapterProgress(
      progress: TeamProvisioningProgress,
      onProgress?: (progress: TeamProvisioningProgress) => void
    ): TeamProvisioningProgress;
  };
  runTracking: {
    setAliveRunId(teamName: string, runId: string): void;
    deleteAliveRunId(teamName: string): void;
  };
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  getStopAllTeamsGeneration(): number;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  cleanupRun(run: Run): void;
  isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean;
  cancelRuntimeAdapterProvisioning(
    runId: string,
    progress: TeamProvisioningProgress
  ): Promise<void>;
  recordCancelledOpenCodeRuntimeAdapterLaunch(
    teamName: string,
    sourceWarning: string | undefined,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamLaunchResponse;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  readLaunchState(teamName: string): Promise<TeamRuntimeLaunchInput['previousLaunchState']>;
  clearPersistedLaunchState(teamName: string): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  launchOpenCodeAggregatePrimaryLane(input: {
    run: Run;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeLaunchResult | null>;
  launchSingleMixedSecondaryLane(run: Run, lane: MixedSecondaryRuntimeLaneState): Promise<void>;
  publishMixedSecondaryLaneStatusChange(
    run: Run,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  summarizeOpenCodeAggregateLaunchState(input: {
    primaryResult: TeamRuntimeLaunchResult | null;
    lanes: readonly MixedSecondaryRuntimeLaneState[];
  }): TeamRuntimeLaunchResult['teamLaunchState'];
  persistLaunchStateSnapshot(
    run: Run,
    launchPhase: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  syncRunMemberSpawnStatusesFromSnapshot(run: Run, snapshot: PersistedTeamLaunchSnapshot): void;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  getOpenCodeRuntimeLaunchCwd(
    baseCwd: string,
    members: RunOpenCodeTeamRuntimeAdapterLaunchInput['members']
  ): string;
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName: string, runId: string): Promise<void>;
  persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{ result: TeamRuntimeLaunchResult }>;
  syncOpenCodeRuntimeToolApprovals(input: {
    teamName: string;
    runId: string;
    laneId: string;
    cwd: string;
    members: TeamRuntimeLaunchResult['members'];
    expectedMembers: TeamRuntimeMemberSpec[];
    teamColor?: string;
    teamDisplayName?: string;
  }): void;
  emitTeamChange(event: TeamChangeEvent): void;
}

export interface TeamProvisioningOpenCodeLaunchWiring {
  runOpenCodeWorktreeRootAggregateLaunch(
    input: Omit<RunOpenCodeWorktreeRootAggregateLaunchInput, 'adapter'>
  ): Promise<TeamLaunchResponse>;
  runOpenCodeTeamRuntimeAdapterLaunch(
    input: Omit<RunOpenCodeTeamRuntimeAdapterLaunchInput, 'adapter'>
  ): Promise<TeamLaunchResponse>;
}

export interface TeamProvisioningOpenCodeLaunchWiringServiceHost<Run> {
  runtimeAdapterRunByTeam: TeamProvisioningOpenCodeLaunchWiringHost<Run>['runtimeAdapterRunByTeam'];
  provisioningRunByTeam: TeamProvisioningOpenCodeLaunchWiringHost<Run>['provisioningRunByTeam'];
  runtimeAdapterProgressByRunId: TeamProvisioningOpenCodeLaunchWiringHost<Run>['runtimeAdapterProgressByRunId'];
  cancelledRuntimeAdapterRunIds: TeamProvisioningOpenCodeLaunchWiringHost<Run>['cancelledRuntimeAdapterRunIds'];
  runs: TeamProvisioningOpenCodeLaunchWiringHost<Run>['runs'];
  secondaryRuntimeRunByTeam: TeamProvisioningOpenCodeLaunchWiringHost<Run>['secondaryRuntimeRunByTeam'];
  runtimeAdapterProgressState: TeamProvisioningOpenCodeLaunchWiringHost<Run>['runtimeAdapterProgressState'];
  runTracking: TeamProvisioningOpenCodeLaunchWiringHost<Run>['runTracking'];
  stopAllTeamsGeneration: number;
  appShellBoundary: {
    getOpenCodeRuntimeAdapter: TeamProvisioningOpenCodeLaunchWiringHost<Run>['getOpenCodeRuntimeAdapter'];
  };
  launchStateStore: {
    read: TeamProvisioningOpenCodeLaunchWiringHost<Run>['readLaunchState'];
  };
  cancellationBoundary: Pick<
    TeamProvisioningOpenCodeLaunchWiringHost<Run>,
    | 'isCancellableRuntimeAdapterProgress'
    | 'cancelRuntimeAdapterProvisioning'
    | 'recordCancelledOpenCodeRuntimeAdapterLaunch'
    | 'clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned'
  >;
  prepareFacade: {
    getOpenCodeRuntimeLaunchCwd: TeamProvisioningOpenCodeLaunchWiringHost<Run>['getOpenCodeRuntimeLaunchCwd'];
  };
  toolApprovalFacade: {
    syncOpenCodeRuntimeToolApprovals: TeamProvisioningOpenCodeLaunchWiringHost<Run>['syncOpenCodeRuntimeToolApprovals'];
  };
  teamChangeEmitter?: (event: TeamChangeEvent) => void;
  stopOpenCodeRuntimeAdapterTeam: TeamProvisioningOpenCodeLaunchWiringHost<Run>['stopOpenCodeRuntimeAdapterTeam'];
  hasSecondaryRuntimeRuns: TeamProvisioningOpenCodeLaunchWiringHost<Run>['hasSecondaryRuntimeRuns'];
  stopMixedSecondaryRuntimeLanes: TeamProvisioningOpenCodeLaunchWiringHost<Run>['stopMixedSecondaryRuntimeLanes'];
  cleanupRun: TeamProvisioningOpenCodeLaunchWiringHost<Run>['cleanupRun'];
  resetTeamScopedTransientStateForNewRun: TeamProvisioningOpenCodeLaunchWiringHost<Run>['resetTeamScopedTransientStateForNewRun'];
  clearPersistedLaunchState: TeamProvisioningOpenCodeLaunchWiringHost<Run>['clearPersistedLaunchState'];
  invalidateRuntimeSnapshotCaches: TeamProvisioningOpenCodeLaunchWiringHost<Run>['invalidateRuntimeSnapshotCaches'];
  launchOpenCodeAggregatePrimaryLane: TeamProvisioningOpenCodeLaunchWiringHost<Run>['launchOpenCodeAggregatePrimaryLane'];
  launchSingleMixedSecondaryLane: TeamProvisioningOpenCodeLaunchWiringHost<Run>['launchSingleMixedSecondaryLane'];
  publishMixedSecondaryLaneStatusChange: TeamProvisioningOpenCodeLaunchWiringHost<Run>['publishMixedSecondaryLaneStatusChange'];
  summarizeOpenCodeAggregateLaunchState: TeamProvisioningOpenCodeLaunchWiringHost<Run>['summarizeOpenCodeAggregateLaunchState'];
  persistLaunchStateSnapshot: TeamProvisioningOpenCodeLaunchWiringHost<Run>['persistLaunchStateSnapshot'];
  syncRunMemberSpawnStatusesFromSnapshot: TeamProvisioningOpenCodeLaunchWiringHost<Run>['syncRunMemberSpawnStatusesFromSnapshot'];
  deleteSecondaryRuntimeRun: TeamProvisioningOpenCodeLaunchWiringHost<Run>['deleteSecondaryRuntimeRun'];
  persistOpenCodeRuntimeAdapterLaunchResult: TeamProvisioningOpenCodeLaunchWiringHost<Run>['persistOpenCodeRuntimeAdapterLaunchResult'];
}

function getRequiredOpenCodeRuntimeAdapter(host: {
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
}): TeamLaunchRuntimeAdapter {
  const adapter = host.getOpenCodeRuntimeAdapter();
  if (!adapter) {
    throw new Error('OpenCode runtime adapter is not registered');
  }
  return adapter;
}

export function createTeamProvisioningOpenCodeLaunchWiringHostFromService<Run>(
  service: TeamProvisioningOpenCodeLaunchWiringServiceHost<Run>
): TeamProvisioningOpenCodeLaunchWiringHost<Run> {
  return {
    runtimeAdapterRunByTeam: service.runtimeAdapterRunByTeam,
    provisioningRunByTeam: service.provisioningRunByTeam,
    runtimeAdapterProgressByRunId: service.runtimeAdapterProgressByRunId,
    cancelledRuntimeAdapterRunIds: service.cancelledRuntimeAdapterRunIds,
    runs: service.runs,
    secondaryRuntimeRunByTeam: service.secondaryRuntimeRunByTeam,
    runtimeAdapterProgressState: service.runtimeAdapterProgressState,
    runTracking: service.runTracking,
    getOpenCodeRuntimeAdapter: () => service.appShellBoundary.getOpenCodeRuntimeAdapter(),
    getStopAllTeamsGeneration: () => service.stopAllTeamsGeneration,
    stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
      service.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
    hasSecondaryRuntimeRuns: (teamName) => service.hasSecondaryRuntimeRuns(teamName),
    stopMixedSecondaryRuntimeLanes: (teamName) => service.stopMixedSecondaryRuntimeLanes(teamName),
    cleanupRun: (run) => service.cleanupRun(run),
    isCancellableRuntimeAdapterProgress: (progress) =>
      service.cancellationBoundary.isCancellableRuntimeAdapterProgress(progress),
    cancelRuntimeAdapterProvisioning: (runId, progress) =>
      service.cancellationBoundary.cancelRuntimeAdapterProvisioning(runId, progress),
    recordCancelledOpenCodeRuntimeAdapterLaunch: (teamName, sourceWarning, onProgress) =>
      service.cancellationBoundary.recordCancelledOpenCodeRuntimeAdapterLaunch(
        teamName,
        sourceWarning,
        onProgress
      ),
    resetTeamScopedTransientStateForNewRun: (teamName) =>
      service.resetTeamScopedTransientStateForNewRun(teamName),
    readLaunchState: (teamName) => service.launchStateStore.read(teamName),
    clearPersistedLaunchState: (teamName) => service.clearPersistedLaunchState(teamName),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    launchOpenCodeAggregatePrimaryLane: (input) =>
      service.launchOpenCodeAggregatePrimaryLane(input),
    launchSingleMixedSecondaryLane: (run, lane) =>
      service.launchSingleMixedSecondaryLane(run, lane),
    publishMixedSecondaryLaneStatusChange: (run, lane) =>
      service.publishMixedSecondaryLaneStatusChange(run, lane),
    summarizeOpenCodeAggregateLaunchState: (input) =>
      service.summarizeOpenCodeAggregateLaunchState(input),
    persistLaunchStateSnapshot: (run, launchPhase) =>
      service.persistLaunchStateSnapshot(run, launchPhase),
    syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
      service.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      service.deleteSecondaryRuntimeRun(teamName, laneId),
    getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
      service.prepareFacade.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: (teamName, runId) =>
      service.cancellationBoundary.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId),
    persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
      service.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
    syncOpenCodeRuntimeToolApprovals: (syncInput) =>
      service.toolApprovalFacade.syncOpenCodeRuntimeToolApprovals(syncInput),
    emitTeamChange: (event) => {
      service.teamChangeEmitter?.(event);
    },
  };
}

export function createTeamProvisioningOpenCodeLaunchWiring<Run>(
  host: TeamProvisioningOpenCodeLaunchWiringHost<Run>
): TeamProvisioningOpenCodeLaunchWiring {
  return {
    runOpenCodeWorktreeRootAggregateLaunch: async (input) =>
      runOpenCodeWorktreeRootAggregateLaunch(
        { ...input, adapter: getRequiredOpenCodeRuntimeAdapter(host) },
        {
          randomUUID,
          nowMs: () => Date.now(),
          nowIso,
          getStopAllTeamsGeneration: () => host.getStopAllTeamsGeneration(),
          getRuntimeAdapterRun: (teamName) => host.runtimeAdapterRunByTeam.get(teamName),
          stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
            host.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
          hasSecondaryRuntimeRuns: (teamName) => host.hasSecondaryRuntimeRuns(teamName),
          stopMixedSecondaryRuntimeLanes: (teamName) =>
            host.stopMixedSecondaryRuntimeLanes(teamName),
          cleanupRun: (run) => host.cleanupRun(run as Run),
          getProvisioningRun: (teamName) => host.provisioningRunByTeam.get(teamName),
          getRuntimeAdapterProgress: (runId) => host.runtimeAdapterProgressByRunId.get(runId),
          isCancellableRuntimeAdapterProgress: (progress) =>
            host.isCancellableRuntimeAdapterProgress(progress),
          cancelRuntimeAdapterProvisioning: (runId, progress) =>
            host.cancelRuntimeAdapterProvisioning(runId, progress),
          recordCancelledOpenCodeRuntimeAdapterLaunch: (teamName, sourceWarning, onProgress) =>
            host.recordCancelledOpenCodeRuntimeAdapterLaunch(teamName, sourceWarning, onProgress),
          setProvisioningRun: (teamName, runId) => {
            host.provisioningRunByTeam.set(teamName, runId);
          },
          getRun: (runId) => host.runs.get(runId) as OpenCodeAggregateProvisioningRun | undefined,
          setRuntimeAdapterProgress: (progress, onProgress) =>
            host.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress),
          resetTeamScopedTransientStateForNewRun: (teamName) =>
            host.resetTeamScopedTransientStateForNewRun(teamName),
          readLaunchState: (teamName) => host.readLaunchState(teamName),
          clearPersistedLaunchState: (teamName) => host.clearPersistedLaunchState(teamName),
          setRun: (runId, run) => {
            host.runs.set(runId, run as Run);
          },
          invalidateRuntimeSnapshotCaches: (teamName) =>
            host.invalidateRuntimeSnapshotCaches(teamName),
          launchOpenCodeAggregatePrimaryLane: (nextInput) =>
            host.launchOpenCodeAggregatePrimaryLane({
              ...nextInput,
              run: nextInput.run as Run,
            }),
          launchSingleMixedSecondaryLane: (run, lane) =>
            host.launchSingleMixedSecondaryLane(run as Run, lane),
          publishMixedSecondaryLaneStatusChange: (run, lane) =>
            host.publishMixedSecondaryLaneStatusChange(run as Run, lane),
          getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
            host.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
          getSecondaryRuntimeRun: (teamName, laneId) =>
            host.secondaryRuntimeRunByTeam.get(teamName)?.get(laneId),
          summarizeOpenCodeAggregateLaunchState: (nextInput) =>
            host.summarizeOpenCodeAggregateLaunchState(nextInput),
          persistLaunchStateSnapshot: (run, launchPhase) =>
            host.persistLaunchStateSnapshot(run as Run, launchPhase),
          syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
            host.syncRunMemberSpawnStatusesFromSnapshot(run as Run, snapshot),
          setAliveRunId: (teamName, runId) => {
            host.runTracking.setAliveRunId(teamName, runId);
          },
          deleteAliveRunId: (teamName) => {
            host.runTracking.deleteAliveRunId(teamName);
          },
          deleteRuntimeAdapterRun: (teamName) => {
            host.runtimeAdapterRunByTeam.delete(teamName);
          },
          deleteProvisioningRunIfCurrent: (teamName, runId) => {
            if (host.provisioningRunByTeam.get(teamName) === runId) {
              host.provisioningRunByTeam.delete(teamName);
            }
          },
          emitTeamProcessChange: (event) => host.emitTeamChange(event),
          consumeCancelledRuntimeAdapterRunId: (runId) =>
            host.cancelledRuntimeAdapterRunIds.delete(runId),
          getTeamsBasePath,
          clearOpenCodeRuntimeLaneStorage,
          deleteSecondaryRuntimeRun: (teamName, laneId) =>
            host.deleteSecondaryRuntimeRun(teamName, laneId),
        }
      ),
    runOpenCodeTeamRuntimeAdapterLaunch: async (input) =>
      runOpenCodeTeamRuntimeAdapterLaunch(
        { ...input, adapter: getRequiredOpenCodeRuntimeAdapter(host) },
        {
          randomUUID,
          nowIso,
          getStopAllTeamsGeneration: () => host.getStopAllTeamsGeneration(),
          getRuntimeAdapterRun: (teamName) => host.runtimeAdapterRunByTeam.get(teamName),
          stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
            host.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
          getProvisioningRun: (teamName) => host.provisioningRunByTeam.get(teamName),
          getRuntimeAdapterProgress: (runId) => host.runtimeAdapterProgressByRunId.get(runId),
          isCancellableRuntimeAdapterProgress: (progress) =>
            host.isCancellableRuntimeAdapterProgress(progress),
          cancelRuntimeAdapterProvisioning: (runId, progress) =>
            host.cancelRuntimeAdapterProvisioning(runId, progress),
          recordCancelledOpenCodeRuntimeAdapterLaunch: (teamName, sourceWarning, onProgress) =>
            host.recordCancelledOpenCodeRuntimeAdapterLaunch(teamName, sourceWarning, onProgress),
          setProvisioningRun: (teamName, runId) => {
            host.provisioningRunByTeam.set(teamName, runId);
          },
          setRuntimeAdapterProgress: (progress, onProgress) =>
            host.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress),
          resetTeamScopedTransientStateForNewRun: (teamName) =>
            host.resetTeamScopedTransientStateForNewRun(teamName),
          readLaunchState: (teamName) => host.readLaunchState(teamName),
          clearPersistedLaunchState: (teamName) => host.clearPersistedLaunchState(teamName),
          getTeamsBasePath,
          migrateLegacyOpenCodeRuntimeState,
          upsertOpenCodeRuntimeLaneIndexEntry,
          getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
            host.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
          setOpenCodeRuntimeActiveRunManifest,
          consumeCancelledRuntimeAdapterRunId: (runId) =>
            host.cancelledRuntimeAdapterRunIds.delete(runId),
          clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: (teamName, runId) =>
            host.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId),
          persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
            host.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
          syncOpenCodeRuntimeToolApprovals: (syncInput) =>
            host.syncOpenCodeRuntimeToolApprovals(syncInput),
          clearOpenCodeRuntimeLaneStorage,
          deleteRuntimeAdapterRun: (teamName) => {
            host.runtimeAdapterRunByTeam.delete(teamName);
          },
          setRuntimeAdapterRun: (teamName, runtimeRun) => {
            host.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
          },
          deleteAliveRunId: (teamName) => {
            host.runTracking.deleteAliveRunId(teamName);
          },
          setAliveRunId: (teamName, runId) => {
            host.runTracking.setAliveRunId(teamName, runId);
          },
          invalidateRuntimeSnapshotCaches: (teamName) =>
            host.invalidateRuntimeSnapshotCaches(teamName),
          deleteProvisioningRunIfCurrent: (teamName, runId) => {
            if (host.provisioningRunByTeam.get(teamName) === runId) {
              host.provisioningRunByTeam.delete(teamName);
            }
          },
          emitTeamProcessChange: (event) => host.emitTeamChange(event),
        }
      ),
  };
}
