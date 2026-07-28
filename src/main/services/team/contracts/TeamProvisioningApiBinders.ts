import type {
  TeamClaudeLogsApi,
  TeamDiagnosticsApi,
  TeamHttpDataApi,
  TeamMemberLifecycleApi,
  TeamProvisioningPreflightApi,
  TeamProvisioningPrepareOptions,
  TeamProvisioningRunApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamTaskActivityRepairApi,
  TeamToolApprovalApi,
} from './TeamProvisioningCapabilityApis';
import type { TeamCrossTeamMessagingApi, TeamMessagingApi } from './TeamProvisioningMessagingApis';
import type {
  TeamHttpRuntimeApi,
  TeamRuntimeApi,
  TeamRuntimeControlCompatibilityApi,
} from './TeamProvisioningRuntimeApis';

export interface TeamHttpHandlerApis {
  provisioningStart: TeamProvisioningStartApi;
  provisioningStatus: TeamProvisioningStatusApi;
  taskActivity: TeamTaskActivityRepairApi;
  runtime: TeamHttpRuntimeApi;
  runtimeControl: TeamRuntimeControlCompatibilityApi;
}

export interface TeamIpcHandlerApis {
  provisioningStart: TeamProvisioningStartApi;
  provisioningStatus: TeamProvisioningStatusApi;
  preflight: TeamProvisioningPreflightApi;
  provisioningRun: TeamProvisioningRunApi;
  taskActivity: TeamTaskActivityRepairApi;
  runtime: TeamRuntimeApi;
  memberLifecycle: TeamMemberLifecycleApi;
  diagnostics: TeamDiagnosticsApi;
  claudeLogs: TeamClaudeLogsApi;
  messaging: TeamMessagingApi;
  toolApproval: TeamToolApprovalApi;
}

function assertDensePrepareModelArray(values: unknown, field: 'modelIds' | 'modelChecks'): void {
  if (values === undefined) {
    return;
  }

  if (!Array.isArray(values)) {
    throw new TypeError(`TeamProvisioningPrepareOptions.${field} must be an array when provided`);
  }

  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index) || values[index] === undefined) {
      throw new TypeError(
        `TeamProvisioningPrepareOptions.${field} must not contain missing indices`
      );
    }
  }
}

function validatePrepareModelIndexes(opts?: TeamProvisioningPrepareOptions): void {
  assertDensePrepareModelArray(opts?.modelIds, 'modelIds');
  assertDensePrepareModelArray(opts?.modelChecks, 'modelChecks');
}

export function bindTeamProvisioningStartApi(
  source: TeamProvisioningStartApi
): TeamProvisioningStartApi {
  return {
    createTeam: source.createTeam.bind(source),
    launchTeam: source.launchTeam.bind(source),
  };
}

export function bindTeamProvisioningStatusApi(
  source: TeamProvisioningStatusApi
): TeamProvisioningStatusApi {
  return {
    getProvisioningStatus: source.getProvisioningStatus.bind(source),
  };
}

export function bindTeamProvisioningPreflightApi(
  source: TeamProvisioningPreflightApi
): TeamProvisioningPreflightApi {
  return {
    getCliHelpOutput: source.getCliHelpOutput.bind(source),
    async prepareForProvisioning(cwd, opts) {
      validatePrepareModelIndexes(opts);
      return source.prepareForProvisioning.call(source, cwd, opts);
    },
  };
}

export function bindTeamProvisioningRunApi(source: TeamProvisioningRunApi): TeamProvisioningRunApi {
  return {
    cancelProvisioning: source.cancelProvisioning.bind(source),
    hasProvisioningRun: source.hasProvisioningRun.bind(source),
  };
}

export function bindTeamTaskActivityRepairApi(
  source: TeamTaskActivityRepairApi
): TeamTaskActivityRepairApi {
  return {
    repairStaleTaskActivityIntervalsBeforeSnapshot:
      source.repairStaleTaskActivityIntervalsBeforeSnapshot.bind(source),
  };
}

export function bindTeamRuntimeControlCompatibilityApi(
  source: TeamRuntimeControlCompatibilityApi
): TeamRuntimeControlCompatibilityApi {
  return {
    recordOpenCodeRuntimeBootstrapCheckin:
      source.recordOpenCodeRuntimeBootstrapCheckin.bind(source),
    deliverOpenCodeRuntimeMessage: source.deliverOpenCodeRuntimeMessage.bind(source),
    recordOpenCodeRuntimeTaskEvent: source.recordOpenCodeRuntimeTaskEvent.bind(source),
    recordOpenCodeRuntimeHeartbeat: source.recordOpenCodeRuntimeHeartbeat.bind(source),
    answerOpenCodeRuntimePermission: source.answerOpenCodeRuntimePermission.bind(source),
  };
}

export function bindTeamRuntimeApi(source: TeamRuntimeApi): TeamRuntimeApi {
  return {
    getRuntimeState: source.getRuntimeState.bind(source),
    stopTeam: source.stopTeam.bind(source),
    isTeamAlive: source.isTeamAlive.bind(source),
    getAliveTeams: source.getAliveTeams.bind(source),
    getCurrentRunId: source.getCurrentRunId.bind(source),
  };
}

export function bindTeamHttpRuntimeApi(source: TeamHttpRuntimeApi): TeamHttpRuntimeApi {
  return {
    getRuntimeState: source.getRuntimeState.bind(source),
    stopTeam: source.stopTeam.bind(source),
    getAliveTeams: source.getAliveTeams.bind(source),
  };
}

export function bindTeamHttpDataApi(source: TeamHttpDataApi): TeamHttpDataApi {
  return {
    listTeams: source.listTeams.bind(source),
    getTeamData: source.getTeamData.bind(source),
    getSavedRequest: source.getSavedRequest.bind(source),
    createTeamConfig: source.createTeamConfig.bind(source),
  };
}

export function bindTeamHttpHandlerApis(
  source: TeamProvisioningStartApi &
    TeamProvisioningStatusApi &
    TeamTaskActivityRepairApi &
    TeamHttpRuntimeApi &
    TeamRuntimeControlCompatibilityApi
): TeamHttpHandlerApis {
  return {
    provisioningStart: bindTeamProvisioningStartApi(source),
    provisioningStatus: bindTeamProvisioningStatusApi(source),
    taskActivity: bindTeamTaskActivityRepairApi(source),
    runtime: bindTeamHttpRuntimeApi(source),
    runtimeControl: bindTeamRuntimeControlCompatibilityApi(source),
  };
}

export function bindTeamIpcHandlerApis(
  source: TeamProvisioningStartApi &
    TeamProvisioningStatusApi &
    TeamProvisioningPreflightApi &
    TeamProvisioningRunApi &
    TeamTaskActivityRepairApi &
    TeamRuntimeApi &
    TeamMemberLifecycleApi &
    TeamDiagnosticsApi &
    TeamClaudeLogsApi &
    TeamMessagingApi &
    TeamToolApprovalApi
): TeamIpcHandlerApis {
  return {
    provisioningStart: bindTeamProvisioningStartApi(source),
    provisioningStatus: bindTeamProvisioningStatusApi(source),
    preflight: bindTeamProvisioningPreflightApi(source),
    provisioningRun: bindTeamProvisioningRunApi(source),
    taskActivity: bindTeamTaskActivityRepairApi(source),
    runtime: bindTeamRuntimeApi(source),
    memberLifecycle: bindTeamMemberLifecycleApi(source),
    diagnostics: bindTeamDiagnosticsApi(source),
    claudeLogs: bindTeamClaudeLogsApi(source),
    messaging: bindTeamMessagingApi(source),
    toolApproval: bindTeamToolApprovalApi(source),
  };
}

export function bindTeamMemberLifecycleApi(source: TeamMemberLifecycleApi): TeamMemberLifecycleApi {
  return {
    getMemberSpawnStatuses: source.getMemberSpawnStatuses.bind(source),
    runLiveRosterMutation: source.runLiveRosterMutation.bind(source),
    attachLiveRosterMember: source.attachLiveRosterMember.bind(source),
    detachLiveRosterMember: source.detachLiveRosterMember.bind(source),
    restartMember: source.restartMember.bind(source),
    retryFailedOpenCodeSecondaryLanes: source.retryFailedOpenCodeSecondaryLanes.bind(source),
    skipMemberForLaunch: source.skipMemberForLaunch.bind(source),
  };
}

export function bindTeamDiagnosticsApi(source: TeamDiagnosticsApi): TeamDiagnosticsApi {
  return {
    getLeadActivityState: source.getLeadActivityState.bind(source),
    getLeadContextUsage: source.getLeadContextUsage.bind(source),
    getTeamAgentRuntimeSnapshot: source.getTeamAgentRuntimeSnapshot.bind(source),
  };
}

export function bindTeamClaudeLogsApi(source: TeamClaudeLogsApi): TeamClaudeLogsApi {
  return {
    getClaudeLogs: source.getClaudeLogs.bind(source),
  };
}

export function bindTeamMessagingApi(source: TeamMessagingApi): TeamMessagingApi {
  return {
    sendMessageToTeam: source.sendMessageToTeam.bind(source),
    relayOpenCodeMemberInboxMessages: source.relayOpenCodeMemberInboxMessages.bind(source),
    relayLeadInboxMessages: source.relayLeadInboxMessages.bind(source),
    getOpenCodeRuntimeDeliveryStatus: source.getOpenCodeRuntimeDeliveryStatus.bind(source),
    resolveRuntimeRecipientProviderId: source.resolveRuntimeRecipientProviderId.bind(source),
    getLiveLeadProcessMessages: source.getLiveLeadProcessMessages.bind(source),
    getCurrentLeadSessionId: source.getCurrentLeadSessionId.bind(source),
    pushLiveLeadProcessMessage: source.pushLiveLeadProcessMessage.bind(source),
  };
}

export function bindTeamCrossTeamMessagingApi(
  source: TeamCrossTeamMessagingApi
): TeamCrossTeamMessagingApi {
  return {
    resolveCrossTeamReplyMetadata: source.resolveCrossTeamReplyMetadata.bind(source),
    registerPendingCrossTeamReplyExpectation:
      source.registerPendingCrossTeamReplyExpectation.bind(source),
    clearPendingCrossTeamReplyExpectation:
      source.clearPendingCrossTeamReplyExpectation.bind(source),
    isTeamAlive: source.isTeamAlive.bind(source),
    relayInboxFileToLiveRecipient: source.relayInboxFileToLiveRecipient.bind(source),
    relayLeadInboxMessages: source.relayLeadInboxMessages.bind(source),
  };
}

export function bindTeamToolApprovalApi(source: TeamToolApprovalApi): TeamToolApprovalApi {
  return {
    getPendingToolApprovalFilePath: source.getPendingToolApprovalFilePath.bind(source),
    getPendingToolApprovalFileTarget: source.getPendingToolApprovalFileTarget.bind(source),
    respondToToolApproval: source.respondToToolApproval.bind(source),
    updateToolApprovalSettings: source.updateToolApprovalSettings.bind(source),
  };
}
