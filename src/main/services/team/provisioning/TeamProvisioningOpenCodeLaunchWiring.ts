import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
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
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
  findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence,
  requireAnsweredOpenCodeCommittedBootstrapSessionEvidence,
} from './TeamProvisioningOpenCodeBootstrapEvidence';
import { createOpenCodeLaunchFailureArtifactAdapter } from './TeamProvisioningOpenCodeLaunchFailureArtifact';
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
import type { OpenCodeAggregateLaunchPromptPorts } from './TeamProvisioningOpenCodeAggregateLaunchPrompt';
import type { OpenCodeSharedRuntimeFailureScope } from './TeamProvisioningOpenCodeSharedRuntimeFailurePolicy';
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

const logger = createLogger('Service:TeamProvisioning');

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The lead's committed session record, read from disk exactly the way the
 * delivery path will read it later. This is the launch-time half of the lead
 * veto; the caller treats a throw as "cannot disprove", never as failure.
 *
 * Deliberately NOT `hasDeliverableOpenCodeRuntimeBootstrapSessionEvidence`: that
 * helper swallows the store read and answers `false`, which the veto reads as
 * PROOF that no session exists. A concurrent bootstrap check-in holding the
 * manifest lock - the exact contention this gate races - would then tear a
 * healthy team down. The read must reject so the caller can map it to "cannot
 * disprove", which is why an unanswered store is raised here rather than
 * matched against: the reader reports one as an empty session list.
 */
async function hasCommittedOpenCodePrimaryLeadSessionEvidence(input: {
  teamName: string;
  runId: string;
  laneId: string;
  memberName: string;
}): Promise<boolean> {
  const ports = createDefaultOpenCodeRuntimeBootstrapEvidencePorts({
    teamsBasePath: getTeamsBasePath(),
    warn: (message) => logger.diagnostic(message),
  });
  const evidence = requireAnsweredOpenCodeCommittedBootstrapSessionEvidence(
    await ports.readCommittedBootstrapSessionEvidence({
      teamsBasePath: ports.teamsBasePath,
      teamName: input.teamName,
      laneId: input.laneId,
    })
  );
  return (
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence(evidence, input) !=
    null
  );
}

export interface OpenCodeLaunchWiringRuntimeRunEntry {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  allowExperimentalLocalModels?: boolean;
  members?: TeamRuntimeLaunchResult['members'];
}

export interface TeamProvisioningOpenCodeLaunchWiringHost<Run> {
  runtimeAdapterRunByTeam: Map<string, OpenCodeLaunchWiringRuntimeRunEntry>;
  provisioningRunByTeam: Map<string, string>;
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  cancelledRuntimeAdapterRunIds: Set<string>;
  runs: Map<string, Run>;
  secondaryRuntimeRunByTeam: Map<string, Map<string, SecondaryRuntimeRunEntry>>;
  runtimeAdapterProgressState: {
    setRuntimeAdapterProgress(
      progress: TeamProvisioningProgress,
      onProgress?: (progress: TeamProvisioningProgress) => void
    ): TeamProvisioningProgress;
    getRuntimeAdapterTraceLines(runId: string): readonly string[] | undefined;
  };
  runTracking: {
    setAliveRunId(teamName: string, runId: string): void;
    getAliveRunId(teamName: string): string | null;
    deleteAliveRunId(teamName: string): void;
  };
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  getStopAllTeamsGeneration(): number;
  getStopTeamGeneration(teamName: string): number;
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
  clearPersistedLaunchState(teamName: string, options?: { expectedRunId?: string }): Promise<void>;
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
  ): Promise<{ result: TeamRuntimeLaunchResult; snapshot?: PersistedTeamLaunchSnapshot }>;
  deliverOpenCodeLaunchPromptToLead: OpenCodeAggregateLaunchPromptPorts['deliverOpenCodeLaunchPromptToLead'];
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
  getStopTeamGeneration(teamName: string): number;
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
  > & {
    stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(
      teamName: string,
      runId: string
    ): Promise<boolean>;
  };
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
  deliverOpenCodeLaunchPromptToLead: TeamProvisioningOpenCodeLaunchWiringHost<Run>['deliverOpenCodeLaunchPromptToLead'];
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
    getStopTeamGeneration: (teamName) => service.getStopTeamGeneration(teamName),
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
    clearPersistedLaunchState: (teamName, options) =>
      options === undefined
        ? service.clearPersistedLaunchState(teamName)
        : service.clearPersistedLaunchState(teamName, options),
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
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: async (teamName, runId) => {
      await service.cancellationBoundary.stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(
        teamName,
        runId
      );
    },
    persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
      service.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
    deliverOpenCodeLaunchPromptToLead: (promptInput) =>
      service.deliverOpenCodeLaunchPromptToLead(promptInput),
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
  // One OpenCode host serves every launch of a project, so the shared-runtime
  // records outlive a single team launch: a relaunch that hits the same timeout
  // inside the TTL window must not spend a second retry.
  const sharedRuntimeFailureScope: OpenCodeSharedRuntimeFailureScope = {};
  const launchFailureArtifacts = createOpenCodeLaunchFailureArtifactAdapter({
    getRuntimeAdapterTraceLines: (runId) =>
      host.runtimeAdapterProgressState.getRuntimeAdapterTraceLines(runId),
  });
  return {
    runOpenCodeWorktreeRootAggregateLaunch: async (input) =>
      runOpenCodeWorktreeRootAggregateLaunch(
        { ...input, adapter: getRequiredOpenCodeRuntimeAdapter(host) },
        {
          randomUUID,
          nowMs: () => Date.now(),
          nowIso,
          // error, not warn: the default logger hides warn in production, and a
          // rollback that could not confirm a stop is exactly what a user needs
          // the cause of.
          logError: (message) => logger.error(message),
          getStopAllTeamsGeneration: () => host.getStopAllTeamsGeneration(),
          getStopTeamGeneration: (teamName) => host.getStopTeamGeneration(teamName),
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
          clearPersistedLaunchState: (teamName, options) =>
            host.clearPersistedLaunchState(teamName, options),
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
          deliverOpenCodeLaunchPromptToLead: (promptInput) =>
            host.deliverOpenCodeLaunchPromptToLead(promptInput),
          setAliveRunId: (teamName, runId) => {
            host.runTracking.setAliveRunId(teamName, runId);
          },
          setRuntimeAdapterRun: (teamName, runtimeRun) => {
            host.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
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
          setSecondaryRuntimeRun: (runtimeRun) => {
            const lanes =
              host.secondaryRuntimeRunByTeam.get(runtimeRun.teamName) ??
              new Map<string, SecondaryRuntimeRunEntry>();
            lanes.set(runtimeRun.laneId, runtimeRun);
            host.secondaryRuntimeRunByTeam.set(runtimeRun.teamName, lanes);
          },
          deleteSecondaryRuntimeRun: (teamName, laneId) =>
            host.deleteSecondaryRuntimeRun(teamName, laneId),
          hasCommittedOpenCodePrimaryLeadSessionEvidence,
          logDiagnostic: (message) => logger.diagnostic(message),
        }
      ),
    runOpenCodeTeamRuntimeAdapterLaunch: async (input) =>
      runOpenCodeTeamRuntimeAdapterLaunch(
        { ...input, adapter: getRequiredOpenCodeRuntimeAdapter(host) },
        {
          randomUUID,
          nowIso,
          nowMs: () => Date.now(),
          sharedRuntimeFailureScope,
          logWarning: (message) => logger.warn(message),
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
          clearPersistedLaunchState: (teamName, options) =>
            options === undefined
              ? host.clearPersistedLaunchState(teamName)
              : host.clearPersistedLaunchState(teamName, options),
          getTeamsBasePath,
          migrateLegacyOpenCodeRuntimeState,
          upsertOpenCodeRuntimeLaneIndexEntry,
          getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
            host.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
          setOpenCodeRuntimeActiveRunManifest,
          isCancelledRuntimeAdapterRunId: (runId) => host.cancelledRuntimeAdapterRunIds.has(runId),
          consumeCancelledRuntimeAdapterRunId: (runId) =>
            host.cancelledRuntimeAdapterRunIds.delete(runId),
          clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: (teamName, runId) =>
            host.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId),
          persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
            host.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
          launchFailureArtifacts,
          syncOpenCodeRuntimeToolApprovals: (syncInput) =>
            host.syncOpenCodeRuntimeToolApprovals(syncInput),
          clearOpenCodeRuntimeLaneStorage,
          deleteRuntimeOwnershipIfCurrent: (teamName, runId) => {
            if (host.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
              host.runtimeAdapterRunByTeam.delete(teamName);
            }
            if (host.runTracking.getAliveRunId(teamName) === runId) {
              host.runTracking.deleteAliveRunId(teamName);
            }
          },
          setRuntimeAdapterRun: (teamName, runtimeRun) => {
            host.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
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
