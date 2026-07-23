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
  mutateLaunchStateSnapshot: DeliveryBoundaryPorts<Run>['mutateLaunchState'];
  withTeamLock: DeliveryBoundaryPorts<Run>['withTeamLock'];
  readConfigForStrictDecision: DeliveryBoundaryPorts<Run>['readConfigForStrictDecision'];
  readMetaMembers: DeliveryBoundaryPorts<Run>['readMetaMembers'];
  readPersistedRuntimeMembers: DeliveryBoundaryPorts<Run>['readPersistedRuntimeMembers'];
  getTrackedRunId(teamName: string): string | null | undefined;
  canDeliverToTrackedRuntimeRun(teamName: string, runId: string): boolean;
  resolveDeliverableTrackedRuntimeRunId(teamName: string): string | null;
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
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery'];
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
  mutateLaunchStateSnapshot: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['mutateLaunchStateSnapshot'];
  withTeamLock: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['withTeamLock'];
  readConfigForStrictDecision: DeliveryBoundaryPorts<Run>['readConfigForStrictDecision'];
  membersMetaStore: {
    getMembers: DeliveryBoundaryPorts<Run>['readMetaMembers'];
  };
  readPersistedRuntimeMembers: DeliveryBoundaryPorts<Run>['readPersistedRuntimeMembers'];
  runTracking: {
    getTrackedRunId: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['getTrackedRunId'];
    canDeliverToTrackedRuntimeRun: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['canDeliverToTrackedRuntimeRun'];
    resolveDeliverableTrackedRuntimeRunId: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['resolveDeliverableTrackedRuntimeRunId'];
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
  getCrossTeamSender: DeliveryBoundaryPorts<Run>['getCrossTeamSender'];
  isOpenCodeRuntimeRecipient: DeliveryBoundaryPorts<Run>['isOpenCodeRuntimeRecipient'];
  getOpenCodeAgendaSyncRecoveryBypassMessageIds: DeliveryBoundaryPorts<Run>['getOpenCodeAgendaSyncRecoveryBypassMessageIds'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive'];
  decideOpenCodeRuntimeDeliveryUserFacingAdvisory: DeliveryBoundaryPorts<Run>['decideOpenCodeRuntimeDeliveryUserFacingAdvisory'];
  openCodePromptDeliveryWatchdogScheduler: {
    isEnabled(): boolean;
  };
  scheduleOpenCodePromptDeliveryWatchdog: DeliveryBoundaryPorts<Run>['scheduleOpenCodePromptDeliveryWatchdog'];
}

export interface TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFactoryService<
  Run extends OpenCodeRuntimeCheckinRun,
> {
  resolveOpenCodeRuntimeLaneId: DeliveryBoundaryPorts<Run>['resolveOpenCodeRuntimeLaneId'];
  openCodeRuntimeRecoveryIdentity: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['openCodeRuntimeRecoveryIdentity'];
  launchStateStore: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['launchStateStore'];
  writeLaunchStateSnapshot: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['writeLaunchStateSnapshot'];
  writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: Parameters<DeliveryBoundaryPorts<Run>['writeLaunchState']>[1]
  ): Promise<{ snapshot: Parameters<DeliveryBoundaryPorts<Run>['writeLaunchState']>[1] }>;
  enqueueLaunchStateStoreOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  withTeamLock: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['withTeamLock'];
  readConfigForStrictDecision: DeliveryBoundaryPorts<Run>['readConfigForStrictDecision'];
  membersMetaStore: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['membersMetaStore'];
  readPersistedRuntimeMembers: DeliveryBoundaryPorts<Run>['readPersistedRuntimeMembers'];
  runTracking: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['runTracking'];
  runs: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['runs'];
  persistLaunchStateSnapshot: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['persistLaunchStateSnapshot'];
  getMixedSecondaryLaunchPhase: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['getMixedSecondaryLaunchPhase'];
  invalidateRuntimeSnapshotCaches: DeliveryBoundaryPorts<Run>['invalidateRuntimeSnapshotCaches'];
  emitMemberSpawnChange: DeliveryBoundaryPorts<Run>['emitMemberSpawnChange'];
  teamChangeEmitter: DeliveryBoundaryPorts<Run>['emitTeamChange'] | null;
  createOpenCodeRuntimeBootstrapEvidencePorts: DeliveryBoundaryPorts<Run>['createOpenCodeRuntimeBootstrapEvidencePorts'];
  openCodeTaskLogAttributionStore: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['openCodeTaskLogAttributionStore'];
  syncMemberTaskActivityForRuntimeTransition: DeliveryBoundaryPorts<Run>['syncMemberTaskActivityForRuntimeTransition'];
  syncMemberLaunchGraceCheck: DeliveryBoundaryPorts<Run>['syncMemberLaunchGraceCheck'];
  sentMessagesStore: DeliveryBoundaryPorts<Run>['sentMessagesStore'];
  inboxReader: DeliveryBoundaryPorts<Run>['inboxReader'];
  inboxWriter: DeliveryBoundaryPorts<Run>['inboxWriter'];
  getCrossTeamSender: DeliveryBoundaryPorts<Run>['getCrossTeamSender'];
  isOpenCodeRuntimeRecipient: DeliveryBoundaryPorts<Run>['isOpenCodeRuntimeRecipient'];
  getOpenCodeAgendaSyncRecoveryBypassMessageIds: DeliveryBoundaryPorts<Run>['getOpenCodeAgendaSyncRecoveryBypassMessageIds'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive'];
  decideOpenCodeRuntimeDeliveryUserFacingAdvisory: DeliveryBoundaryPorts<Run>['decideOpenCodeRuntimeDeliveryUserFacingAdvisory'];
  openCodePromptDeliveryWatchdogScheduler: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['openCodePromptDeliveryWatchdogScheduler'];
  scheduleOpenCodePromptDeliveryWatchdog: DeliveryBoundaryPorts<Run>['scheduleOpenCodePromptDeliveryWatchdog'];
}

export interface TeamProvisioningOpenCodeRuntimeDeliveryBoundaryServiceHost<
  Run extends OpenCodeRuntimeCheckinRun,
> {
  resolveOpenCodeRuntimeLaneId: DeliveryBoundaryPorts<Run>['resolveOpenCodeRuntimeLaneId'];
  openCodeRuntimeRecoveryIdentity: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['openCodeRuntimeRecoveryIdentity'];
  launchStateStore: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['launchStateStore'];
  writeLaunchStateSnapshot: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['writeLaunchStateSnapshot'];
  writeLaunchStateSnapshotNow: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFactoryService<Run>['writeLaunchStateSnapshotNow'];
  enqueueLaunchStateStoreOperation: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFactoryService<Run>['enqueueLaunchStateStoreOperation'];
  withTeamLock: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['withTeamLock'];
  readConfigForStrictDecision: DeliveryBoundaryPorts<Run>['readConfigForStrictDecision'];
  membersMetaStore: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['membersMetaStore'];
  readPersistedRuntimeMembers: DeliveryBoundaryPorts<Run>['readPersistedRuntimeMembers'];
  runTracking: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['runTracking'];
  runs: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['runs'];
  persistLaunchStateSnapshot: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['persistLaunchStateSnapshot'];
  getMixedSecondaryLaunchPhase: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<Run>['getMixedSecondaryLaunchPhase'];
  invalidateRuntimeSnapshotCaches: DeliveryBoundaryPorts<Run>['invalidateRuntimeSnapshotCaches'];
  emitMemberSpawnChange: DeliveryBoundaryPorts<Run>['emitMemberSpawnChange'];
  teamChangeEmitter: DeliveryBoundaryPorts<Run>['emitTeamChange'] | null;
  createOpenCodeRuntimeBootstrapEvidencePorts: DeliveryBoundaryPorts<Run>['createOpenCodeRuntimeBootstrapEvidencePorts'];
  openCodeTaskLogAttributionStore: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['openCodeTaskLogAttributionStore'];
  syncMemberTaskActivityForRuntimeTransition: DeliveryBoundaryPorts<Run>['syncMemberTaskActivityForRuntimeTransition'];
  syncMemberLaunchGraceCheck: DeliveryBoundaryPorts<Run>['syncMemberLaunchGraceCheck'];
  sentMessagesStore: DeliveryBoundaryPorts<Run>['sentMessagesStore'];
  inboxReader: DeliveryBoundaryPorts<Run>['inboxReader'];
  inboxWriter: DeliveryBoundaryPorts<Run>['inboxWriter'];
  appShellBoundary: {
    getCrossTeamSender: DeliveryBoundaryPorts<Run>['getCrossTeamSender'];
  };
  isOpenCodeRuntimeRecipient: DeliveryBoundaryPorts<Run>['isOpenCodeRuntimeRecipient'];
  getOpenCodeAgendaSyncRecoveryBypassMessageIds: DeliveryBoundaryPorts<Run>['getOpenCodeAgendaSyncRecoveryBypassMessageIds'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery'];
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: DeliveryBoundaryPorts<Run>['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive'];
  decideOpenCodeRuntimeDeliveryUserFacingAdvisory: DeliveryBoundaryPorts<Run>['decideOpenCodeRuntimeDeliveryUserFacingAdvisory'];
  openCodePromptDeliveryWatchdogScheduler: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>['openCodePromptDeliveryWatchdogScheduler'];
  scheduleOpenCodePromptDeliveryWatchdog: DeliveryBoundaryPorts<Run>['scheduleOpenCodePromptDeliveryWatchdog'];
}

export function createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  service: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFactoryService<Run>
): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run> {
  return {
    resolveOpenCodeRuntimeLaneId: (input) => service.resolveOpenCodeRuntimeLaneId(input),
    openCodeRuntimeRecoveryIdentity: {
      resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        service.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
          teamName,
          laneId
        ),
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        service.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
          teamName,
          memberName
        ),
    },
    launchStateStore: {
      read: (teamName) => service.launchStateStore.read(teamName),
    },
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      service.writeLaunchStateSnapshot(teamName, snapshot),
    mutateLaunchStateSnapshot: (teamName, mutation) =>
      service.enqueueLaunchStateStoreOperation(teamName, async () => {
        const current = await service.launchStateStore.read(teamName);
        const next = await mutation(current);
        return (await service.writeLaunchStateSnapshotNow(teamName, next)).snapshot;
      }),
    withTeamLock: (teamName, operation) => service.withTeamLock(teamName, operation),
    readConfigForStrictDecision: (teamName) => service.readConfigForStrictDecision(teamName),
    membersMetaStore: {
      getMembers: (teamName) => service.membersMetaStore.getMembers(teamName),
    },
    readPersistedRuntimeMembers: (teamName) => service.readPersistedRuntimeMembers(teamName),
    runTracking: {
      getTrackedRunId: (teamName) => service.runTracking.getTrackedRunId(teamName),
      canDeliverToTrackedRuntimeRun: (teamName, runId) =>
        service.runTracking.canDeliverToTrackedRuntimeRun(teamName, runId),
      resolveDeliverableTrackedRuntimeRunId: (teamName) =>
        service.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
    },
    runs: {
      get: (runId) => service.runs.get(runId),
    },
    persistLaunchStateSnapshot: (run, launchPhase) =>
      service.persistLaunchStateSnapshot(run, launchPhase),
    getMixedSecondaryLaunchPhase: (run) => service.getMixedSecondaryLaunchPhase(run),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    emitMemberSpawnChange: (run, memberName) => service.emitMemberSpawnChange(run, memberName),
    teamChangeEmitter: (event) => {
      service.teamChangeEmitter?.(event);
    },
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      service.createOpenCodeRuntimeBootstrapEvidencePorts(),
    openCodeTaskLogAttributionStore: {
      upsertTaskRecord: (teamName, record) =>
        service.openCodeTaskLogAttributionStore.upsertTaskRecord(teamName, record),
    },
    syncMemberTaskActivityForRuntimeTransition: (
      run,
      memberName,
      previousStatus,
      nextStatus,
      observedAt
    ) =>
      service.syncMemberTaskActivityForRuntimeTransition(
        run,
        memberName,
        previousStatus,
        nextStatus,
        observedAt
      ),
    syncMemberLaunchGraceCheck: (run, memberName, nextStatus) =>
      service.syncMemberLaunchGraceCheck(run, memberName, nextStatus),
    sentMessagesStore: service.sentMessagesStore,
    inboxReader: service.inboxReader,
    inboxWriter: service.inboxWriter,
    getCrossTeamSender: () => service.getCrossTeamSender(),
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      service.isOpenCodeRuntimeRecipient(teamName, memberName),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: (input) =>
      service.getOpenCodeAgendaSyncRecoveryBypassMessageIds(input),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: (input) =>
      service.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (input) =>
      service.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: (record) =>
      service.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record),
    openCodePromptDeliveryWatchdogScheduler: service.openCodePromptDeliveryWatchdogScheduler,
    scheduleOpenCodePromptDeliveryWatchdog: (input) =>
      service.scheduleOpenCodePromptDeliveryWatchdog(input),
  };
}

export function createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFromService<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  service: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryServiceHost<Run>
): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run> {
  return createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<Run>({
    resolveOpenCodeRuntimeLaneId: (input) => service.resolveOpenCodeRuntimeLaneId(input),
    openCodeRuntimeRecoveryIdentity: {
      resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        service.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
          teamName,
          laneId
        ),
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        service.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
          teamName,
          memberName
        ),
    },
    launchStateStore: {
      read: (teamName) => service.launchStateStore.read(teamName),
    },
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      service.writeLaunchStateSnapshot(teamName, snapshot),
    writeLaunchStateSnapshotNow: (teamName, snapshot) =>
      service.writeLaunchStateSnapshotNow(teamName, snapshot),
    enqueueLaunchStateStoreOperation: (teamName, operation) =>
      service.enqueueLaunchStateStoreOperation(teamName, operation),
    withTeamLock: (teamName, operation) => service.withTeamLock(teamName, operation),
    readConfigForStrictDecision: (teamName) => service.readConfigForStrictDecision(teamName),
    membersMetaStore: {
      getMembers: (teamName) => service.membersMetaStore.getMembers(teamName),
    },
    readPersistedRuntimeMembers: (teamName) => service.readPersistedRuntimeMembers(teamName),
    runTracking: {
      getTrackedRunId: (teamName) => service.runTracking.getTrackedRunId(teamName),
      canDeliverToTrackedRuntimeRun: (teamName, runId) =>
        service.runTracking.canDeliverToTrackedRuntimeRun(teamName, runId),
      resolveDeliverableTrackedRuntimeRunId: (teamName) =>
        service.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
    },
    runs: {
      get: (runId) => service.runs.get(runId),
    },
    persistLaunchStateSnapshot: (run, launchPhase) =>
      service.persistLaunchStateSnapshot(run, launchPhase),
    getMixedSecondaryLaunchPhase: (run) => service.getMixedSecondaryLaunchPhase(run),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    emitMemberSpawnChange: (run, memberName) => service.emitMemberSpawnChange(run, memberName),
    teamChangeEmitter: (event) => {
      service.teamChangeEmitter?.(event);
    },
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      service.createOpenCodeRuntimeBootstrapEvidencePorts(),
    openCodeTaskLogAttributionStore: {
      upsertTaskRecord: (teamName, record) =>
        service.openCodeTaskLogAttributionStore.upsertTaskRecord(teamName, record),
    },
    syncMemberTaskActivityForRuntimeTransition: (
      run,
      memberName,
      previousStatus,
      nextStatus,
      observedAt
    ) =>
      service.syncMemberTaskActivityForRuntimeTransition(
        run,
        memberName,
        previousStatus,
        nextStatus,
        observedAt
      ),
    syncMemberLaunchGraceCheck: (run, memberName, nextStatus) =>
      service.syncMemberLaunchGraceCheck(run, memberName, nextStatus),
    sentMessagesStore: service.sentMessagesStore,
    inboxReader: service.inboxReader,
    inboxWriter: service.inboxWriter,
    getCrossTeamSender: () => service.appShellBoundary.getCrossTeamSender(),
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      service.isOpenCodeRuntimeRecipient(teamName, memberName),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: (input) =>
      service.getOpenCodeAgendaSyncRecoveryBypassMessageIds(input),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: (input) =>
      service.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (input) =>
      service.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: (record) =>
      service.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record),
    openCodePromptDeliveryWatchdogScheduler: service.openCodePromptDeliveryWatchdogScheduler,
    scheduleOpenCodePromptDeliveryWatchdog: (input) =>
      service.scheduleOpenCodePromptDeliveryWatchdog(input),
  });
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
    resolveCurrentOpenCodeRuntimeRunId: async (teamName, laneId) => {
      const runId = await host.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
        teamName,
        laneId
      );
      if (
        runId &&
        host.runTracking.getTrackedRunId(teamName) &&
        !host.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName)
      ) {
        return null;
      }
      if (
        runId &&
        laneId.trim().toLowerCase() === 'primary' &&
        !host.runTracking.canDeliverToTrackedRuntimeRun(teamName, runId)
      ) {
        return null;
      }
      return runId;
    },
    readLaunchState: (teamName) => host.launchStateStore.read(teamName),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      host.writeLaunchStateSnapshot(teamName, snapshot),
    mutateLaunchStateSnapshot: (teamName, mutation) =>
      host.mutateLaunchStateSnapshot(teamName, mutation),
    withTeamLock: (teamName, operation) => host.withTeamLock(teamName, operation),
    readConfigForStrictDecision: (teamName) => host.readConfigForStrictDecision(teamName),
    readMetaMembers: (teamName) => host.membersMetaStore.getMembers(teamName),
    readPersistedRuntimeMembers: (teamName) => host.readPersistedRuntimeMembers(teamName),
    getTrackedRunId: (teamName) => host.runTracking.getTrackedRunId(teamName),
    canDeliverToTrackedRuntimeRun: (teamName, runId) =>
      host.runTracking.canDeliverToTrackedRuntimeRun(teamName, runId),
    resolveDeliverableTrackedRuntimeRunId: (teamName) =>
      host.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
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
    getCrossTeamSender: () => host.getCrossTeamSender(),
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      host.isOpenCodeRuntimeRecipient(teamName, memberName),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: (bypassInput) =>
      host.getOpenCodeAgendaSyncRecoveryBypassMessageIds(bypassInput),
    resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
      host.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
        teamName,
        memberName
      ),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: (recoverInput) =>
      host.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(recoverInput),
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
    resolveCurrentOpenCodeRuntimeRunId: async (teamName, laneId) => {
      const runId = await ports.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId);
      if (
        runId &&
        ports.getTrackedRunId(teamName) &&
        !ports.resolveDeliverableTrackedRuntimeRunId(teamName)
      ) {
        return null;
      }
      if (
        runId &&
        laneId.trim().toLowerCase() === 'primary' &&
        !ports.canDeliverToTrackedRuntimeRun(teamName, runId)
      ) {
        return null;
      }
      return runId;
    },
    readLaunchState: (teamName) => ports.readLaunchState(teamName),
    writeLaunchState: async (teamName, snapshot) => {
      await ports.writeLaunchStateSnapshot(teamName, snapshot);
    },
    mutateLaunchState: (teamName, mutation) => ports.mutateLaunchStateSnapshot(teamName, mutation),
    withTeamLock: (teamName, operation) => ports.withTeamLock(teamName, operation),
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
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: (recoverInput) =>
      ports.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(recoverInput),
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
