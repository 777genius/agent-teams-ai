import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { randomUUID } from 'crypto';

import {
  clearOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import {
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
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
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

function getRequiredOpenCodeRuntimeAdapter(host: {
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
}): TeamLaunchRuntimeAdapter {
  const adapter = host.getOpenCodeRuntimeAdapter();
  if (!adapter) {
    throw new Error('OpenCode runtime adapter is not registered');
  }
  return adapter;
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
          nowIso,
          getStopAllTeamsGeneration: () => host.getStopAllTeamsGeneration(),
          getRuntimeAdapterRun: (teamName) => host.runtimeAdapterRunByTeam.get(teamName),
          stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
            host.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
          hasSecondaryRuntimeRuns: (teamName) => host.hasSecondaryRuntimeRuns(teamName),
          stopMixedSecondaryRuntimeLanes: (teamName) =>
            host.stopMixedSecondaryRuntimeLanes(teamName),
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
