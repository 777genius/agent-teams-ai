import type { OpenCodeRuntimeControlAck, OpenCodeRuntimeControlApi } from '../runtime-control';
import type {
  AgentActionMode,
  AttachmentPayload,
  InboxMessage,
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberSpawnStatusesSnapshot,
  OpenCodeRuntimeDeliveryStatus,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
  RetryFailedOpenCodeSecondaryLanesResult,
  TaskRef,
  TeamAgentRuntimeSnapshot,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamRuntimeState,
  TeamSummary,
  TeamViewSnapshot,
  ToolApprovalSettings,
} from '@shared/types/team';

export interface TeamProvisioningStartApi {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

export interface TeamProvisioningStatusApi {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}

export interface TeamProvisioningRunApi {
  cancelProvisioning(runId: string): Promise<void>;
  hasProvisioningRun(teamName: string): boolean;
}

export interface TeamTaskActivityRepairApi {
  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void>;
}

export type { OpenCodeRuntimeControlAck };

export interface TeamProvisioningPrepareOptions {
  forceFresh?: boolean;
  providerId?: TeamProviderId;
  providerIds?: TeamProviderId[];
  modelIds?: string[];
  modelChecks?: TeamProvisioningModelCheckRequest[];
  limitContext?: boolean;
  modelVerificationMode?: TeamProvisioningModelVerificationMode;
}

export interface TeamProvisioningPreflightApi {
  getCliHelpOutput(): Promise<string>;
  prepareForProvisioning(
    cwd?: string,
    opts?: TeamProvisioningPrepareOptions
  ): Promise<TeamProvisioningPrepareResult>;
}

function assertDensePrepareModelArray(
  values: readonly unknown[] | undefined,
  field: 'modelIds' | 'modelChecks'
): void {
  if (!values) {
    return;
  }

  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) {
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

export type TeamRuntimeControlCompatibilityApi = OpenCodeRuntimeControlApi;

export interface TeamRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): boolean;
  getAliveTeams(): string[];
  getCurrentRunId(teamName: string): string | null;
}

export interface TeamHttpRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  getAliveTeams(): string[];
}

export interface TeamHttpDataApi {
  listTeams(): Promise<TeamSummary[]>;
  getTeamData(teamName: string): Promise<TeamViewSnapshot>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
}

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

export type TeamLiveRosterAttachReason = 'member_added' | 'member_restored' | 'member_updated';

export interface TeamMemberLifecycleApi {
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: TeamLiveRosterAttachReason }
  ): Promise<void>;
  detachLiveRosterMember(teamName: string, memberName: string): Promise<void>;
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  skipMemberForLaunch(teamName: string, memberName: string): Promise<void>;
}

export interface TeamDiagnosticsApi {
  getLeadActivityState(teamName: string): LeadActivitySnapshot;
  getLeadContextUsage(teamName: string): LeadContextUsageSnapshot;
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}

export interface TeamClaudeLogsApi {
  getClaudeLogs(teamName: string, query?: TeamClaudeLogsQuery): Promise<TeamClaudeLogsResponse>;
}

export type TeamMessageAttachmentPayload = Pick<AttachmentPayload, 'data' | 'mimeType'> &
  Partial<Pick<AttachmentPayload, 'filename'>>;

export type TeamMessagingDeliverySource =
  | 'watcher'
  | 'ui-send'
  | 'manual'
  | 'watchdog'
  | 'member-work-sync-review-pickup';

export interface TeamMessagingDeliveryMetadata {
  replyRecipient?: string;
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
}

export interface TeamOpenCodeMemberInboxRelayOptions {
  onlyMessageId?: string;
  source?: TeamMessagingDeliverySource;
  deliveryMetadata?: TeamMessagingDeliveryMetadata;
}

export interface TeamOpenCodeMemberInboxDelivery {
  delivered: boolean;
  accepted?: boolean;
  responsePending?: boolean;
  acceptanceUnknown?: boolean;
  responseState?: OpenCodeRuntimeDeliveryStatus['responseState'];
  ledgerStatus?: OpenCodeRuntimeDeliveryStatus['ledgerStatus'];
  ledgerRecordId?: string;
  laneId?: string;
  visibleReplyMessageId?: string;
  visibleReplyCorrelation?: OpenCodeRuntimeDeliveryStatus['visibleReplyCorrelation'];
  queuedBehindMessageId?: string;
  reason?: string;
  diagnostics?: string[];
  userVisibleImpact?: OpenCodeRuntimeDeliveryUserVisibleImpact;
}

export interface TeamOpenCodeMemberInboxRelayResult {
  relayed: number;
  attempted: number;
  delivered: number;
  failed: number;
  lastDelivery?: TeamOpenCodeMemberInboxDelivery;
  diagnostics?: string[];
}

export interface TeamMessagingApi {
  sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: TeamMessageAttachmentPayload[]
  ): Promise<void>;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: TeamOpenCodeMemberInboxRelayOptions
  ): Promise<TeamOpenCodeMemberInboxRelayResult>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
  getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
  resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined>;
  getLiveLeadProcessMessages(teamName: string): InboxMessage[];
  getCurrentLeadSessionId(teamName: string): string | null;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
}

export interface TeamCrossTeamMessagingApi {
  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null;
  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  isTeamAlive(teamName: string): boolean;
  relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options?: TeamOpenCodeMemberInboxRelayOptions
  ): Promise<{
    kind: 'ignored' | 'native_lead' | 'native_member_noop' | 'opencode_member';
    relayed: number;
    diagnostics?: string[];
    lastDelivery?: TeamOpenCodeMemberInboxDelivery;
  }>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
}

export interface TeamToolApprovalApi {
  respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>;
  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void;
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
    respondToToolApproval: source.respondToToolApproval.bind(source),
    updateToolApprovalSettings: source.updateToolApprovalSettings.bind(source),
  };
}
