import { type OpenCodeRuntimeCheckinRun } from './TeamProvisioningOpenCodeRuntimeCheckin';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundary,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts,
} from './TeamProvisioningOpenCodeRuntimeDelivery';

import type { PersistedTeamLaunchPhase } from '@shared/types';

type DeliveryBoundaryPorts<Run extends OpenCodeRuntimeCheckinRun> =
  TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<Run>;

export type TeamProvisioningOpenCodeRuntimeDeliveryBoundary<Run extends OpenCodeRuntimeCheckinRun> =
  ReturnType<typeof createTeamProvisioningOpenCodeRuntimeDeliveryBoundary<Run>>;

export interface TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<
  Run extends OpenCodeRuntimeCheckinRun,
> {
  getTeamsBasePath: DeliveryBoundaryPorts<Run>['getTeamsBasePath'];
  resolveOpenCodeRuntimeLaneId: DeliveryBoundaryPorts<Run>['resolveOpenCodeRuntimeLaneId'];
  resolveCurrentOpenCodeRuntimeRunId: DeliveryBoundaryPorts<Run>['resolveCurrentOpenCodeRuntimeRunId'];
  readLaunchState: DeliveryBoundaryPorts<Run>['readLaunchState'];
  writeLaunchStateSnapshot: DeliveryBoundaryPorts<Run>['writeLaunchState'];
  readConfigForStrictDecision: DeliveryBoundaryPorts<Run>['readConfigForStrictDecision'];
  readMetaMembers: DeliveryBoundaryPorts<Run>['readMetaMembers'];
  readPersistedRuntimeMembers: DeliveryBoundaryPorts<Run>['readPersistedRuntimeMembers'];
  getTrackedRunId(teamName: string): string | null | undefined;
  getRun(runId: string): Run | null | undefined;
  persistLaunchStateSnapshot(run: Run, launchPhase: PersistedTeamLaunchPhase): Promise<unknown>;
  getMixedSecondaryLaunchPhase(run: Run): PersistedTeamLaunchPhase;
  invalidateRuntimeSnapshotCaches: DeliveryBoundaryPorts<Run>['invalidateRuntimeSnapshotCaches'];
  emitMemberSpawnChange: DeliveryBoundaryPorts<Run>['emitMemberSpawnChange'];
  emitTeamChange: DeliveryBoundaryPorts<Run>['emitTeamChange'];
  createOpenCodeRuntimeBootstrapEvidencePorts: DeliveryBoundaryPorts<Run>['createOpenCodeRuntimeBootstrapEvidencePorts'];
  upsertOpenCodeTaskRecord: DeliveryBoundaryPorts<Run>['upsertOpenCodeTaskRecord'];
  syncMemberTaskActivityForRuntimeTransition: DeliveryBoundaryPorts<Run>['syncMemberTaskActivityForRuntimeTransition'];
  syncMemberLaunchGraceCheck: DeliveryBoundaryPorts<Run>['syncMemberLaunchGraceCheck'];
  sentMessagesStore: DeliveryBoundaryPorts<Run>['sentMessagesStore'];
  inboxReader: DeliveryBoundaryPorts<Run>['inboxReader'];
  inboxWriter: DeliveryBoundaryPorts<Run>['inboxWriter'];
  getCrossTeamSender: DeliveryBoundaryPorts<Run>['getCrossTeamSender'];
  isOpenCodeRuntimeRecipient: DeliveryBoundaryPorts<Run>['isOpenCodeRuntimeRecipient'];
  getOpenCodeAgendaSyncRecoveryBypassMessageIds: DeliveryBoundaryPorts<Run>['getOpenCodeAgendaSyncRecoveryBypassMessageIds'];
  resolveOpenCodeMemberDeliveryIdentity: DeliveryBoundaryPorts<Run>['resolveOpenCodeMemberDeliveryIdentity'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive'];
  decideOpenCodeRuntimeDeliveryUserFacingAdvisory: DeliveryBoundaryPorts<Run>['decideOpenCodeRuntimeDeliveryUserFacingAdvisory'];
  isOpenCodePromptDeliveryWatchdogEnabled: DeliveryBoundaryPorts<Run>['isOpenCodePromptDeliveryWatchdogEnabled'];
  scheduleOpenCodePromptDeliveryWatchdog: DeliveryBoundaryPorts<Run>['scheduleOpenCodePromptDeliveryWatchdog'];
  nowIso: DeliveryBoundaryPorts<Run>['nowIso'];
  logger: DeliveryBoundaryPorts<Run>['logger'];
}

export interface TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryDeps<
  Run extends OpenCodeRuntimeCheckinRun,
> {
  getTeamsBasePath: DeliveryBoundaryPorts<Run>['getTeamsBasePath'];
  nowIso: DeliveryBoundaryPorts<Run>['nowIso'];
  logger: DeliveryBoundaryPorts<Run>['logger'];
}

export interface TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<
  Run extends OpenCodeRuntimeCheckinRun,
> {
  resolveOpenCodeRuntimeLaneId: DeliveryBoundaryPorts<Run>['resolveOpenCodeRuntimeLaneId'];
  openCodeRuntimeRecoveryIdentity: {
    resolveCurrentOpenCodeRuntimeRunId: DeliveryBoundaryPorts<Run>['resolveCurrentOpenCodeRuntimeRunId'];
    resolveOpenCodeMemberDeliveryIdentity: DeliveryBoundaryPorts<Run>['resolveOpenCodeMemberDeliveryIdentity'];
  };
  launchStateStore: {
    read: DeliveryBoundaryPorts<Run>['readLaunchState'];
  };
  writeLaunchStateSnapshot: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['writeLaunchStateSnapshot'];
  readConfigForStrictDecision: DeliveryBoundaryPorts<Run>['readConfigForStrictDecision'];
  membersMetaStore: {
    getMembers: DeliveryBoundaryPorts<Run>['readMetaMembers'];
  };
  readPersistedRuntimeMembers: DeliveryBoundaryPorts<Run>['readPersistedRuntimeMembers'];
  runTracking: {
    getTrackedRunId: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['getTrackedRunId'];
  };
  runs: {
    get(runId: string): Run | undefined;
  };
  persistLaunchStateSnapshot: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['persistLaunchStateSnapshot'];
  getMixedSecondaryLaunchPhase: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['getMixedSecondaryLaunchPhase'];
  invalidateRuntimeSnapshotCaches: DeliveryBoundaryPorts<Run>['invalidateRuntimeSnapshotCaches'];
  emitMemberSpawnChange: DeliveryBoundaryPorts<Run>['emitMemberSpawnChange'];
  teamChangeEmitter: DeliveryBoundaryPorts<Run>['emitTeamChange'] | null;
  createOpenCodeRuntimeBootstrapEvidencePorts: DeliveryBoundaryPorts<Run>['createOpenCodeRuntimeBootstrapEvidencePorts'];
  openCodeTaskLogAttributionStore: {
    upsertTaskRecord: DeliveryBoundaryPorts<Run>['upsertOpenCodeTaskRecord'];
  };
  syncMemberTaskActivityForRuntimeTransition: DeliveryBoundaryPorts<Run>['syncMemberTaskActivityForRuntimeTransition'];
  syncMemberLaunchGraceCheck: DeliveryBoundaryPorts<Run>['syncMemberLaunchGraceCheck'];
  sentMessagesStore: DeliveryBoundaryPorts<Run>['sentMessagesStore'];
  inboxReader: DeliveryBoundaryPorts<Run>['inboxReader'];
  inboxWriter: DeliveryBoundaryPorts<Run>['inboxWriter'];
  crossTeamSender: ReturnType<DeliveryBoundaryPorts<Run>['getCrossTeamSender']>;
  isOpenCodeRuntimeRecipient: DeliveryBoundaryPorts<Run>['isOpenCodeRuntimeRecipient'];
  getOpenCodeAgendaSyncRecoveryBypassMessageIds: DeliveryBoundaryPorts<Run>['getOpenCodeAgendaSyncRecoveryBypassMessageIds'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive'];
  decideOpenCodeRuntimeDeliveryUserFacingAdvisory: DeliveryBoundaryPorts<Run>['decideOpenCodeRuntimeDeliveryUserFacingAdvisory'];
  openCodePromptDeliveryWatchdogScheduler: {
    isEnabled(): boolean;
  };
  scheduleOpenCodePromptDeliveryWatchdog: DeliveryBoundaryPorts<Run>['scheduleOpenCodePromptDeliveryWatchdog'];
}

export function createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  host: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>,
  deps: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryDeps<Run>
): TeamProvisioningOpenCodeRuntimeDeliveryBoundary<Run> {
  return createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromPorts<Run>({
    getTeamsBasePath: deps.getTeamsBasePath,
    resolveOpenCodeRuntimeLaneId: (input) => host.resolveOpenCodeRuntimeLaneId(input),
    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      host.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    readLaunchState: (teamName) => host.launchStateStore.read(teamName),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      host.writeLaunchStateSnapshot(teamName, snapshot),
    readConfigForStrictDecision: (teamName) => host.readConfigForStrictDecision(teamName),
    readMetaMembers: (teamName) => host.membersMetaStore.getMembers(teamName),
    readPersistedRuntimeMembers: (teamName) => host.readPersistedRuntimeMembers(teamName),
    getTrackedRunId: (teamName) => host.runTracking.getTrackedRunId(teamName),
    getRun: (runId) => host.runs.get(runId),
    persistLaunchStateSnapshot: (run, launchPhase) =>
      host.persistLaunchStateSnapshot(run, launchPhase),
    getMixedSecondaryLaunchPhase: (run) => host.getMixedSecondaryLaunchPhase(run),
    invalidateRuntimeSnapshotCaches: (teamName) => host.invalidateRuntimeSnapshotCaches(teamName),
    emitMemberSpawnChange: (run, memberName) => host.emitMemberSpawnChange(run, memberName),
    emitTeamChange: (event) => host.teamChangeEmitter?.(event),
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      host.createOpenCodeRuntimeBootstrapEvidencePorts(),
    upsertOpenCodeTaskRecord: (teamName, record) =>
      host.openCodeTaskLogAttributionStore.upsertTaskRecord(teamName, record),
    syncMemberTaskActivityForRuntimeTransition: (
      run,
      memberName,
      previousStatus,
      nextStatus,
      observedAt
    ) =>
      host.syncMemberTaskActivityForRuntimeTransition(
        run,
        memberName,
        previousStatus,
        nextStatus,
        observedAt
      ),
    syncMemberLaunchGraceCheck: (run, memberName, nextStatus) =>
      host.syncMemberLaunchGraceCheck(run, memberName, nextStatus),
    sentMessagesStore: host.sentMessagesStore,
    inboxReader: host.inboxReader,
    inboxWriter: host.inboxWriter,
    getCrossTeamSender: () => host.crossTeamSender,
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      host.isOpenCodeRuntimeRecipient(teamName, memberName),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: (bypassInput) =>
      host.getOpenCodeAgendaSyncRecoveryBypassMessageIds(bypassInput),
    resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
      host.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
        teamName,
        memberName
      ),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoverInput) =>
      host.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoverInput),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: (record) =>
      host.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record),
    isOpenCodePromptDeliveryWatchdogEnabled: () =>
      host.openCodePromptDeliveryWatchdogScheduler.isEnabled(),
    scheduleOpenCodePromptDeliveryWatchdog: (watchdogInput) =>
      host.scheduleOpenCodePromptDeliveryWatchdog(watchdogInput),
    nowIso: deps.nowIso,
    logger: deps.logger,
  });
}

export function createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromPorts<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  ports: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>
): TeamProvisioningOpenCodeRuntimeDeliveryBoundary<Run> {
  return createTeamProvisioningOpenCodeRuntimeDeliveryBoundary<Run>({
    getTeamsBasePath: ports.getTeamsBasePath,
    resolveOpenCodeRuntimeLaneId: (input) => ports.resolveOpenCodeRuntimeLaneId(input),
    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      ports.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    readLaunchState: (teamName) => ports.readLaunchState(teamName),
    writeLaunchState: async (teamName, snapshot) => {
      await ports.writeLaunchStateSnapshot(teamName, snapshot);
    },
    readConfigForStrictDecision: (teamName) => ports.readConfigForStrictDecision(teamName),
    readMetaMembers: (teamName) => ports.readMetaMembers(teamName),
    readPersistedRuntimeMembers: (teamName) => ports.readPersistedRuntimeMembers(teamName),
    getTrackedRun: (teamName) => {
      const trackedRunId = ports.getTrackedRunId(teamName);
      return trackedRunId ? (ports.getRun(trackedRunId) ?? null) : null;
    },
    persistTrackedRunLaunchState: async (run) => {
      await ports.persistLaunchStateSnapshot(run, ports.getMixedSecondaryLaunchPhase(run));
    },
    invalidateRuntimeSnapshotCaches: (teamName) => ports.invalidateRuntimeSnapshotCaches(teamName),
    emitMemberSpawnChange: (run, memberName) => ports.emitMemberSpawnChange(run, memberName),
    emitTeamChange: (event) => ports.emitTeamChange(event),
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      ports.createOpenCodeRuntimeBootstrapEvidencePorts(),
    upsertOpenCodeTaskRecord: (teamName, record) =>
      ports.upsertOpenCodeTaskRecord(teamName, record),
    syncMemberTaskActivityForRuntimeTransition: (
      run,
      memberName,
      previousStatus,
      nextStatus,
      observedAt
    ) =>
      ports.syncMemberTaskActivityForRuntimeTransition(
        run,
        memberName,
        previousStatus,
        nextStatus,
        observedAt
      ),
    syncMemberLaunchGraceCheck: (run, memberName, nextStatus) =>
      ports.syncMemberLaunchGraceCheck(run, memberName, nextStatus),
    sentMessagesStore: ports.sentMessagesStore,
    inboxReader: ports.inboxReader,
    inboxWriter: ports.inboxWriter,
    getCrossTeamSender: () => ports.getCrossTeamSender(),
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      ports.isOpenCodeRuntimeRecipient(teamName, memberName),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: (bypassInput) =>
      ports.getOpenCodeAgendaSyncRecoveryBypassMessageIds(bypassInput),
    resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
      ports.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoverInput) =>
      ports.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoverInput),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: (record) =>
      ports.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record),
    isOpenCodePromptDeliveryWatchdogEnabled: () => ports.isOpenCodePromptDeliveryWatchdogEnabled(),
    scheduleOpenCodePromptDeliveryWatchdog: (watchdogInput) =>
      ports.scheduleOpenCodePromptDeliveryWatchdog(watchdogInput),
    readLaunchStateForDeliveryRecovery: (teamName) =>
      ports.readLaunchState(teamName).catch(() => null),
    nowIso: ports.nowIso,
    logger: ports.logger,
  });
}
