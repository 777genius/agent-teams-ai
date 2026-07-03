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
