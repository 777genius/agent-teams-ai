import {
  type OpenCodeMemberInboxDelivery,
  type OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliveryService,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';

import {
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
  findDeliverableOpenCodeRuntimeBootstrapSessionEvidence,
  getOpenCodeAppMcpTransportMismatchDiagnostic,
  type OpenCodeRuntimeBootstrapEvidencePorts,
  stampOpenCodeAppMcpTransportEvidenceIfMissing,
} from './TeamProvisioningOpenCodeBootstrapEvidence';

import type { TeamProvisioningOpenCodeRuntimeRecoveryFacade } from './TeamProvisioningOpenCodeRuntimeRecoveryFacade';
import type { TeamProvisioningOpenCodeStoppedLaneCleanupBoundary } from './TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';

export interface OpenCodeRuntimeBootstrapEvidencePortsFactoryInput {
  teamsBasePath: string;
  warn(message: string): void;
}

export type OpenCodeMemberMessageDeliveryFactoryPorts = Omit<
  OpenCodeMemberMessageDeliveryServiceDependencies,
  | 'findDeliverableOpenCodeRuntimeBootstrapSessionEvidence'
  | 'getOpenCodeAppMcpTransportMismatchDiagnostic'
  | 'stampOpenCodeAppMcpTransportEvidenceIfMissing'
> & {
  createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts;
};

type OpenCodeRuntimeDeliveryRecoveryShim = Pick<
  TeamProvisioningOpenCodeRuntimeRecoveryFacade,
  | 'tryRecoverOpenCodeRuntimeLaneBeforeDelivery'
  | 'tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery'
>;

export interface TeamProvisioningOpenCodeMemberMessageDeliveryHost {
  getOpenCodeRuntimeMessageAdapter: OpenCodeMemberMessageDeliveryFactoryPorts['getOpenCodeRuntimeMessageAdapter'];
  openCodeRuntimeRecoveryFacade: Pick<
    TeamProvisioningOpenCodeRuntimeRecoveryFacade,
    | 'readOpenCodeMemberDirectory'
    | 'resolveOpenCodeMemberIdentityFromDirectory'
    | 'tryRecoverOpenCodeRuntimeLaneBeforeDelivery'
    | 'tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery'
    | 'openCodeRuntimeRecoveryIdentity'
  >;
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery?: OpenCodeRuntimeDeliveryRecoveryShim['tryRecoverOpenCodeRuntimeLaneBeforeDelivery'];
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery?: OpenCodeRuntimeDeliveryRecoveryShim['tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery'];
  stoppingSecondaryRuntimeTeams: OpenCodeMemberMessageDeliveryFactoryPorts['stoppingSecondaryRuntimeTeams'];
  readPersistedTeamProjectPath: OpenCodeMemberMessageDeliveryFactoryPorts['readPersistedTeamProjectPath'];
  runTracking: {
    resolveDeliverableTrackedRuntimeRunId: OpenCodeMemberMessageDeliveryFactoryPorts['resolveDeliverableTrackedRuntimeRunId'];
  };
  runs: OpenCodeMemberMessageDeliveryFactoryPorts['runs'];
  getCurrentOpenCodeRuntimeRunId: OpenCodeMemberMessageDeliveryFactoryPorts['getCurrentOpenCodeRuntimeRunId'];
  deleteSecondaryRuntimeRun: OpenCodeMemberMessageDeliveryFactoryPorts['deleteSecondaryRuntimeRun'];
  openCodeStoppedLaneCleanup: Pick<
    TeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
    'cleanupStoppedTeamOpenCodeRuntimeLanesInBackground'
  >;
  createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts;
  providerRuntime: {
    resolveControlApiBaseUrl: OpenCodeMemberMessageDeliveryFactoryPorts['resolveControlApiBaseUrl'];
  };
  sendOpenCodeMemberMessageToRuntimeSerialized: OpenCodeMemberMessageDeliveryFactoryPorts['sendOpenCodeMemberMessageToRuntimeSerialized'];
  rememberOpenCodeRuntimePidFromBridge: OpenCodeMemberMessageDeliveryFactoryPorts['rememberOpenCodeRuntimePidFromBridge'];
  maybeSyncOpenCodeRuntimePermissionsAfterDelivery: OpenCodeMemberMessageDeliveryFactoryPorts['maybeSyncOpenCodeRuntimePermissionsAfterDelivery'];
  isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: OpenCodeMemberMessageDeliveryFactoryPorts['isLegacyOpenCodeMemberWorkSyncReadCommitAllowed'];
  createOpenCodePromptDeliveryLedger: OpenCodeMemberMessageDeliveryFactoryPorts['createOpenCodePromptDeliveryLedger'];
  openCodeVisibleReplyProofService: OpenCodeMemberMessageDeliveryFactoryPorts['openCodeVisibleReplyProofService'];
  openCodePromptDeliveryWatchdogScheduler: OpenCodeMemberMessageDeliveryFactoryPorts['openCodePromptDeliveryWatchdogScheduler'];
  openCodePromptDeliveryFollowUpPolicy: OpenCodeMemberMessageDeliveryFactoryPorts['openCodePromptDeliveryFollowUpPolicy'];
  isOpenCodeDeliveryResponseReadCommitAllowed: OpenCodeMemberMessageDeliveryFactoryPorts['isOpenCodeDeliveryResponseReadCommitAllowed'];
  getOpenCodeDeliveryPendingReason: OpenCodeMemberMessageDeliveryFactoryPorts['getOpenCodeDeliveryPendingReason'];
  markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: OpenCodeMemberMessageDeliveryFactoryPorts['markOpenCodeAcceptedDeliveryMissingPromptProofForRetry'];
  scheduleOpenCodePromptDeliveryWatchdog: OpenCodeMemberMessageDeliveryFactoryPorts['scheduleOpenCodePromptDeliveryWatchdog'];
  logOpenCodePromptDeliveryEvent: OpenCodeMemberMessageDeliveryFactoryPorts['logOpenCodePromptDeliveryEvent'];
  requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: OpenCodeMemberMessageDeliveryFactoryPorts['requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded'];
  emitOpenCodePromptDeliveryTaskLogChange: OpenCodeMemberMessageDeliveryFactoryPorts['emitOpenCodePromptDeliveryTaskLogChange'];
  observeOpenCodeDirectUserDeliveryInlineIfNeeded: OpenCodeMemberMessageDeliveryFactoryPorts['observeOpenCodeDirectUserDeliveryInlineIfNeeded'];
}

export type TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost = Omit<
  TeamProvisioningOpenCodeMemberMessageDeliveryHost,
  'getOpenCodeRuntimeMessageAdapter'
> & {
  appShellBoundary: {
    getOpenCodeRuntimeMessageAdapter: TeamProvisioningOpenCodeMemberMessageDeliveryHost['getOpenCodeRuntimeMessageAdapter'];
  };
};

export function createOpenCodeRuntimeBootstrapEvidencePorts(
  input: OpenCodeRuntimeBootstrapEvidencePortsFactoryInput
): OpenCodeRuntimeBootstrapEvidencePorts {
  return createDefaultOpenCodeRuntimeBootstrapEvidencePorts(input);
}

export function createOpenCodeMemberMessageDeliveryService(
  ports: OpenCodeMemberMessageDeliveryFactoryPorts
): OpenCodeMemberMessageDeliveryService {
  return new OpenCodeMemberMessageDeliveryService({
    ...ports,
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: (input) =>
      findDeliverableOpenCodeRuntimeBootstrapSessionEvidence(
        input,
        ports.createOpenCodeRuntimeBootstrapEvidencePorts()
      ),
    getOpenCodeAppMcpTransportMismatchDiagnostic: (session) =>
      getOpenCodeAppMcpTransportMismatchDiagnostic(session),
    stampOpenCodeAppMcpTransportEvidenceIfMissing: (session, options) =>
      stampOpenCodeAppMcpTransportEvidenceIfMissing(
        session,
        ports.createOpenCodeRuntimeBootstrapEvidencePorts(),
        options
      ),
  });
}

export function createOpenCodeMemberMessageDeliveryServiceFromHost(
  host: TeamProvisioningOpenCodeMemberMessageDeliveryHost
): OpenCodeMemberMessageDeliveryService {
  return createOpenCodeMemberMessageDeliveryService({
    getOpenCodeRuntimeMessageAdapter: () => host.getOpenCodeRuntimeMessageAdapter(),
    readOpenCodeMemberDirectory: (teamName) =>
      host.openCodeRuntimeRecoveryFacade.readOpenCodeMemberDirectory(teamName),
    resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
      host.openCodeRuntimeRecoveryFacade.resolveOpenCodeMemberIdentityFromDirectory(
        teamName,
        memberName,
        directory
      ),
    stoppingSecondaryRuntimeTeams: host.stoppingSecondaryRuntimeTeams,
    readPersistedTeamProjectPath: (teamName) => host.readPersistedTeamProjectPath(teamName),
    resolveDeliverableTrackedRuntimeRunId: (teamName) =>
      host.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
    runs: host.runs,
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      host.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      host.openCodeRuntimeRecoveryFacade.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
        teamName,
        laneId
      ),
    isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
      host.openCodeRuntimeRecoveryFacade.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive(
        teamName,
        laneId
      ),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
      typeof host.tryRecoverOpenCodeRuntimeLaneBeforeDelivery === 'function'
        ? host.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input)
        : host.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
      typeof host.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery === 'function'
        ? host.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input)
        : host.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
            input
          ),
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      host.deleteSecondaryRuntimeRun(teamName, laneId),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
      host.openCodeStoppedLaneCleanup.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      host.createOpenCodeRuntimeBootstrapEvidencePorts(),
    resolveControlApiBaseUrl: () => host.providerRuntime.resolveControlApiBaseUrl(),
    sendOpenCodeMemberMessageToRuntimeSerialized: (input) =>
      host.sendOpenCodeMemberMessageToRuntimeSerialized(input),
    rememberOpenCodeRuntimePidFromBridge: (input) =>
      host.rememberOpenCodeRuntimePidFromBridge(input),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: (input) =>
      host.maybeSyncOpenCodeRuntimePermissionsAfterDelivery(input),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: (input) =>
      host.isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input),
    createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
      host.createOpenCodePromptDeliveryLedger(teamName, laneId),
    openCodeVisibleReplyProofService: host.openCodeVisibleReplyProofService,
    openCodePromptDeliveryWatchdogScheduler: host.openCodePromptDeliveryWatchdogScheduler,
    openCodePromptDeliveryFollowUpPolicy: host.openCodePromptDeliveryFollowUpPolicy,
    isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
      host.isOpenCodeDeliveryResponseReadCommitAllowed(input),
    getOpenCodeDeliveryPendingReason: (input) => host.getOpenCodeDeliveryPendingReason(input),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: (input) =>
      host.markOpenCodeAcceptedDeliveryMissingPromptProofForRetry(input),
    scheduleOpenCodePromptDeliveryWatchdog: (input) =>
      host.scheduleOpenCodePromptDeliveryWatchdog(input),
    logOpenCodePromptDeliveryEvent: (event, record, extra) =>
      host.logOpenCodePromptDeliveryEvent(event, record, extra),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
      host.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input),
    emitOpenCodePromptDeliveryTaskLogChange: (record, detail) =>
      host.emitOpenCodePromptDeliveryTaskLogChange(record, detail),
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: (input) =>
      host.observeOpenCodeDirectUserDeliveryInlineIfNeeded(input),
  });
}

export function createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService(
  service: TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost
): TeamProvisioningOpenCodeMemberMessageDeliveryHost {
  return {
    getOpenCodeRuntimeMessageAdapter: () =>
      service.appShellBoundary.getOpenCodeRuntimeMessageAdapter(),
    openCodeRuntimeRecoveryFacade: service.openCodeRuntimeRecoveryFacade,
    stoppingSecondaryRuntimeTeams: service.stoppingSecondaryRuntimeTeams,
    readPersistedTeamProjectPath: (teamName) => service.readPersistedTeamProjectPath(teamName),
    runTracking: {
      resolveDeliverableTrackedRuntimeRunId: (teamName) =>
        service.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
    },
    runs: service.runs,
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      service.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
      typeof service.tryRecoverOpenCodeRuntimeLaneBeforeDelivery === 'function'
        ? service.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input)
        : service.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
      typeof service.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery === 'function'
        ? service.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input)
        : service.openCodeRuntimeRecoveryFacade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
            input
          ),
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      service.deleteSecondaryRuntimeRun(teamName, laneId),
    openCodeStoppedLaneCleanup: service.openCodeStoppedLaneCleanup,
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      service.createOpenCodeRuntimeBootstrapEvidencePorts(),
    providerRuntime: {
      resolveControlApiBaseUrl: () => service.providerRuntime.resolveControlApiBaseUrl(),
    },
    sendOpenCodeMemberMessageToRuntimeSerialized: (input) =>
      service.sendOpenCodeMemberMessageToRuntimeSerialized(input),
    rememberOpenCodeRuntimePidFromBridge: (input) =>
      service.rememberOpenCodeRuntimePidFromBridge(input),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: (input) =>
      service.maybeSyncOpenCodeRuntimePermissionsAfterDelivery(input),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: (input) =>
      service.isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input),
    createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
      service.createOpenCodePromptDeliveryLedger(teamName, laneId),
    openCodeVisibleReplyProofService: service.openCodeVisibleReplyProofService,
    openCodePromptDeliveryWatchdogScheduler: service.openCodePromptDeliveryWatchdogScheduler,
    openCodePromptDeliveryFollowUpPolicy: service.openCodePromptDeliveryFollowUpPolicy,
    isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
      service.isOpenCodeDeliveryResponseReadCommitAllowed(input),
    getOpenCodeDeliveryPendingReason: (input) => service.getOpenCodeDeliveryPendingReason(input),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: (input) =>
      service.markOpenCodeAcceptedDeliveryMissingPromptProofForRetry(input),
    scheduleOpenCodePromptDeliveryWatchdog: (input) =>
      service.scheduleOpenCodePromptDeliveryWatchdog(input),
    logOpenCodePromptDeliveryEvent: (event, record, extra) =>
      service.logOpenCodePromptDeliveryEvent(event, record, extra),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
      service.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input),
    emitOpenCodePromptDeliveryTaskLogChange: (record, detail) =>
      service.emitOpenCodePromptDeliveryTaskLogChange(record, detail),
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: (input) =>
      service.observeOpenCodeDirectUserDeliveryInlineIfNeeded(input),
  };
}

export async function deliverOpenCodeMemberMessage(
  service: OpenCodeMemberMessageDeliveryService,
  teamName: string,
  input: OpenCodeMemberMessageDeliveryInput
): Promise<OpenCodeMemberInboxDelivery> {
  return await service.deliver(teamName, input);
}
