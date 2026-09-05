import { createLogger } from '@shared/utils/logger';

import { purgeStaleOpenCodeHostStartupLocksBeforeLaunch } from '../opencode/bridge/OpenCodeHostStartupLockCleanup';
import { whenOpenCodeStartupRuntimeSweepSettled } from '../opencode/bridge/OpenCodeStartupSweepGate';

import type { OpenCodeRuntimeControlAck, OpenCodeRuntimeControlApi } from '../runtime-control';
import type { TeamProvisioningStatusApi as FeatureTeamProvisioningStatusApi } from '@features/team-provisioning/contracts';
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

const logger = createLogger('Service:TeamProvisioningApis');

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

export type TeamProvisioningStatusApi = FeatureTeamProvisioningStatusApi;

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
  renameDraftTeam(oldTeamName: string, newTeamName: string): Promise<void>;
}

/**
 * Snapshot reads behind the HTTP member diagnostics route. Same two snapshots
 * the renderer's member detail dialog builds its view from, but through the
 * write-free variants: a diagnostics GET must never persist runtime state.
 *
 * The runtime snapshot is built from a member spawn status projection of its
 * own unless it is handed one, which is why the route reads the statuses first
 * and passes them in: one projection answers the whole response, and both
 * halves of it then describe the same run.
 */
export interface TeamHttpMemberDiagnosticsApi {
  getMemberSpawnStatusesReadOnly(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getTeamAgentRuntimeSnapshotReadOnly(
    teamName: string,
    options?: { memberSpawnStatuses?: MemberSpawnStatusesSnapshot }
  ): Promise<TeamAgentRuntimeSnapshot>;
}

export interface TeamHttpHandlerApis {
  provisioningStart: TeamProvisioningStartApi;
  provisioningStatus: TeamProvisioningStatusApi;
  taskActivity: TeamTaskActivityRepairApi;
  runtime: TeamHttpRuntimeApi;
  runtimeControl: TeamRuntimeControlCompatibilityApi;
  memberDiagnostics: TeamHttpMemberDiagnosticsApi;
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
  runLiveRosterMutation(teamName: string, mutation: () => Promise<void>): Promise<void>;
  tryRunLiveRosterMutation?(teamName: string, mutation: () => Promise<void>): Promise<boolean>;
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
    /** Exact scoped message confirmed by the recent native-lead delivery ledger. */
    recentlyDeliveredMessageId?: string;
    /** Exact message verified in the durable inbox for a native non-lead recipient. */
    durablyStoredMessageId?: string;
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

export interface TeamProvisioningStartHookInput {
  teamName: string;
  request: TeamCreateRequest | TeamLaunchRequest;
  onProgress: (progress: TeamProvisioningProgress) => void;
}

export function bindTeamProvisioningStartApi(
  source: TeamProvisioningStartApi,
  options: {
    /**
     * Runs immediately before every create and every launch. It is a
     * preparation step, never a precondition: a failure is swallowed here so
     * that nothing it does can be the reason a team fails to start.
     */
    beforeStart?: (input: TeamProvisioningStartHookInput) => Promise<void>;
  } = {}
): TeamProvisioningStartApi {
  const beforeStart = options.beforeStart;
  if (!beforeStart) {
    return {
      createTeam: source.createTeam.bind(source),
      launchTeam: source.launchTeam.bind(source),
    };
  }
  const runBeforeStart = async (input: TeamProvisioningStartHookInput): Promise<void> => {
    try {
      await beforeStart(input);
    } catch (error) {
      // Durable, not a warning: the start is going ahead regardless, so there
      // is nothing for a developer to act on in the moment - but the line has
      // to survive for whoever asks later why a launch was slow.
      logger.diagnostic(
        `opencode_pre_start_preparation_failed team=${input.teamName} reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error)
        )}`
      );
    }
  };
  return {
    async createTeam(request, onProgress) {
      await runBeforeStart({ teamName: request.teamName, request, onProgress });
      return source.createTeam.call(source, request, onProgress);
    },
    async launchTeam(request, onProgress) {
      await runBeforeStart({ teamName: request.teamName, request, onProgress });
      return source.launchTeam.call(source, request, onProgress);
    },
  };
}

/**
 * The startup sweep only reaps `opencode serve` hosts, so a start that cannot
 * produce one has nothing to lose to it and must never pay the wait. A start
 * whose provider is not stated is resolved later from the saved config and can
 * still be OpenCode, so it keeps the wait. A launch request carries no roster:
 * a mixed team whose lead is not OpenCode relies on the sweep's own start-time
 * fence rather than on this gate.
 */
function startRequestMayRaceOpenCodeStartupSweep(
  request: TeamCreateRequest | TeamLaunchRequest
): boolean {
  if (request.providerId === undefined || request.providerId === 'opencode') {
    return true;
  }
  const members = 'members' in request ? request.members : undefined;
  return members?.some((member) => member.providerId === 'opencode') === true;
}

function buildStartupSweepWaitProgress(teamName: string): TeamProvisioningProgress {
  const observedAt = new Date().toISOString();
  return {
    // No run exists before `beforeStart` returns. The pending prefix is the
    // shape the UI already uses for its own optimistic entry, so the real run
    // replaces this card instead of competing with it.
    runId: `pending:${teamName}:opencode-startup-sweep`,
    teamName,
    state: 'validating',
    message: 'Waiting for the startup runtime host cleanup to finish...',
    startedAt: observedAt,
    updatedAt: observedAt,
  };
}

/**
 * The pre-start step both entry points install. It clears the two things an
 * earlier run leaves in a new launch's way: the startup sweep still reaping
 * hosts, which a launch waits out rather than races, and the OpenCode host
 * startup locks a clean stop never released, on which the orchestrator waits
 * one at a time during launch readiness - enough of them and a launch sits in
 * "spawning" for minutes over files that guard nothing.
 */
function bindOpenCodeStartPreparation(source: {
  getAliveTeams(): string[];
}): (input: TeamProvisioningStartHookInput) => Promise<void> {
  return async ({ teamName, request, onProgress }) => {
    // Belt and braces against the startup runtime sweep: it force-reaps managed
    // hosts, and a launch that starts inside that window can lose its own
    // readiness-probe host to it. Serialise instead of racing.
    if (startRequestMayRaceOpenCodeStartupSweep(request)) {
      await whenOpenCodeStartupRuntimeSweepSettled({
        logWaited: (message) => logger.diagnostic(message),
        // A silent multi-second park reads as a frozen UI and makes an HTTP
        // client retry into a duplicate launch.
        onWaitStart: () => onProgress(buildStartupSweepWaitProgress(teamName)),
      });
    }
    await purgeStaleOpenCodeHostStartupLocksBeforeLaunch({
      teamName,
      aliveTeams: source.getAliveTeams(),
      // Durable, not a warning: this is the counter that explains a launch
      // which was slow before and is not any more.
      logRemoved: (message) => logger.diagnostic(message),
      logWarning: (message) => logger.warn(message),
    });
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
    renameDraftTeam: source.renameDraftTeam.bind(source),
  };
}

export function bindTeamHttpHandlerApis(
  source: TeamProvisioningStartApi &
    TeamProvisioningStatusApi &
    TeamTaskActivityRepairApi &
    TeamHttpRuntimeApi &
    TeamRuntimeControlCompatibilityApi &
    TeamHttpMemberDiagnosticsApi
): TeamHttpHandlerApis {
  return {
    provisioningStart: bindTeamProvisioningStartApi(source, {
      beforeStart: bindOpenCodeStartPreparation(source),
    }),
    provisioningStatus: bindTeamProvisioningStatusApi(source),
    taskActivity: bindTeamTaskActivityRepairApi(source),
    runtime: bindTeamHttpRuntimeApi(source),
    runtimeControl: bindTeamRuntimeControlCompatibilityApi(source),
    memberDiagnostics: bindTeamHttpMemberDiagnosticsApi(source),
  };
}

export function bindTeamHttpMemberDiagnosticsApi(
  source: TeamHttpMemberDiagnosticsApi
): TeamHttpMemberDiagnosticsApi {
  return {
    getMemberSpawnStatusesReadOnly: source.getMemberSpawnStatusesReadOnly.bind(source),
    getTeamAgentRuntimeSnapshotReadOnly: source.getTeamAgentRuntimeSnapshotReadOnly.bind(source),
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
    provisioningStart: bindTeamProvisioningStartApi(source, {
      beforeStart: bindOpenCodeStartPreparation(source),
    }),
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
    ...(source.tryRunLiveRosterMutation
      ? { tryRunLiveRosterMutation: source.tryRunLiveRosterMutation.bind(source) }
      : {}),
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
