import {
  buildOpenCodeSecondaryLaneId,
  buildPlannedMemberLaneIdentity,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isLeadMember } from '@shared/utils/leadDetection';
import { randomUUID } from 'crypto';

import {
  clearOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState,
  prepareOpenCodeRuntimeLaneForLaunchGeneration,
  readOpenCodeRuntimeLaneIndex,
  recoverStaleOpenCodeRuntimeLaneIndexEntry,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { snapshotToMemberSpawnStatuses } from '../TeamLaunchStateEvaluator';

import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  launchSingleMixedSecondaryLaneWithPorts,
  type MixedSecondaryLaneLaunchFlowPorts,
  type MixedSecondaryLaneLaunchFlowRun,
} from './TeamProvisioningMixedSecondaryLaneLaunchFlow';
import {
  launchMixedSecondaryLaneIfNeeded as launchMixedSecondaryLaneIfNeededHelper,
  launchQueuedMixedSecondaryLaneInBackground as launchQueuedMixedSecondaryLaneInBackgroundHelper,
  type MixedSecondaryLaunchQueuePorts,
  type MixedSecondaryLaunchQueueRun,
} from './TeamProvisioningMixedSecondaryLaunchQueue';
import {
  buildOpenCodeSecondaryLaneTimingDiagnostic,
  createUnexpectedMixedSecondaryLaneFailureResult,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import {
  type SingleMixedSecondaryRuntimeLaneStopPorts,
  type SingleMixedSecondaryRuntimeLaneStopRun,
  stopSingleMixedSecondaryRuntimeLane as stopSingleMixedSecondaryRuntimeLaneHelper,
} from './TeamProvisioningOpenCodeRuntimeStopFlow';
import {
  createMixedSecondaryLaneStateForMember as createMixedSecondaryLaneStateForMemberFromRun,
  createMixedSecondaryLaneStates as createMixedSecondaryLaneStatesFromPlan,
  getMixedSecondaryLaunchPhase as getMixedSecondaryLaunchPhaseFromRun,
  type MixedSecondaryRuntimeLaneState,
  type SecondaryRuntimeRunProvisioningRun,
} from './TeamProvisioningSecondaryRuntimeRuns';
import {
  recoverStaleMixedSecondaryLaunchSnapshotWithPorts,
  type StaleMixedSecondaryRecoveryPorts,
} from './TeamProvisioningStaleMixedSecondaryRecovery';

import type { TeamRuntimeStopInput } from '../runtime';
import type {
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
} from '@shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

export type TeamProvisioningMixedSecondaryLaneWiringRun = MixedSecondaryLaneLaunchFlowRun &
  MixedSecondaryLaunchQueueRun &
  SingleMixedSecondaryRuntimeLaneStopRun;

type LaunchFlowServicePortKey =
  | 'isStoppingSecondaryRuntimeTeam'
  | 'deleteSecondaryRuntimeRun'
  | 'getOpenCodeRuntimeAdapter'
  | 'publishMixedSecondaryLaneStatusChange'
  | 'readLaunchState'
  | 'setSecondaryRuntimeRun'
  | 'buildOpenCodeSecondaryAppManagedLaunchPrompt'
  | 'guardCommittedOpenCodeSecondaryLaneEvidence'
  | 'syncOpenCodeRuntimeToolApprovals';

type LaunchQueueServicePortKey =
  | 'deleteSecondaryRuntimeRun'
  | 'launchSingleMixedSecondaryLane'
  | 'publishMixedSecondaryLaneStatusChange'
  | 'persistLaunchStateSnapshot'
  | 'readLaunchState'
  | 'getOpenCodeRuntimeAdapter';

type StopServicePortKey =
  | 'getOpenCodeRuntimeAdapter'
  | 'getSecondaryRuntimeRuns'
  | 'readLaunchState'
  | 'deleteSecondaryRuntimeRun';

type StaleRecoveryServicePortKey =
  | 'hasMixedSecondaryLaunchMetadata'
  | 'shouldRecoverStalePersistedMixedLaunchSnapshot'
  | 'readTeamMeta'
  | 'readMembersMeta'
  | 'readPersistedTeamProjectPath'
  | 'tryRecoverMissingOpenCodeSecondaryLaneFromRuntime'
  | 'tryRecoverActiveOpenCodeSecondaryLaneFromRuntime'
  | 'resolveCurrentOpenCodeRuntimeRunId'
  | 'buildAggregateLaunchSnapshot'
  | 'writeLaunchStateSnapshot';

export type TeamProvisioningMixedSecondaryLaneWiringService<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
> = Pick<MixedSecondaryLaneLaunchFlowPorts<TRun>, LaunchFlowServicePortKey> &
  Pick<MixedSecondaryLaunchQueuePorts<TRun>, LaunchQueueServicePortKey> &
  Pick<SingleMixedSecondaryRuntimeLaneStopPorts, StopServicePortKey> &
  Pick<StaleMixedSecondaryRecoveryPorts, StaleRecoveryServicePortKey>;

export interface TeamProvisioningMixedSecondaryLaneWiringDeps<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
> {
  service: TeamProvisioningMixedSecondaryLaneWiringService<TRun>;
  logger: MixedSecondaryLaunchQueuePorts<TRun>['logger'] &
    SingleMixedSecondaryRuntimeLaneStopPorts['logger'];
}

export interface TeamProvisioningMixedSecondaryLaneWiringServiceHost<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
> {
  stoppingSecondaryRuntimeTeams: { has(teamName: string): boolean };
  appShellBoundary: {
    getOpenCodeRuntimeAdapter: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['getOpenCodeRuntimeAdapter'];
  };
  launchStateStore: {
    read: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['readLaunchState'];
  };
  toolApprovalFacade: {
    syncOpenCodeRuntimeToolApprovals: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['syncOpenCodeRuntimeToolApprovals'];
  };
  teamMetaStore: {
    getMeta: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['readTeamMeta'];
  };
  membersMetaStore: {
    getMeta: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['readMembersMeta'];
  };
  openCodeRuntimeRecoveryBoundary: Pick<
    TeamProvisioningMixedSecondaryLaneWiringService<TRun>,
    | 'tryRecoverMissingOpenCodeSecondaryLaneFromRuntime'
    | 'tryRecoverActiveOpenCodeSecondaryLaneFromRuntime'
  >;
  openCodeRuntimeRecoveryIdentity: {
    resolveCurrentOpenCodeRuntimeRunId: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['resolveCurrentOpenCodeRuntimeRunId'];
  };
  runtimeLaneCoordinator: {
    buildAggregateLaunchSnapshot: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['buildAggregateLaunchSnapshot'];
  };
  getSecondaryRuntimeRuns: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['getSecondaryRuntimeRuns'];
  deleteSecondaryRuntimeRun: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['deleteSecondaryRuntimeRun'];
  publishMixedSecondaryLaneStatusChange: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['publishMixedSecondaryLaneStatusChange'];
  setSecondaryRuntimeRun: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['setSecondaryRuntimeRun'];
  buildOpenCodeSecondaryAppManagedLaunchPrompt: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['buildOpenCodeSecondaryAppManagedLaunchPrompt'];
  guardCommittedOpenCodeSecondaryLaneEvidence: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['guardCommittedOpenCodeSecondaryLaneEvidence'];
  launchSingleMixedSecondaryLane: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['launchSingleMixedSecondaryLane'];
  persistLaunchStateSnapshot: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['persistLaunchStateSnapshot'];
  hasMixedSecondaryLaunchMetadata: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['hasMixedSecondaryLaunchMetadata'];
  shouldRecoverStalePersistedMixedLaunchSnapshot: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['shouldRecoverStalePersistedMixedLaunchSnapshot'];
  readPersistedTeamProjectPath: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['readPersistedTeamProjectPath'];
  writeLaunchStateSnapshot: TeamProvisioningMixedSecondaryLaneWiringService<TRun>['writeLaunchStateSnapshot'];
}

export interface TeamProvisioningMixedSecondaryLaneWiringServiceHostOptions<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
> {
  logger: TeamProvisioningMixedSecondaryLaneWiringDeps<TRun>['logger'];
}

export interface TeamProvisioningMixedSecondaryLaneWiring<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
> {
  createMixedSecondaryLaneStates(plan: TeamRuntimeLanePlan): MixedSecondaryRuntimeLaneState[];
  createMixedSecondaryLaneStateForMember(
    run: Pick<SecondaryRuntimeRunProvisioningRun, 'request' | 'mixedSecondaryLanes'>,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState;
  getMixedSecondaryLaunchPhase(
    run: Pick<SecondaryRuntimeRunProvisioningRun, 'mixedSecondaryLanes'>
  ): PersistedTeamLaunchPhase;
  launchSingleMixedSecondaryLane(run: TRun, lane: MixedSecondaryRuntimeLaneState): Promise<void>;
  stopSingleMixedSecondaryRuntimeLane(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState,
    reason: TeamRuntimeStopInput['reason']
  ): Promise<void>;
  launchQueuedMixedSecondaryLaneInBackground(run: TRun, lane: MixedSecondaryRuntimeLaneState): void;
  launchMixedSecondaryLaneIfNeeded(
    run: TRun,
    options?: { waitForCompletion?: boolean }
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  recoverStaleMixedSecondaryLaunchSnapshot(
    teamName: string,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    persistedSnapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null>;
}

export function createMixedSecondaryLaneLaunchFlowPorts<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
>(
  deps: TeamProvisioningMixedSecondaryLaneWiringDeps<TRun>
): MixedSecondaryLaneLaunchFlowPorts<TRun> {
  return {
    nowMs: () => Date.now(),
    randomUuid: () => randomUUID(),
    teamsBasePath: () => getTeamsBasePath(),
    isStoppingSecondaryRuntimeTeam: (teamName) =>
      deps.service.isStoppingSecondaryRuntimeTeam(teamName),
    clearOpenCodeRuntimeLaneStorage,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      deps.service.deleteSecondaryRuntimeRun(teamName, laneId),
    getOpenCodeRuntimeAdapter: () => deps.service.getOpenCodeRuntimeAdapter(),
    migrateLegacyOpenCodeRuntimeState,
    upsertOpenCodeRuntimeLaneIndexEntry,
    buildOpenCodeSecondaryLaneTimingDiagnostic,
    publishMixedSecondaryLaneStatusChange: (run, lane) =>
      deps.service.publishMixedSecondaryLaneStatusChange(run, lane),
    readLaunchState: (teamName) => deps.service.readLaunchState(teamName),
    setSecondaryRuntimeRun: (input) => deps.service.setSecondaryRuntimeRun(input),
    prepareOpenCodeRuntimeLaneForLaunchGeneration,
    buildOpenCodeSecondaryAppManagedLaunchPrompt: (run, lane) =>
      deps.service.buildOpenCodeSecondaryAppManagedLaunchPrompt(run, lane),
    guardCommittedOpenCodeSecondaryLaneEvidence: (input) =>
      deps.service.guardCommittedOpenCodeSecondaryLaneEvidence(input),
    syncOpenCodeRuntimeToolApprovals: (input) =>
      deps.service.syncOpenCodeRuntimeToolApprovals(input),
  };
}

export function createSingleMixedSecondaryRuntimeLaneStopPorts<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
>(
  deps: TeamProvisioningMixedSecondaryLaneWiringDeps<TRun>
): SingleMixedSecondaryRuntimeLaneStopPorts {
  return {
    teamsBasePath: getTeamsBasePath(),
    getSecondaryRuntimeRuns: (teamName) => deps.service.getSecondaryRuntimeRuns(teamName),
    getOpenCodeRuntimeAdapter: () => deps.service.getOpenCodeRuntimeAdapter(),
    readLaunchState: (teamName) => deps.service.readLaunchState(teamName),
    upsertOpenCodeRuntimeLaneIndexEntry,
    clearOpenCodeRuntimeLaneStorage,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      deps.service.deleteSecondaryRuntimeRun(teamName, laneId),
    logger: deps.logger,
  };
}

export function createMixedSecondaryLaunchQueuePorts<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
>(deps: TeamProvisioningMixedSecondaryLaneWiringDeps<TRun>): MixedSecondaryLaunchQueuePorts<TRun> {
  return {
    nowMs: () => Date.now(),
    randomUuid: () => randomUUID(),
    teamsBasePath: () => getTeamsBasePath(),
    clearOpenCodeRuntimeLaneStorage,
    upsertOpenCodeRuntimeLaneIndexEntry,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      deps.service.deleteSecondaryRuntimeRun(teamName, laneId),
    launchSingleMixedSecondaryLane: (run, lane) =>
      deps.service.launchSingleMixedSecondaryLane(run, lane),
    publishMixedSecondaryLaneStatusChange: (run, lane) =>
      deps.service.publishMixedSecondaryLaneStatusChange(run, lane),
    persistLaunchStateSnapshot: (run, launchPhase) =>
      deps.service.persistLaunchStateSnapshot(run, launchPhase),
    readLaunchState: (teamName) => deps.service.readLaunchState(teamName),
    getOpenCodeRuntimeAdapter: () => deps.service.getOpenCodeRuntimeAdapter(),
    getMixedSecondaryLaunchPhase: (run) => getMixedSecondaryLaunchPhaseFromRun(run),
    createUnexpectedMixedSecondaryLaneFailureResult,
    logger: deps.logger,
  };
}

export function createStaleMixedSecondaryRecoveryPorts<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
>(deps: TeamProvisioningMixedSecondaryLaneWiringDeps<TRun>): StaleMixedSecondaryRecoveryPorts {
  return {
    hasMixedSecondaryLaunchMetadata: (snapshot) =>
      deps.service.hasMixedSecondaryLaunchMetadata(snapshot),
    shouldRecoverStalePersistedMixedLaunchSnapshot: (snapshot) =>
      deps.service.shouldRecoverStalePersistedMixedLaunchSnapshot(snapshot),
    readTeamMeta: (teamName) => deps.service.readTeamMeta(teamName),
    readMembersMeta: (teamName) => deps.service.readMembersMeta(teamName),
    readPersistedTeamProjectPath: (teamName) => deps.service.readPersistedTeamProjectPath(teamName),
    readOpenCodeRuntimeLaneIndex,
    buildPlannedMemberLaneIdentity,
    buildOpenCodeSecondaryLaneId,
    snapshotToMemberSpawnStatuses,
    createInitialMemberSpawnStatusEntry,
    isLeadMember,
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: (input) =>
      deps.service.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(input),
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (input) =>
      deps.service.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(input),
    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      deps.service.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    recoverStaleOpenCodeRuntimeLaneIndexEntry,
    nowIso,
    getTeamsBasePath,
    buildAggregateLaunchSnapshot: (input) => deps.service.buildAggregateLaunchSnapshot(input),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      deps.service.writeLaunchStateSnapshot(teamName, snapshot),
  };
}

export function createTeamProvisioningMixedSecondaryLaneWiringDepsFromService<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
>(
  service: TeamProvisioningMixedSecondaryLaneWiringServiceHost<TRun>,
  options: TeamProvisioningMixedSecondaryLaneWiringServiceHostOptions<TRun>
): TeamProvisioningMixedSecondaryLaneWiringDeps<TRun> {
  return {
    service: {
      isStoppingSecondaryRuntimeTeam: (teamName) =>
        service.stoppingSecondaryRuntimeTeams.has(teamName),
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        service.deleteSecondaryRuntimeRun(teamName, laneId),
      getOpenCodeRuntimeAdapter: () => service.appShellBoundary.getOpenCodeRuntimeAdapter(),
      getSecondaryRuntimeRuns: (teamName) => service.getSecondaryRuntimeRuns(teamName),
      publishMixedSecondaryLaneStatusChange: (run, lane) =>
        service.publishMixedSecondaryLaneStatusChange(run, lane),
      readLaunchState: (teamName) => service.launchStateStore.read(teamName),
      setSecondaryRuntimeRun: (input) => service.setSecondaryRuntimeRun(input),
      buildOpenCodeSecondaryAppManagedLaunchPrompt: (run, lane) =>
        service.buildOpenCodeSecondaryAppManagedLaunchPrompt(run, lane),
      guardCommittedOpenCodeSecondaryLaneEvidence: (input) =>
        service.guardCommittedOpenCodeSecondaryLaneEvidence(input),
      syncOpenCodeRuntimeToolApprovals: (input) =>
        service.toolApprovalFacade.syncOpenCodeRuntimeToolApprovals(input),
      launchSingleMixedSecondaryLane: (run, lane) =>
        service.launchSingleMixedSecondaryLane(run, lane),
      persistLaunchStateSnapshot: (run, launchPhase) =>
        service.persistLaunchStateSnapshot(run, launchPhase),
      hasMixedSecondaryLaunchMetadata: (snapshot) =>
        service.hasMixedSecondaryLaunchMetadata(snapshot),
      shouldRecoverStalePersistedMixedLaunchSnapshot: (snapshot) =>
        service.shouldRecoverStalePersistedMixedLaunchSnapshot(snapshot),
      readTeamMeta: (teamName) => service.teamMetaStore.getMeta(teamName),
      readMembersMeta: (teamName) => service.membersMetaStore.getMeta(teamName),
      readPersistedTeamProjectPath: (teamName) => service.readPersistedTeamProjectPath(teamName),
      tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: (input) =>
        service.openCodeRuntimeRecoveryBoundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(
          input
        ),
      tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (input) =>
        service.openCodeRuntimeRecoveryBoundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(
          input
        ),
      resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        service.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
          teamName,
          laneId
        ),
      buildAggregateLaunchSnapshot: (input) =>
        service.runtimeLaneCoordinator.buildAggregateLaunchSnapshot(input),
      writeLaunchStateSnapshot: (teamName, snapshot) =>
        service.writeLaunchStateSnapshot(teamName, snapshot),
    },
    logger: options.logger,
  };
}

export function createTeamProvisioningMixedSecondaryLaneWiring<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
>(
  deps: TeamProvisioningMixedSecondaryLaneWiringDeps<TRun>
): TeamProvisioningMixedSecondaryLaneWiring<TRun> {
  return {
    createMixedSecondaryLaneStates: (plan) => createMixedSecondaryLaneStatesFromPlan(plan),
    createMixedSecondaryLaneStateForMember: (run, member) =>
      createMixedSecondaryLaneStateForMemberFromRun(run, member),
    getMixedSecondaryLaunchPhase: (run) => getMixedSecondaryLaunchPhaseFromRun(run),
    launchSingleMixedSecondaryLane: (run, lane) =>
      launchSingleMixedSecondaryLaneWithPorts(
        run,
        lane,
        createMixedSecondaryLaneLaunchFlowPorts(deps)
      ),
    stopSingleMixedSecondaryRuntimeLane: (run, lane, reason) =>
      stopSingleMixedSecondaryRuntimeLaneHelper(
        run,
        lane,
        reason,
        createSingleMixedSecondaryRuntimeLaneStopPorts(deps)
      ),
    launchQueuedMixedSecondaryLaneInBackground: (run, lane) =>
      launchQueuedMixedSecondaryLaneInBackgroundHelper(
        run,
        lane,
        createMixedSecondaryLaunchQueuePorts(deps)
      ),
    launchMixedSecondaryLaneIfNeeded: (run, options) =>
      launchMixedSecondaryLaneIfNeededHelper(
        run,
        createMixedSecondaryLaunchQueuePorts(deps),
        options
      ),
    recoverStaleMixedSecondaryLaunchSnapshot: (teamName, bootstrapSnapshot, persistedSnapshot) =>
      recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
        teamName,
        bootstrapSnapshot,
        persistedSnapshot,
        createStaleMixedSecondaryRecoveryPorts(deps)
      ),
  };
}
