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

export interface TeamProvisioningOpenCodeMemberMessageDeliveryHost {
  getOpenCodeRuntimeMessageAdapter: OpenCodeMemberMessageDeliveryFactoryPorts['getOpenCodeRuntimeMessageAdapter'];
  readOpenCodeMemberDirectory: OpenCodeMemberMessageDeliveryFactoryPorts['readOpenCodeMemberDirectory'];
  resolveOpenCodeMemberIdentityFromDirectory: OpenCodeMemberMessageDeliveryFactoryPorts['resolveOpenCodeMemberIdentityFromDirectory'];
  stoppingSecondaryRuntimeTeams: OpenCodeMemberMessageDeliveryFactoryPorts['stoppingSecondaryRuntimeTeams'];
  readPersistedTeamProjectPath: OpenCodeMemberMessageDeliveryFactoryPorts['readPersistedTeamProjectPath'];
  runTracking: {
    resolveDeliverableTrackedRuntimeRunId: OpenCodeMemberMessageDeliveryFactoryPorts['resolveDeliverableTrackedRuntimeRunId'];
  };
  runs: OpenCodeMemberMessageDeliveryFactoryPorts['runs'];
  getCurrentOpenCodeRuntimeRunId: OpenCodeMemberMessageDeliveryFactoryPorts['getCurrentOpenCodeRuntimeRunId'];
  openCodeRuntimeRecoveryIdentity: {
    resolveCurrentOpenCodeRuntimeRunId: OpenCodeMemberMessageDeliveryFactoryPorts['resolveCurrentOpenCodeRuntimeRunId'];
    isOpenCodeRuntimeLaneIndexActive: OpenCodeMemberMessageDeliveryFactoryPorts['isOpenCodeRuntimeLaneIndexActive'];
  };
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery: OpenCodeMemberMessageDeliveryFactoryPorts['tryRecoverOpenCodeRuntimeLaneBeforeDelivery'];
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: OpenCodeMemberMessageDeliveryFactoryPorts['tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery'];
  deleteSecondaryRuntimeRun: OpenCodeMemberMessageDeliveryFactoryPorts['deleteSecondaryRuntimeRun'];
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: OpenCodeMemberMessageDeliveryFactoryPorts['cleanupStoppedTeamOpenCodeRuntimeLanesInBackground'];
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
    readOpenCodeMemberDirectory: (teamName) => host.readOpenCodeMemberDirectory(teamName),
    resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
      host.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
    stoppingSecondaryRuntimeTeams: host.stoppingSecondaryRuntimeTeams,
    readPersistedTeamProjectPath: (teamName) => host.readPersistedTeamProjectPath(teamName),
    resolveDeliverableTrackedRuntimeRunId: (teamName) =>
      host.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
    runs: host.runs,
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      host.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      host.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
      host.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
      host.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
      host.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input),
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      host.deleteSecondaryRuntimeRun(teamName, laneId),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
      host.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
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

export async function deliverOpenCodeMemberMessage(
  service: OpenCodeMemberMessageDeliveryService,
  teamName: string,
  input: OpenCodeMemberMessageDeliveryInput
): Promise<OpenCodeMemberInboxDelivery> {
  return await service.deliver(teamName, input);
}
