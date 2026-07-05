import {
  buildOpenCodeSecondaryLaneId,
  buildPlannedMemberLaneIdentity,
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
  recoverStaleMixedSecondaryLaunchSnapshotWithPorts,
  type StaleMixedSecondaryRecoveryPorts,
} from './TeamProvisioningStaleMixedSecondaryRecovery';

import type { TeamRuntimeStopInput } from '../runtime';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

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
  | 'getOpenCodeRuntimeAdapter'
  | 'getMixedSecondaryLaunchPhase';

type StopServicePortKey =
  | 'getOpenCodeRuntimeAdapter'
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

export interface TeamProvisioningMixedSecondaryLaneWiring<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
> {
  launchSingleMixedSecondaryLane(run: TRun, lane: MixedSecondaryRuntimeLaneState): Promise<void>;
  stopSingleMixedSecondaryRuntimeLane(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState,
    reason: TeamRuntimeStopInput['reason']
  ): Promise<void>;
  launchQueuedMixedSecondaryLaneInBackground(run: TRun, lane: MixedSecondaryRuntimeLaneState): void;
  launchMixedSecondaryLaneIfNeeded(run: TRun): Promise<PersistedTeamLaunchSnapshot | null>;
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
    getMixedSecondaryLaunchPhase: (run) => deps.service.getMixedSecondaryLaunchPhase(run),
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

export function createTeamProvisioningMixedSecondaryLaneWiring<
  TRun extends TeamProvisioningMixedSecondaryLaneWiringRun,
>(
  deps: TeamProvisioningMixedSecondaryLaneWiringDeps<TRun>
): TeamProvisioningMixedSecondaryLaneWiring<TRun> {
  return {
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
    launchMixedSecondaryLaneIfNeeded: (run) =>
      launchMixedSecondaryLaneIfNeededHelper(run, createMixedSecondaryLaunchQueuePorts(deps)),
    recoverStaleMixedSecondaryLaunchSnapshot: (teamName, bootstrapSnapshot, persistedSnapshot) =>
      recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
        teamName,
        bootstrapSnapshot,
        persistedSnapshot,
        createStaleMixedSecondaryRecoveryPorts(deps)
      ),
  };
}
