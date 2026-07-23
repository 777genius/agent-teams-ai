import {
  estimateAgentAttachmentSerializedPayloadBytes,
  MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES,
} from '@features/agent-attachments/contracts';
import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { addMainBreadcrumb } from '@main/sentry';
import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import { markTeamEngaged } from '@main/services/infrastructure/teamWatchScope';
import {
  getTeamDataWorkerClient,
  isTeamDataWorkerFatalError,
} from '@main/services/team/TeamDataWorkerClient';
import { getAppIconPath } from '@main/utils/appIcon';
import { getAppDataPath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { stripMarkdown } from '@main/utils/textFormatting';
import { withTimeoutValue } from '@main/utils/withTimeoutValue';
import {
  TEAM_ADD_MEMBER,
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_INITIAL_GIT_COMMIT,
  TEAM_DELETE_DRAFT,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_DELETE_TEAM,
  TEAM_GET_AGENT_RUNTIME,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_CLAUDE_LOGS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_SAVED_REQUEST,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_GET_WORKTREE_GIT_STATUS,
  TEAM_INITIALIZE_GIT_REPOSITORY,
  TEAM_KILL_PROCESS,
  TEAM_LAUNCH,
  TEAM_LAUNCH_FAILURE_DIAGNOSTICS,
  TEAM_LEAD_ACTIVITY,
  TEAM_LEAD_CONTEXT,
  TEAM_LIST,
  TEAM_MEMBER_SPAWN_STATUSES,
  TEAM_PERMANENTLY_DELETE,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_PROVISIONING_PROGRESS,
  TEAM_PROVISIONING_STATUS,
  TEAM_REMOVE_MEMBER,
  TEAM_REPLACE_MEMBERS,
  TEAM_RESTART_MEMBER,
  TEAM_RESTORE,
  TEAM_RESTORE_MEMBER,
  TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
  TEAM_SAVE_TASK_ATTACHMENT,
  TEAM_SEND_MESSAGE,
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  TEAM_SKIP_MEMBER_FOR_LAUNCH,
  TEAM_STOP,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_VALIDATE_CLI_ARGS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { createSafeAppError } from '@shared/contracts/hosted';
import {
  extractFlagsFromHelp,
  extractUserFlags,
  PROTECTED_CLI_FLAGS,
} from '@shared/utils/cliArgsParser';
import {
  formatEffortLevelListForProvider,
  isTeamEffortLevelForProvider,
} from '@shared/utils/effortLevels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import {
  buildStandaloneSlashCommandMeta,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import crypto from 'crypto';
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, Notification } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigManager } from '../services/infrastructure/ConfigManager';
import { NotificationManager } from '../services/infrastructure/NotificationManager';
import { gitIdentityResolver } from '../services/parsing/GitIdentityResolver';
import {
  buildActionModeAgentBlock,
  isAgentActionMode,
} from '../services/team/actionModeInstructions';
import {
  cloneLaunchIoGovernorPayload,
  type LaunchIoGovernor,
} from '../services/team/LaunchIoGovernor';
import {
  buildReplaceMembersDiff,
  buildReplaceMembersSummaryMessage,
} from '../services/team/memberUpdateNotifications';
import { buildOpenCodeRuntimeDeliveryUserVisibleImpact } from '../services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import { TeamAttachmentStore } from '../services/team/TeamAttachmentStore';
import { TeamConfigReader } from '../services/team/TeamConfigReader';
import { readTeamLaunchFailureDiagnosticsBundle } from '../services/team/TeamLaunchFailureArtifactPack';
import { TeamMembersMetaStore } from '../services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../services/team/TeamMetaStore';
import { TeamTaskAttachmentStore } from '../services/team/TeamTaskAttachmentStore';
import { TeamWorktreeGitService } from '../services/team/TeamWorktreeGitService';

import { validateTaskRefs } from './validation/taskRefs';
import {
  validateFromField,
  validateMemberName,
  validateTaskId,
  validateTeammateName,
  validateTeamName,
} from './guards';

import type {
  BranchStatusService,
  MemberStatsComputer,
  TeamDataService,
  TeamLogSourceTracker,
  TeammateToolTracker,
  TeamMemberLogsFinder,
} from '../services';
import type {
  TeamClaudeLogsApi,
  TeamDiagnosticsApi,
  TeamIpcHandlerApis,
  TeamMemberLifecycleApi,
  TeamMessagingApi,
  TeamOpenCodeMemberInboxRelayResult,
  TeamProvisioningPreflightApi,
  TeamProvisioningRunApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamRuntimeApi,
} from '../services/team/contracts/TeamProvisioningApis';
import type { TeamBackupService } from '../services/team/TeamBackupService';
import type { TeamMembersMetaFile } from '../services/team/TeamMembersMetaStore';
import type { TeamLifecycleReadHost } from '@main/composition/hosted/teamLifecycleReadComposition';
import type {
  AgentActionMode,
  AttachmentFileData,
  AttachmentMeta,
  AttachmentPayload,
  EffortLevel,
  IpcResult,
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberFullStats,
  MemberLogSummary,
  MemberSpawnStatusesSnapshot,
  OpenCodeRuntimeDeliveryStatus,
  RetryFailedOpenCodeSecondaryLanesResult,
  SendMessageRequest,
  SendMessageResult,
  TaskAttachmentMeta,
  TeamAgentRuntimeSnapshot,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamFastMode,
  TeamLaunchFailureDiagnosticsBundle,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMessageNotificationData,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamSummary,
  TeamUpdateConfigRequest,
  TeamWorktreeGitStatus,
} from '@shared/types';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

const logger = createLogger('IPC:teams');
// Runtime relay continues in the background after this race; keep sendMessage IPC off the
// 25s OpenCode turn-settled guard while still giving prompt acceptance/reconcile time.
const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS = 6_000;
const OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS = 1_000;
const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON =
  'opencode_runtime_delivery_ui_timeout_pending';

type OpenCodeMemberInboxRelayResult = TeamOpenCodeMemberInboxRelayResult;
type OpenCodeMemberInboxDelivery = NonNullable<OpenCodeMemberInboxRelayResult['lastDelivery']>;

type VisibleDirectReplyProtocol = 'send_message' | 'agent_teams_message_send';

function resolveVisibleDirectReplyProtocol(input: {
  providerId?: TeamProviderId;
  isLeadRecipient: boolean;
  replyRecipient: string;
}): VisibleDirectReplyProtocol {
  if (
    !input.isLeadRecipient &&
    input.replyRecipient.trim().toLowerCase() === 'user' &&
    input.providerId === 'codex'
  ) {
    return 'agent_teams_message_send';
  }

  return 'send_message';
}
async function waitForOpenCodeRuntimeRelayForUi(input: {
  messaging: TeamMessagingApi;
  teamName: string;
  memberName: string;
  messageId: string;
  relayPromise: Promise<OpenCodeMemberInboxRelayResult>;
  timeoutMs?: number;
}): Promise<OpenCodeMemberInboxRelayResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  void input.relayPromise.then(
    (relay) => {
      if (!timedOut) return;
      const delivery = relay.lastDelivery;
      if (delivery && !delivery.delivered && delivery.reason !== 'recipient_is_not_opencode') {
        logger.warn(
          `OpenCode runtime delivery after sendMessage completed after UI timeout for teammate "${input.memberName}" with failure: ${
            delivery.reason ?? 'unknown error'
          }`
        );
      }
    },
    (error: unknown) => {
      if (!timedOut) return;
      logger.warn(
        `OpenCode runtime delivery after sendMessage rejected after UI timeout for teammate "${input.memberName}": ${getErrorMessage(error)}`
      );
    }
  );

  try {
    const outcome = await Promise.race<
      { kind: 'relay'; relay: OpenCodeMemberInboxRelayResult } | { kind: 'timeout' }
    >([
      input.relayPromise.then((relay) => ({ kind: 'relay' as const, relay })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve({ kind: 'timeout' });
        }, input.timeoutMs ?? OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    if (outcome.kind === 'relay') {
      return await enrichBareOpenCodeRuntimeRelayResultForUi({
        ...input,
        relay: outcome.relay,
      });
    }

    try {
      const status = await withTimeoutValue(
        input.messaging.getOpenCodeRuntimeDeliveryStatus(input.teamName, input.messageId),
        OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
        null
      );
      if (status) {
        return openCodeRuntimeDeliveryStatusToRelayResult(status);
      }
    } catch (error) {
      const reason = getErrorMessage(error);
      logger.warn(
        `OpenCode runtime delivery status after UI timeout failed for teammate "${input.memberName}": ${reason}`
      );
      return buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult([
        `${OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON}: status lookup failed: ${reason}`,
      ]);
    }

    return buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function enrichBareOpenCodeRuntimeRelayResultForUi(input: {
  messaging: TeamMessagingApi;
  teamName: string;
  memberName: string;
  messageId: string;
  relay: OpenCodeMemberInboxRelayResult;
}): Promise<OpenCodeMemberInboxRelayResult> {
  if (!shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay(input.relay)) {
    return input.relay;
  }

  try {
    const status = await withTimeoutValue(
      input.messaging.getOpenCodeRuntimeDeliveryStatus(input.teamName, input.messageId),
      OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
      null
    );
    return status ? openCodeRuntimeDeliveryStatusToRelayResult(status) : input.relay;
  } catch (error) {
    logger.warn(
      `OpenCode runtime delivery status enrichment failed for teammate "${input.memberName}": ${getErrorMessage(error)}`
    );
    return input.relay;
  }
}

function shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay(
  relay: OpenCodeMemberInboxRelayResult
): boolean {
  const delivery = relay.lastDelivery;
  if (!delivery?.delivered) {
    return false;
  }
  return (
    typeof delivery.accepted !== 'boolean' &&
    typeof delivery.responsePending !== 'boolean' &&
    !delivery.responseState &&
    !delivery.ledgerStatus &&
    !delivery.ledgerRecordId &&
    !delivery.laneId &&
    !delivery.userVisibleImpact
  );
}

function openCodeRuntimeDeliveryStatusToRelayResult(
  status: OpenCodeRuntimeDeliveryStatus
): OpenCodeMemberInboxRelayResult {
  const lastDelivery: OpenCodeMemberInboxDelivery = {
    delivered: status.delivered,
    ...(typeof status.accepted === 'boolean' ? { accepted: status.accepted } : {}),
    ...(typeof status.responsePending === 'boolean'
      ? { responsePending: status.responsePending }
      : {}),
    ...(typeof status.acceptanceUnknown === 'boolean'
      ? { acceptanceUnknown: status.acceptanceUnknown }
      : {}),
    ...(status.responseState ? { responseState: status.responseState } : {}),
    ...(status.ledgerStatus ? { ledgerStatus: status.ledgerStatus } : {}),
    ...(status.visibleReplyMessageId
      ? { visibleReplyMessageId: status.visibleReplyMessageId }
      : {}),
    ...(status.visibleReplyCorrelation
      ? { visibleReplyCorrelation: status.visibleReplyCorrelation }
      : {}),
    ...(status.ledgerRecordId ? { ledgerRecordId: status.ledgerRecordId } : {}),
    ...(status.laneId ? { laneId: status.laneId } : {}),
    ...(status.queuedBehindMessageId
      ? { queuedBehindMessageId: status.queuedBehindMessageId }
      : {}),
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.diagnostics ? { diagnostics: status.diagnostics } : {}),
    ...(shouldPreserveOpenCodeRuntimeDeliveryStatusImpact(status)
      ? { userVisibleImpact: status.userVisibleImpact }
      : {}),
  };
  return {
    relayed: 0,
    attempted: 1,
    delivered: status.delivered && status.responsePending !== true ? 1 : 0,
    failed: status.delivered ? 0 : 1,
    lastDelivery,
    diagnostics: status.diagnostics,
  };
}

function shouldPreserveOpenCodeRuntimeDeliveryStatusImpact(
  status: OpenCodeRuntimeDeliveryStatus
): boolean {
  if (!status.userVisibleImpact) {
    return false;
  }
  if (
    status.userVisibleImpact.state === 'none' &&
    (status.responsePending === true ||
      status.acceptanceUnknown === true ||
      Boolean(status.queuedBehindMessageId))
  ) {
    return false;
  }
  return true;
}

function buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult(
  extraDiagnostics: string[] = []
): OpenCodeMemberInboxRelayResult {
  const diagnostics = [OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON, ...extraDiagnostics];
  return {
    relayed: 0,
    attempted: 1,
    delivered: 0,
    failed: 1,
    lastDelivery: {
      delivered: true,
      accepted: false,
      responsePending: true,
      acceptanceUnknown: true,
      responseState: 'not_observed',
      reason: OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON,
      diagnostics,
    },
  };
}

function getWorkerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getFatalTeamDataWorkerFailureMessage(error: unknown): string | null {
  if (!isTeamDataWorkerFatalError(error)) {
    return null;
  }
  const message = getWorkerErrorMessage(error);
  return `TEAM_DATA_WORKER_FAILED: ${message}`;
}

function invalidateTeamRosterSnapshotCaches(teamName: string): void {
  TeamConfigReader.invalidateTeam(teamName);
  const teamDataService = getTeamDataService();
  teamDataService.invalidateMessageFeed(teamName);
  teamDataService.invalidateTeamRuntimeAdvisories(teamName);
  const workerClient = getTeamDataWorkerClient();
  workerClient.invalidateTeamConfig(teamName);
  workerClient.invalidateMemberRuntimeAdvisory(teamName);
}

async function getDurableLeadTeammateRoster(
  teamName: string,
  leadName: string
): Promise<{ name: string; role?: string }[]> {
  const normalize = (name: string | undefined | null): string => name?.trim().toLowerCase() ?? '';
  const leadLower = normalize(leadName);
  const reserved = new Set(['team-lead', 'user', leadLower].filter((value) => value.length > 0));

  try {
    const members = await new TeamMembersMetaStore().getMembers(teamName);
    const teammates = members
      .filter((member) => !member.removedAt)
      .filter((member) => {
        const lower = normalize(member.name);
        return lower.length > 0 && !reserved.has(lower);
      })
      .map((member) => ({
        name: member.name.trim(),
        role:
          typeof member.role === 'string' && member.role.trim().length > 0
            ? member.role.trim()
            : undefined,
      }));
    if (teammates.length > 0) return teammates;
  } catch (error) {
    logger.debug(
      `[teams:sendMessage] Failed to read members.meta roster for "${teamName}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const data = await getTeamDataService().getTeamData(teamName);
    return data.members
      .filter((member) => !member.removedAt)
      .filter((member) => {
        const lower = normalize(member.name);
        return lower.length > 0 && !reserved.has(lower);
      })
      .map((member) => ({
        name: member.name.trim(),
        role:
          typeof member.role === 'string' && member.role.trim().length > 0
            ? member.role.trim()
            : undefined,
      }));
  } catch (error) {
    logger.debug(
      `[teams:sendMessage] Failed to read fallback team roster for "${teamName}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

function buildLeadRosterContextBlock(
  teamName: string,
  leadName: string,
  teammates: { name: string; role?: string }[]
): string | null {
  if (teammates.length === 0) return null;

  const summary = teammates
    .map((member) => (member.role ? `${member.name} (${member.role})` : member.name))
    .join(', ');

  return [
    `Current durable team context:`,
    `- Team name: ${teamName}`,
    `- You are the live team lead "${leadName}"`,
    `- Persistent teammates currently configured: ${summary}`,
    `- This team is NOT in solo mode`,
    `- If the user asks who is on the team, answer from this durable roster unless newer durable state explicitly says otherwise.`,
  ].join('\n');
}

function buildLeadDirectDelegateAckBlock(actionMode?: AgentActionMode): string | null {
  if (actionMode !== 'delegate') return null;

  return wrapAgentBlock(
    [
      'DELEGATE MODE USER ACK CONTRACT:',
      'Before any task creation, delegation, or other tool use, begin your next assistant response with one short human-readable acknowledgement to the user.',
      'That acknowledgement must be visible plain text, not only an agent-only block.',
      'Make the acknowledgement at least 40 characters so it is preserved in the Messages panel.',
      'After that visible acknowledgement, continue with delegation/orchestration in the same turn.',
    ].join('\n')
  );
}

let teamDataService: TeamDataService | null = null;
let teamProvisioningStartApi: TeamProvisioningStartApi | null = null;
let teamProvisioningStatusApi: TeamProvisioningStatusApi | null = null;
let teamProvisioningPreflightApi: TeamProvisioningPreflightApi | null = null;
let teamProvisioningRunApi: TeamProvisioningRunApi | null = null;
let teamRuntimeApi: TeamRuntimeApi | null = null;
let teamMemberLifecycleApi: TeamMemberLifecycleApi | null = null;
let teamDiagnosticsApi: TeamDiagnosticsApi | null = null;
let teamClaudeLogsApi: TeamClaudeLogsApi | null = null;
let teamMessagingApi: TeamMessagingApi | null = null;
let teamMemberLogsFinder: TeamMemberLogsFinder | null = null;
let memberStatsComputer: MemberStatsComputer | null = null;
let teamBackupService: TeamBackupService | null = null;
let teammateToolTracker: TeammateToolTracker | null = null;
let teamLogSourceTracker: TeamLogSourceTracker | null = null;
let branchStatusService: BranchStatusService | null = null;
let launchIoGovernor: LaunchIoGovernor | null = null;

const attachmentStore = new TeamAttachmentStore();
const taskAttachmentStore = new TeamTaskAttachmentStore();
const teamMetaStore = new TeamMetaStore();
const worktreeGitService = new TeamWorktreeGitService();

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB per file

function isValidStoredAttachmentMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (v.length > 200) return false;
  if (v.includes('\0') || /[\r\n]/.test(v)) return false;
  const slash = v.indexOf('/');
  return slash > 0 && slash < v.length - 1;
}

/**
 * Prevents GC from collecting Notification objects in the deprecated showTeamNativeNotification.
 * @see https://blog.bloomca.me/2025/02/22/electron-mac-notifications.html
 */
const activeTeamNotifications = new Set<Notification>();
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB total

let teamLifecycleReadHost: TeamLifecycleReadHost | null = null;

export function initializeTeamLifecycleReadHandler(host: TeamLifecycleReadHost): void {
  teamLifecycleReadHost = host;
}

function teamLifecycleReadUnavailable(reason: string): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code: 'unavailable', reason });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: true,
  });
}

export async function handleListTeamLifecycle(
  request: unknown
): Promise<CanonicalListTeamLifecycleResult> {
  if (!teamLifecycleReadHost) {
    return teamLifecycleReadUnavailable('identity_storage_unavailable');
  }
  try {
    return await teamLifecycleReadHost.listTeamLifecycle(request);
  } catch {
    return teamLifecycleReadUnavailable('transport_unavailable');
  }
}

export function initializeTeamHandlers(
  service: TeamDataService,
  teamHandlerApis: TeamIpcHandlerApis,
  logsFinder?: TeamMemberLogsFinder,
  statsComputer?: MemberStatsComputer,
  backupService?: TeamBackupService,
  toolTracker?: TeammateToolTracker,
  logSourceTracker?: TeamLogSourceTracker,
  branchTracker?: BranchStatusService,
  ioGovernor?: LaunchIoGovernor
): void {
  teamDataService = service;
  teamProvisioningStartApi = teamHandlerApis.provisioningStart;
  teamProvisioningStatusApi = teamHandlerApis.provisioningStatus;
  teamProvisioningPreflightApi = teamHandlerApis.preflight;
  teamProvisioningRunApi = teamHandlerApis.provisioningRun;
  teamRuntimeApi = teamHandlerApis.runtime;
  teamMemberLifecycleApi = teamHandlerApis.memberLifecycle;
  teamDiagnosticsApi = teamHandlerApis.diagnostics;
  teamClaudeLogsApi = teamHandlerApis.claudeLogs;
  teamMessagingApi = teamHandlerApis.messaging;
  teamMemberLogsFinder = logsFinder ?? null;
  memberStatsComputer = statsComputer ?? null;
  teamBackupService = backupService ?? null;
  teammateToolTracker = toolTracker ?? null;
  teamLogSourceTracker = logSourceTracker ?? null;
  branchStatusService = branchTracker ?? null;
  launchIoGovernor = ioGovernor ?? null;
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(TEAM_LIST, handleListTeams);
  ipcMain.handle(TEAM_SET_PROJECT_BRANCH_TRACKING, handleSetProjectBranchTracking);
  ipcMain.handle(TEAM_SET_TASK_LOG_STREAM_TRACKING, handleSetTaskLogStreamTracking);
  ipcMain.handle(TEAM_SET_TOOL_ACTIVITY_TRACKING, handleSetToolActivityTracking);
  ipcMain.handle(TEAM_GET_CLAUDE_LOGS, handleGetClaudeLogs);
  ipcMain.handle(TEAM_PREPARE_PROVISIONING, handlePrepareProvisioning);
  ipcMain.handle(TEAM_GET_WORKTREE_GIT_STATUS, handleGetWorktreeGitStatus);
  ipcMain.handle(TEAM_INITIALIZE_GIT_REPOSITORY, handleInitializeGitRepository);
  ipcMain.handle(TEAM_CREATE_INITIAL_GIT_COMMIT, handleCreateInitialGitCommit);
  ipcMain.handle(TEAM_CREATE, handleCreateTeam);
  ipcMain.handle(TEAM_LAUNCH, handleLaunchTeam);
  ipcMain.handle(TEAM_PROVISIONING_STATUS, handleProvisioningStatus);
  ipcMain.handle(TEAM_LAUNCH_FAILURE_DIAGNOSTICS, handleLaunchFailureDiagnostics);
  ipcMain.handle(TEAM_CANCEL_PROVISIONING, handleCancelProvisioning);
  ipcMain.handle(TEAM_SEND_MESSAGE, handleSendMessage);
  ipcMain.handle(TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS, handleGetOpenCodeRuntimeDeliveryStatus);
  ipcMain.handle(TEAM_DELETE_TEAM, handleDeleteTeam);
  ipcMain.handle(TEAM_RESTORE, handleRestoreTeam);
  ipcMain.handle(TEAM_PERMANENTLY_DELETE, handlePermanentlyDeleteTeam);
  ipcMain.handle(TEAM_PROCESS_SEND, handleProcessSend);
  ipcMain.handle(TEAM_PROCESS_ALIVE, handleProcessAlive);
  ipcMain.handle(TEAM_ALIVE_LIST, handleAliveList);
  ipcMain.handle(TEAM_STOP, handleStopTeam);
  ipcMain.handle(TEAM_CREATE_CONFIG, handleCreateConfig);
  ipcMain.handle(TEAM_GET_MEMBER_LOGS, handleGetMemberLogs);
  ipcMain.handle(TEAM_GET_LOGS_FOR_TASK, handleGetLogsForTask);
  ipcMain.handle(TEAM_GET_MEMBER_STATS, handleGetMemberStats);
  ipcMain.handle(TEAM_UPDATE_CONFIG, handleUpdateConfig);
  ipcMain.handle(TEAM_ADD_MEMBER, handleAddMember);
  ipcMain.handle(TEAM_REPLACE_MEMBERS, handleReplaceMembers);
  ipcMain.handle(TEAM_REMOVE_MEMBER, handleRemoveMember);
  ipcMain.handle(TEAM_RESTORE_MEMBER, handleRestoreMember);
  ipcMain.handle(TEAM_UPDATE_MEMBER_ROLE, handleUpdateMemberRole);
  ipcMain.handle(TEAM_GET_PROJECT_BRANCH, handleGetProjectBranch);
  ipcMain.handle(TEAM_GET_ATTACHMENTS, handleGetAttachments);
  ipcMain.handle(TEAM_KILL_PROCESS, handleKillProcess);
  ipcMain.handle(TEAM_LEAD_ACTIVITY, handleLeadActivity);
  ipcMain.handle(TEAM_LEAD_CONTEXT, handleLeadContext);
  ipcMain.handle(TEAM_MEMBER_SPAWN_STATUSES, handleMemberSpawnStatuses);
  ipcMain.handle(TEAM_GET_AGENT_RUNTIME, handleGetAgentRuntime);
  ipcMain.handle(
    TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
    handleRetryFailedOpenCodeSecondaryLanes
  );
  ipcMain.handle(TEAM_RESTART_MEMBER, handleRestartMember);
  ipcMain.handle(TEAM_SKIP_MEMBER_FOR_LAUNCH, handleSkipMemberForLaunch);
  ipcMain.handle(TEAM_SHOW_MESSAGE_NOTIFICATION, handleShowMessageNotification);
  ipcMain.handle(TEAM_SAVE_TASK_ATTACHMENT, handleSaveTaskAttachment);
  ipcMain.handle(TEAM_GET_TASK_ATTACHMENT, handleGetTaskAttachment);
  ipcMain.handle(TEAM_DELETE_TASK_ATTACHMENT, handleDeleteTaskAttachment);
  ipcMain.handle(TEAM_VALIDATE_CLI_ARGS, handleValidateCliArgs);
  ipcMain.handle(TEAM_GET_SAVED_REQUEST, handleGetSavedRequest);
  ipcMain.handle(TEAM_DELETE_DRAFT, handleDeleteDraft);
  logger.info('Team handlers registered');
}

export function removeTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_LIST);
  ipcMain.removeHandler(TEAM_SET_PROJECT_BRANCH_TRACKING);
  ipcMain.removeHandler(TEAM_SET_TASK_LOG_STREAM_TRACKING);
  ipcMain.removeHandler(TEAM_SET_TOOL_ACTIVITY_TRACKING);
  ipcMain.removeHandler(TEAM_GET_CLAUDE_LOGS);
  ipcMain.removeHandler(TEAM_PREPARE_PROVISIONING);
  ipcMain.removeHandler(TEAM_GET_WORKTREE_GIT_STATUS);
  ipcMain.removeHandler(TEAM_INITIALIZE_GIT_REPOSITORY);
  ipcMain.removeHandler(TEAM_CREATE_INITIAL_GIT_COMMIT);
  ipcMain.removeHandler(TEAM_CREATE);
  ipcMain.removeHandler(TEAM_LAUNCH);
  ipcMain.removeHandler(TEAM_PROVISIONING_STATUS);
  ipcMain.removeHandler(TEAM_LAUNCH_FAILURE_DIAGNOSTICS);
  ipcMain.removeHandler(TEAM_CANCEL_PROVISIONING);
  ipcMain.removeHandler(TEAM_SEND_MESSAGE);
  ipcMain.removeHandler(TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS);
  ipcMain.removeHandler(TEAM_DELETE_TEAM);
  ipcMain.removeHandler(TEAM_RESTORE);
  ipcMain.removeHandler(TEAM_PERMANENTLY_DELETE);
  ipcMain.removeHandler(TEAM_PROCESS_SEND);
  ipcMain.removeHandler(TEAM_PROCESS_ALIVE);
  ipcMain.removeHandler(TEAM_ALIVE_LIST);
  ipcMain.removeHandler(TEAM_STOP);
  ipcMain.removeHandler(TEAM_CREATE_CONFIG);
  ipcMain.removeHandler(TEAM_GET_MEMBER_LOGS);
  ipcMain.removeHandler(TEAM_GET_LOGS_FOR_TASK);
  ipcMain.removeHandler(TEAM_GET_MEMBER_STATS);
  ipcMain.removeHandler(TEAM_UPDATE_CONFIG);
  ipcMain.removeHandler(TEAM_ADD_MEMBER);
  ipcMain.removeHandler(TEAM_REPLACE_MEMBERS);
  ipcMain.removeHandler(TEAM_REMOVE_MEMBER);
  ipcMain.removeHandler(TEAM_RESTORE_MEMBER);
  ipcMain.removeHandler(TEAM_UPDATE_MEMBER_ROLE);
  ipcMain.removeHandler(TEAM_GET_PROJECT_BRANCH);
  ipcMain.removeHandler(TEAM_GET_ATTACHMENTS);
  ipcMain.removeHandler(TEAM_KILL_PROCESS);
  ipcMain.removeHandler(TEAM_LEAD_ACTIVITY);
  ipcMain.removeHandler(TEAM_LEAD_CONTEXT);
  ipcMain.removeHandler(TEAM_MEMBER_SPAWN_STATUSES);
  ipcMain.removeHandler(TEAM_GET_AGENT_RUNTIME);
  ipcMain.removeHandler(TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES);
  ipcMain.removeHandler(TEAM_RESTART_MEMBER);
  ipcMain.removeHandler(TEAM_SKIP_MEMBER_FOR_LAUNCH);
  ipcMain.removeHandler(TEAM_SHOW_MESSAGE_NOTIFICATION);
  ipcMain.removeHandler(TEAM_SAVE_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_GET_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_DELETE_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_VALIDATE_CLI_ARGS);
  ipcMain.removeHandler(TEAM_GET_SAVED_REQUEST);
  ipcMain.removeHandler(TEAM_DELETE_DRAFT);
}

function getTeamDataService(): TeamDataService {
  if (!teamDataService) {
    throw new Error('Team handlers are not initialized');
  }
  return teamDataService;
}

function getTeamProvisioningStartApi(): TeamProvisioningStartApi {
  if (!teamProvisioningStartApi) {
    throw new Error('Team launch handlers are not initialized');
  }
  return teamProvisioningStartApi;
}

function getTeamProvisioningStatusApi(): TeamProvisioningStatusApi {
  if (!teamProvisioningStatusApi) {
    throw new Error('Team provisioning status handlers are not initialized');
  }
  return teamProvisioningStatusApi;
}

function getTeamProvisioningPreflightApi(): TeamProvisioningPreflightApi {
  if (!teamProvisioningPreflightApi) {
    throw new Error('Team provisioning preflight handlers are not initialized');
  }
  return teamProvisioningPreflightApi;
}

function getTeamProvisioningRunApi(): TeamProvisioningRunApi {
  if (!teamProvisioningRunApi) {
    throw new Error('Team provisioning run handlers are not initialized');
  }
  return teamProvisioningRunApi;
}

function getTeamRuntimeApi(): TeamRuntimeApi {
  if (!teamRuntimeApi) {
    throw new Error('Team runtime handlers are not initialized');
  }
  return teamRuntimeApi;
}

function getTeamMemberLifecycleApi(): TeamMemberLifecycleApi {
  if (!teamMemberLifecycleApi) {
    throw new Error('Team member lifecycle handlers are not initialized');
  }
  return teamMemberLifecycleApi;
}

function getTeamDiagnosticsApi(): TeamDiagnosticsApi {
  if (!teamDiagnosticsApi) {
    throw new Error('Team diagnostics handlers are not initialized');
  }
  return teamDiagnosticsApi;
}

function getTeamClaudeLogsApi(): TeamClaudeLogsApi {
  if (!teamClaudeLogsApi) {
    throw new Error('Team log handlers are not initialized');
  }
  return teamClaudeLogsApi;
}

function getTeamMessagingApi(): TeamMessagingApi {
  if (!teamMessagingApi) {
    throw new Error('Team messaging handlers are not initialized');
  }
  return teamMessagingApi;
}

function getTeammateToolTracker(): TeammateToolTracker {
  if (!teammateToolTracker) {
    throw new Error('Teammate tool tracker is not initialized');
  }
  return teammateToolTracker;
}

function getTeamLogSourceTracker(): TeamLogSourceTracker {
  if (!teamLogSourceTracker) {
    throw new Error('Team log source tracker is not initialized');
  }
  return teamLogSourceTracker;
}

function getBranchStatusService(): BranchStatusService {
  if (!branchStatusService) {
    throw new Error('Branch status service is not initialized');
  }
  return branchStatusService;
}

async function wrapTeamHandler<T>(
  operation: string,
  handler: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    const data = await handler();
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

async function handleGetProjectBranch(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<string | null>> {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return { success: false, error: 'projectPath must be a non-empty string' };
  }
  try {
    const branch = await gitIdentityResolver.getBranch(path.normalize(projectPath.trim()));
    return { success: true, data: branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[teams:getProjectBranch] ${message}`);
    return { success: false, error: message };
  }
}

function validateProjectPathInput(
  projectPath: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return { valid: false, error: 'projectPath must be a non-empty string' };
  }
  return { valid: true, value: path.normalize(projectPath.trim()) };
}

async function handleGetWorktreeGitStatus(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<TeamWorktreeGitStatus>> {
  const validated = validateProjectPathInput(projectPath);
  if (!validated.valid) {
    return { success: false, error: validated.error };
  }
  return wrapTeamHandler('getWorktreeGitStatus', () =>
    worktreeGitService.getStatus(validated.value)
  );
}

async function handleInitializeGitRepository(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<TeamWorktreeGitStatus>> {
  const validated = validateProjectPathInput(projectPath);
  if (!validated.valid) {
    return { success: false, error: validated.error };
  }
  return wrapTeamHandler('initializeGitRepository', () =>
    worktreeGitService.initializeRepository(validated.value)
  );
}

async function handleCreateInitialGitCommit(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<TeamWorktreeGitStatus>> {
  const validated = validateProjectPathInput(projectPath);
  if (!validated.valid) {
    return { success: false, error: validated.error };
  }
  return wrapTeamHandler('createInitialGitCommit', () =>
    worktreeGitService.createInitialCommit(validated.value)
  );
}

async function handleListTeams(
  _event: IpcMainInvokeEvent,
  teamLifecycleReadRequest?: unknown
): Promise<IpcResult<TeamSummary[] | CanonicalListTeamLifecycleResult>> {
  if (teamLifecycleReadRequest !== undefined) {
    return wrapTeamHandler('listTeamLifecycle', () =>
      handleListTeamLifecycle(teamLifecycleReadRequest)
    );
  }
  setCurrentMainOp('team:list');
  const startedAt = Date.now();
  try {
    return await wrapTeamHandler('list', () => {
      const loadFresh = () => getTeamDataService().listTeams();
      return launchIoGovernor
        ? launchIoGovernor.runSummaryOperation('teams:list', loadFresh, {
            clone: cloneLaunchIoGovernorPayload,
          })
        : loadFresh();
    });
  } finally {
    const ms = Date.now() - startedAt;
    if (ms >= 1500) {
      logger.warn(`[teams:list] slow ms=${ms}`);
    }
    setCurrentMainOp(null);
  }
}

async function handleSetProjectBranchTracking(
  _event: IpcMainInvokeEvent,
  projectPath: unknown,
  enabled: unknown
): Promise<IpcResult<void>> {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return { success: false, error: 'projectPath must be a non-empty string' };
  }
  if (typeof enabled !== 'boolean') {
    return { success: false, error: 'enabled must be a boolean' };
  }

  return wrapTeamHandler('setProjectBranchTracking', async () => {
    await getBranchStatusService().setTracking(projectPath.trim(), enabled);
  });
}

async function handleSetToolActivityTracking(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  enabled: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  if (typeof enabled !== 'boolean') {
    return { success: false, error: 'enabled must be a boolean' };
  }

  return wrapTeamHandler('setToolActivityTracking', async () => {
    await getTeammateToolTracker().setTracking(validated.value!, enabled);
  });
}

async function handleSetTaskLogStreamTracking(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  enabled: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  if (typeof enabled !== 'boolean') {
    return { success: false, error: 'enabled must be a boolean' };
  }

  return wrapTeamHandler('setTaskLogStreamTracking', async () => {
    if (enabled) {
      await getTeamLogSourceTracker().enableTracking(validated.value!, 'task_log_stream');
      return;
    }
    await getTeamLogSourceTracker().disableTracking(validated.value!, 'task_log_stream');
  });
}

async function handleDeleteTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('deleteTeam', async () => {
    await getTeamRuntimeApi().stopTeam(validated.value!);
    await getTeamDataService().deleteTeam(validated.value!);
    getTeamDataWorkerClient().invalidateTeamConfig(validated.value!);
  });
}

async function handleRestoreTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('restoreTeam', async () => {
    await getTeamDataService().restoreTeam(validated.value!);
    getTeamDataWorkerClient().invalidateTeamConfig(validated.value!);
  });
}

async function handlePermanentlyDeleteTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('permanentlyDeleteTeam', async () => {
    await getTeamDataService().permanentlyDeleteTeam(validated.value!);
    getTeamDataWorkerClient().invalidateTeamConfig(validated.value!);
    // Clean up app-owned data (attachments, task-attachments) that lives outside ~/.claude/
    const appData = getAppDataPath();
    await fs.promises
      .rm(path.join(appData, 'attachments', validated.value!), { recursive: true, force: true })
      .catch(() => undefined);
    await fs.promises
      .rm(path.join(appData, 'task-attachments', validated.value!), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
    // Mark in backup registry AFTER successful deletion
    if (teamBackupService) {
      await teamBackupService.markDeletedByUser(validated.value!);
    }
  });
}

async function handleUpdateConfig(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  updates: unknown
): Promise<IpcResult<TeamConfig>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  if (!updates || typeof updates !== 'object') {
    return { success: false, error: 'Invalid updates object' };
  }
  const { name, description, color } = updates as TeamUpdateConfigRequest;
  if (name !== undefined && typeof name !== 'string') {
    return { success: false, error: 'name must be a string' };
  }
  if (description !== undefined && typeof description !== 'string') {
    return { success: false, error: 'description must be a string' };
  }
  if (color !== undefined && typeof color !== 'string') {
    return { success: false, error: 'color must be a string' };
  }
  return wrapTeamHandler('updateConfig', async () => {
    const tn = validated.value!;
    const teamDataService = getTeamDataService();
    const previousDisplayName = await teamDataService.getTeamDisplayName(tn).catch(() => tn);
    const requestedName = typeof name === 'string' ? name.trim() : '';
    const result = await getTeamDataService().updateConfig(tn, {
      name,
      description,
      color,
    });
    if (!result) {
      throw new Error('Team config not found');
    }

    // Notify running lead about the rename so it stays aware of current team name
    if (requestedName && requestedName !== (previousDisplayName?.trim() || tn)) {
      const messaging = getTeamMessagingApi();
      if (getTeamRuntimeApi().isTeamAlive(tn)) {
        const msg = `The team has been renamed to "${requestedName}". Please use this name when referring to the team going forward.`;
        try {
          await messaging.sendMessageToTeam(tn, msg);
        } catch {
          logger.warn(`Failed to notify lead about team rename for ${tn}`);
        }
      }
    }

    getTeamDataWorkerClient().invalidateTeamConfig(tn);
    return result;
  });
}

function isProvisioningTeamName(teamName: string): boolean {
  if (teamName.length > 64) return false;
  const parts = teamName.split('-');
  return parts.every((p) => /^[a-z0-9]+$/.test(p));
}

function isValidEffort(value: unknown, providerId?: TeamProviderId | null): value is EffortLevel {
  return isTeamEffortLevelForProvider(value, providerId);
}

function parseOptionalProviderId(
  value: unknown,
  fieldName: string
): { valid: true; value: TeamProviderId | undefined } | { valid: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (isTeamProviderId(value)) {
    return { valid: true, value };
  }
  return { valid: false, error: `${fieldName} must be anthropic, codex, gemini, or opencode` };
}

function parseOptionalMemberProviderId(
  value: unknown
): { valid: true; value: TeamProviderId | undefined } | { valid: false; error: string } {
  return parseOptionalProviderId(value, 'member providerId');
}

function parseOptionalTeamProviderId(
  value: unknown
): { valid: true; value: TeamProviderId | undefined } | { valid: false; error: string } {
  return parseOptionalProviderId(value, 'providerId');
}

function parseOptionalProviderBackendId(
  value: unknown,
  providerId?: TeamProviderId
): { valid: true; value: TeamProviderBackendId | undefined } | { valid: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: 'providerBackendId must be a string' };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: true, value: undefined };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: 'providerBackendId too long (max 64)' };
  }
  if (providerId) {
    const migratedBackendId = migrateProviderBackendId(providerId, trimmed);
    if (migratedBackendId) {
      return { valid: true, value: migratedBackendId };
    }
  } else if (isTeamProviderBackendId(trimmed)) {
    return { valid: true, value: trimmed };
  }

  return {
    valid: false,
    error:
      'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
  };
}

function parseOptionalLaunchProviderBackendId(
  value: unknown,
  providerId?: TeamProviderId
): { valid: true; value: TeamProviderBackendId | undefined } | { valid: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: 'providerBackendId must be a string' };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: true, value: undefined };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: 'providerBackendId too long (max 64)' };
  }

  const migratedBackendId = migrateProviderBackendId(providerId, trimmed);
  if (migratedBackendId) {
    return { valid: true, value: migratedBackendId };
  }

  if (isTeamProviderBackendId(trimmed)) {
    return { valid: true, value: undefined };
  }

  return {
    valid: false,
    error:
      'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
  };
}

function parseOptionalMemberEffort(
  value: unknown,
  providerId?: TeamProviderId | null
): { valid: true; value: EffortLevel | undefined } | { valid: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (isValidEffort(value, providerId)) {
    return { valid: true, value };
  }
  return {
    valid: false,
    error: `member effort must be one of ${formatEffortLevelListForProvider(providerId)}`,
  };
}

function parseOptionalTeamEffort(
  value: unknown,
  providerId?: TeamProviderId | null
): { valid: true; value: EffortLevel | undefined } | { valid: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (isValidEffort(value, providerId)) {
    return { valid: true, value };
  }
  return {
    valid: false,
    error: `effort must be one of ${formatEffortLevelListForProvider(providerId)}`,
  };
}

function parseOptionalTeamFastMode(
  value: unknown
): { valid: true; value: TeamFastMode | undefined } | { valid: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (value === 'inherit' || value === 'on' || value === 'off') {
    return { valid: true, value };
  }
  return {
    valid: false,
    error: 'fastMode must be one of inherit, on, or off',
  };
}

interface RuntimeRosterMutationMember {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  cwd?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
  removedAt?: number | string | null;
}

const OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE =
  'Live roster mutation for a running OpenCode-led team is not supported in this phase. Stop the team, edit the roster, then relaunch.';
const OPENCODE_OWNERSHIP_MIGRATION_BLOCK_MESSAGE =
  'Live member migration between OpenCode and the primary runtime owner is not supported in this phase. Stop the team, edit the roster, then relaunch.';

function isOpenCodeRosterMutationMember(member: RuntimeRosterMutationMember | undefined): boolean {
  return normalizeOptionalTeamProviderId(member?.providerId) === 'opencode';
}

function isLeadRosterMutationMember(member: RuntimeRosterMutationMember | undefined): boolean {
  if (!member) {
    return false;
  }
  if (isLeadMember(member)) {
    return true;
  }
  const normalizedName = member.name.trim().toLowerCase();
  if (normalizedName === 'lead') {
    return true;
  }
  return member.role?.toLowerCase().includes('lead') === true;
}

function isOpenCodeLedRoster(members: RuntimeRosterMutationMember[]): boolean {
  const leadMember = members.find(
    (member) => !member.removedAt && isLeadRosterMutationMember(member)
  );
  return normalizeOptionalTeamProviderId(leadMember?.providerId) === 'opencode';
}

function didOpenCodeRosterMemberChange(
  previous: RuntimeRosterMutationMember | undefined,
  next: RuntimeRosterMutationMember | undefined
): boolean {
  if (!previous || !next) {
    return false;
  }

  return (
    (previous.role?.trim() || undefined) !== (next.role?.trim() || undefined) ||
    (previous.workflow?.trim() || undefined) !== (next.workflow?.trim() || undefined) ||
    (previous.isolation === 'worktree' ? 'worktree' : undefined) !==
      (next.isolation === 'worktree' ? 'worktree' : undefined) ||
    normalizeOptionalTeamProviderId(previous.providerId) !==
      normalizeOptionalTeamProviderId(next.providerId) ||
    migrateProviderBackendId(
      normalizeOptionalTeamProviderId(previous.providerId),
      previous.providerBackendId
    ) !==
      migrateProviderBackendId(
        normalizeOptionalTeamProviderId(next.providerId),
        next.providerBackendId
      ) ||
    (previous.model?.trim() || undefined) !== (next.model?.trim() || undefined) ||
    previous.effort !== next.effort ||
    previous.fastMode !== next.fastMode ||
    JSON.stringify(normalizeTeamMemberMcpPolicy(previous.mcpPolicy)) !==
      JSON.stringify(normalizeTeamMemberMcpPolicy(next.mcpPolicy))
  );
}

function findOpenCodeOwnershipMigrationNames(options: {
  previousMembers: RuntimeRosterMutationMember[];
  nextMembers: RuntimeRosterMutationMember[];
}): string[] {
  const previousByName = new Map(
    options.previousMembers
      .filter((member) => !member.removedAt)
      .map((member) => [member.name.trim().toLowerCase(), member])
  );
  const migrationNames: string[] = [];
  for (const nextMember of options.nextMembers) {
    const previousMember = previousByName.get(nextMember.name.trim().toLowerCase());
    if (!previousMember) {
      continue;
    }
    if (
      isOpenCodeRosterMutationMember(previousMember) !== isOpenCodeRosterMutationMember(nextMember)
    ) {
      migrationNames.push(nextMember.name.trim());
    }
  }
  return migrationNames;
}

function toRollbackReplaceMembersRequest(members: RuntimeRosterMutationMember[]): {
  members: {
    name: string;
    role?: string;
    workflow?: string;
    isolation?: 'worktree';
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
    mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
  }[];
} {
  return {
    members: members
      .filter((member) => !member.removedAt && !isLeadRosterMutationMember(member))
      .map((member) => ({
        name: member.name.trim(),
        role: member.role?.trim() || undefined,
        workflow: member.workflow?.trim() || undefined,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        providerBackendId: migrateProviderBackendId(member.providerId, member.providerBackendId),
        model: member.model?.trim() || undefined,
        effort: member.effort,
        fastMode: member.fastMode,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
      })),
  };
}

async function restorePreviousMembersMetaSnapshot(options: {
  teamName: string;
  teamDataService: TeamDataService;
  previousMembers: RuntimeRosterMutationMember[];
  previousMembersMeta: TeamMembersMetaFile | null;
}): Promise<boolean> {
  const { teamName, teamDataService, previousMembers, previousMembersMeta } = options;

  if (previousMembersMeta) {
    try {
      await new TeamMembersMetaStore().writeMembers(teamName, previousMembersMeta.members, {
        providerBackendId: previousMembersMeta.providerBackendId,
      });
      return true;
    } catch (error) {
      logger.error(
        `Failed to restore exact live roster metadata for ${teamName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  try {
    await teamDataService.replaceMembers(
      teamName,
      toRollbackReplaceMembersRequest(previousMembers)
    );
    return true;
  } catch (error) {
    logger.error(
      `Failed to roll back fallback live roster metadata for ${teamName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

async function rollbackLiveRosterMutation(options: {
  teamName: string;
  teamDataService: TeamDataService;
  memberLifecycle: TeamMemberLifecycleApi;
  previousMembers: RuntimeRosterMutationMember[];
  previousMembersMeta: TeamMembersMetaFile | null;
  restoreLiveMemberNames?: string[];
  detachLiveMemberNames?: string[];
}): Promise<void> {
  const {
    teamName,
    teamDataService,
    memberLifecycle,
    previousMembers,
    previousMembersMeta,
    restoreLiveMemberNames = [],
    detachLiveMemberNames = [],
  } = options;

  const detachNames = Array.from(
    new Set(detachLiveMemberNames.map((memberName) => memberName.trim()).filter(Boolean))
  );
  for (const memberName of detachNames) {
    try {
      await memberLifecycle.detachLiveRosterMember(teamName, memberName);
    } catch (error) {
      logger.warn(
        `Failed to clean up live roster member for ${teamName}/${memberName} during rollback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const metadataRestored = await restorePreviousMembersMetaSnapshot({
    teamName,
    teamDataService,
    previousMembers,
    previousMembersMeta,
  });
  if (metadataRestored) {
    invalidateTeamRosterSnapshotCaches(teamName);
  }

  if (!metadataRestored) {
    return;
  }

  const restoreNames = Array.from(
    new Set(restoreLiveMemberNames.map((memberName) => memberName.trim()).filter(Boolean))
  );
  for (const memberName of restoreNames) {
    try {
      await memberLifecycle.attachLiveRosterMember(teamName, memberName, {
        reason: 'member_updated',
      });
    } catch (error) {
      logger.warn(
        `Failed to restore live roster member for ${teamName}/${memberName} during rollback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

async function validateProvisioningRequest(
  request: unknown
): Promise<{ valid: true; value: TeamCreateRequest } | { valid: false; error: string }> {
  if (!request || typeof request !== 'object') {
    return { valid: false, error: 'Invalid team create request' };
  }

  const payload = request as Partial<TeamCreateRequest>;
  if (typeof payload.teamName !== 'string' || payload.teamName.trim().length === 0) {
    return { valid: false, error: 'teamName is required' };
  }
  const teamName = payload.teamName.trim();
  if (!isProvisioningTeamName(teamName)) {
    return { valid: false, error: 'teamName must be kebab-case [a-z0-9-], max 64 chars' };
  }

  if (payload.displayName !== undefined && typeof payload.displayName !== 'string') {
    return { valid: false, error: 'displayName must be string' };
  }
  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return { valid: false, error: 'description must be string' };
  }

  if (!Array.isArray(payload.members)) {
    return { valid: false, error: 'members must be an array' };
  }
  const providerValidation = parseOptionalTeamProviderId(payload.providerId);
  if (!providerValidation.valid) {
    return { valid: false, error: providerValidation.error };
  }
  const providerId = providerValidation.value ?? 'anthropic';

  const seenNames = new Set<string>();
  const members: TeamCreateRequest['members'] = [];
  for (const member of payload.members) {
    if (!member || typeof member !== 'object') {
      return { valid: false, error: 'member must be object' };
    }
    const nameValidation = validateTeammateName((member as { name?: unknown }).name);
    if (!nameValidation.valid) {
      return { valid: false, error: nameValidation.error ?? 'Invalid member name' };
    }
    const memberName = nameValidation.value!;
    if (seenNames.has(memberName)) {
      return { valid: false, error: 'member names must be unique' };
    }
    seenNames.add(memberName);

    const role = (member as { role?: unknown }).role;
    if (role !== undefined && typeof role !== 'string') {
      return { valid: false, error: 'member role must be string' };
    }
    const workflow = (member as { workflow?: unknown }).workflow;
    if (workflow !== undefined && typeof workflow !== 'string') {
      return { valid: false, error: 'member workflow must be string' };
    }
    const isolation = (member as { isolation?: unknown }).isolation;
    if (isolation !== undefined && isolation !== 'worktree') {
      return { valid: false, error: 'member isolation must be "worktree" when provided' };
    }
    const providerValidation = parseOptionalMemberProviderId(
      (member as { providerId?: unknown }).providerId
    );
    if (!providerValidation.valid) {
      return { valid: false, error: providerValidation.error };
    }
    const providerBackendValidation = parseOptionalProviderBackendId(
      (member as { providerBackendId?: unknown }).providerBackendId,
      providerValidation.value ?? providerId
    );
    if (!providerBackendValidation.valid) {
      return { valid: false, error: providerBackendValidation.error };
    }
    const model = (member as { model?: unknown }).model;
    if (model !== undefined && typeof model !== 'string') {
      return { valid: false, error: 'member model must be string' };
    }
    const effortValidation = parseOptionalMemberEffort(
      (member as { effort?: unknown }).effort,
      providerValidation.value ?? providerId
    );
    if (!effortValidation.valid) {
      return { valid: false, error: effortValidation.error };
    }
    const fastModeValidation = parseOptionalTeamFastMode(
      (member as { fastMode?: unknown }).fastMode
    );
    if (!fastModeValidation.valid) {
      return { valid: false, error: fastModeValidation.error };
    }
    members.push({
      name: memberName,
      role: typeof role === 'string' ? role.trim() : undefined,
      workflow: typeof workflow === 'string' ? workflow.trim() : undefined,
      isolation: isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: providerValidation.value,
      providerBackendId: providerBackendValidation.value,
      model: typeof model === 'string' ? model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      mcpPolicy: normalizeTeamMemberMcpPolicy((member as { mcpPolicy?: unknown }).mcpPolicy),
    });
  }

  if (typeof payload.cwd !== 'string' || payload.cwd.trim().length === 0) {
    return { valid: false, error: 'cwd is required' };
  }
  const cwd = payload.cwd.trim();
  if (!path.isAbsolute(cwd)) {
    return { valid: false, error: 'cwd must be an absolute path' };
  }

  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    return { valid: false, error: 'prompt must be a string' };
  }
  const providerBackendValidation = parseOptionalLaunchProviderBackendId(
    payload.providerBackendId,
    providerId
  );
  if (!providerBackendValidation.valid) {
    return { valid: false, error: providerBackendValidation.error };
  }
  const effortValidation = parseOptionalTeamEffort(payload.effort, providerId);
  if (!effortValidation.valid) {
    return { valid: false, error: effortValidation.error };
  }
  const fastModeValidation = parseOptionalTeamFastMode(payload.fastMode);
  if (!fastModeValidation.valid) {
    return { valid: false, error: fastModeValidation.error };
  }
  if (payload.limitContext !== undefined && typeof payload.limitContext !== 'boolean') {
    return { valid: false, error: 'limitContext must be a boolean' };
  }

  try {
    await fs.promises.mkdir(cwd, { recursive: true });
  } catch {
    return { valid: false, error: 'failed to create cwd directory' };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(cwd);
  } catch {
    return { valid: false, error: 'cwd does not exist' };
  }
  if (!stat.isDirectory()) {
    return { valid: false, error: 'cwd must be a directory' };
  }

  if (payload.worktree !== undefined) {
    if (typeof payload.worktree !== 'string') {
      return { valid: false, error: 'worktree must be a string' };
    }
    const wt = payload.worktree.trim();
    if (wt.length > 128) {
      return { valid: false, error: 'worktree name too long (max 128)' };
    }
    if (wt && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(wt)) {
      return {
        valid: false,
        error: 'worktree name: start with alphanumeric, use [a-zA-Z0-9._-]',
      };
    }
  }
  if (payload.extraCliArgs !== undefined) {
    if (typeof payload.extraCliArgs !== 'string') {
      return { valid: false, error: 'extraCliArgs must be a string' };
    }
    if (payload.extraCliArgs.length > 1024) {
      return { valid: false, error: 'extraCliArgs too long (max 1024)' };
    }
  }

  return {
    valid: true,
    value: {
      teamName,
      displayName: payload.displayName?.trim() || undefined,
      description: payload.description?.trim() || undefined,
      color: typeof payload.color === 'string' ? payload.color.trim() || undefined : undefined,
      members,
      cwd,
      prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
      providerId,
      providerBackendId: providerBackendValidation.value,
      model: typeof payload.model === 'string' ? payload.model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      limitContext: typeof payload.limitContext === 'boolean' ? payload.limitContext : undefined,
      skipPermissions:
        typeof payload.skipPermissions === 'boolean' ? payload.skipPermissions : undefined,
      worktree:
        typeof payload.worktree === 'string' && payload.worktree.trim()
          ? payload.worktree.trim()
          : undefined,
      extraCliArgs:
        typeof payload.extraCliArgs === 'string' && payload.extraCliArgs.trim()
          ? payload.extraCliArgs.trim()
          : undefined,
    },
  };
}

async function handleGetClaudeLogs(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  query?: unknown
): Promise<IpcResult<TeamClaudeLogsResponse>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }

  let parsed: TeamClaudeLogsQuery | undefined;
  if (query !== undefined) {
    if (!query || typeof query !== 'object') {
      return { success: false, error: 'query must be an object' };
    }
    const q = query as Record<string, unknown>;
    parsed = {
      offset: typeof q.offset === 'number' ? q.offset : undefined,
      limit: typeof q.limit === 'number' ? q.limit : undefined,
    };
  }

  return wrapTeamHandler('getClaudeLogs', async () => {
    const data = await getTeamClaudeLogsApi().getClaudeLogs(validated.value!, parsed);
    return {
      lines: data.lines,
      total: data.total,
      hasMore: data.hasMore,
      updatedAt: data.updatedAt,
    };
  });
}

function sendProvisioningProgress(
  targetWindow: BrowserWindow | null,
  progress: TeamProvisioningProgress
): void {
  safeSendToRenderer(targetWindow, TEAM_PROVISIONING_PROGRESS, progress);
}

function noteLaunchIntentFailed(teamName: string, source: string): void {
  if (!launchIoGovernor) {
    return;
  }
  const now = new Date().toISOString();
  launchIoGovernor.noteProvisioningProgress({
    runId: `${source}:failed-before-progress`,
    teamName,
    state: 'failed',
    message: 'Launch failed before provisioning progress',
    startedAt: now,
    updatedAt: now,
  } as TeamProvisioningProgress);
}

async function handleCreateTeam(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<IpcResult<TeamCreateResponse>> {
  const validation = await validateProvisioningRequest(request);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  const progressTargetWindow = BrowserWindow.fromWebContents(event.sender);

  return wrapTeamHandler('create', async () => {
    addMainBreadcrumb('team', 'create', { teamName: validation.value.teamName });
    launchIoGovernor?.noteLaunchIntent(validation.value.teamName, 'create');
    // Keep this team's team-root/task artifacts file-watched while createTeam writes
    // its initial config, tasks, inboxes, and launch state.
    markTeamEngaged(validation.value.teamName);
    try {
      const response = await getTeamProvisioningStartApi().createTeam(
        validation.value,
        (progress) => {
          launchIoGovernor?.noteProvisioningProgress(progress);
          sendProvisioningProgress(progressTargetWindow, progress);
        }
      );
      invalidateTeamRosterSnapshotCaches(validation.value.teamName);
      return response;
    } catch (error) {
      noteLaunchIntentFailed(validation.value.teamName, 'create');
      throw error;
    }
  });
}

async function handleLaunchTeam(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<IpcResult<TeamLaunchResponse>> {
  if (!request || typeof request !== 'object') {
    return { success: false, error: 'Invalid team launch request' };
  }
  const progressTargetWindow = BrowserWindow.fromWebContents(event.sender);

  const payload = request as Partial<TeamLaunchRequest>;
  const validatedTeamName = validateTeamName(payload.teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  if (typeof payload.cwd !== 'string' || payload.cwd.trim().length === 0) {
    return { success: false, error: 'cwd is required' };
  }
  const cwd = payload.cwd.trim();
  if (!path.isAbsolute(cwd)) {
    return { success: false, error: 'cwd must be an absolute path' };
  }

  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) {
      return { success: false, error: 'cwd must be a directory' };
    }
  } catch {
    return { success: false, error: 'cwd does not exist' };
  }

  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    return { success: false, error: 'prompt must be a string' };
  }

  if (payload.model !== undefined && typeof payload.model !== 'string') {
    return { success: false, error: 'model must be a string' };
  }
  if (payload.limitContext !== undefined && typeof payload.limitContext !== 'boolean') {
    return { success: false, error: 'limitContext must be a boolean' };
  }
  const providerValidation = parseOptionalTeamProviderId(payload.providerId);
  if (!providerValidation.valid) {
    return { success: false, error: providerValidation.error };
  }
  const explicitProviderId = providerValidation.value;
  const providerId = explicitProviderId ?? 'anthropic';
  const providerBackendValidation = parseOptionalLaunchProviderBackendId(
    payload.providerBackendId,
    providerId
  );
  if (!providerBackendValidation.valid) {
    return { success: false, error: providerBackendValidation.error };
  }

  // Detect draft team: team.meta.json exists but config.json doesn't.
  // This happens when user created team config without launching (launchTeam=false),
  // or when provisioning failed before TeamCreate could run.
  // Redirect to createTeam so TeamCreate runs properly.
  const tn = validatedTeamName.value!;
  const configPath = path.join(getTeamsBasePath(), tn, 'config.json');
  let isDraft = false;
  try {
    await fs.promises.access(configPath, fs.constants.F_OK);
  } catch {
    const meta = await teamMetaStore.getMeta(tn);
    if (meta) isDraft = true;
  }

  if (isDraft) {
    const savedRequest = await getTeamDataService().getSavedRequest(tn);
    if (!savedRequest) {
      return { success: false, error: `Missing saved request for draft team: ${tn}` };
    }

    const savedProviderId = savedRequest.providerId ?? 'anthropic';
    const resolvedProviderId = explicitProviderId ?? savedRequest.providerId ?? providerId;
    const providerChangedFromSaved =
      explicitProviderId != null && explicitProviderId !== savedProviderId;
    const effortValidation = parseOptionalTeamEffort(
      Object.hasOwn(payload, 'effort')
        ? payload.effort
        : providerChangedFromSaved
          ? undefined
          : savedRequest.effort,
      resolvedProviderId
    );
    if (!effortValidation.valid) {
      return { success: false, error: effortValidation.error };
    }
    const fastModeValidation = parseOptionalTeamFastMode(
      Object.hasOwn(payload, 'fastMode')
        ? payload.fastMode
        : providerChangedFromSaved
          ? undefined
          : savedRequest.fastMode
    );
    if (!fastModeValidation.valid) {
      return { success: false, error: fastModeValidation.error };
    }
    const draftModel = Object.hasOwn(payload, 'model')
      ? typeof payload.model === 'string'
        ? payload.model.trim() || undefined
        : undefined
      : providerChangedFromSaved
        ? undefined
        : savedRequest.model;
    const draftLimitContext =
      typeof payload.limitContext === 'boolean'
        ? payload.limitContext
        : providerChangedFromSaved
          ? undefined
          : savedRequest.limitContext;

    const createRequest: TeamCreateRequest = {
      teamName: tn,
      displayName: savedRequest.displayName,
      description: savedRequest.description,
      color: savedRequest.color,
      cwd,
      prompt:
        typeof payload.prompt === 'string'
          ? payload.prompt.trim() || undefined
          : savedRequest.prompt,
      providerId: resolvedProviderId,
      providerBackendId: migrateProviderBackendId(
        resolvedProviderId,
        providerBackendValidation.value ?? savedRequest.providerBackendId
      ),
      model: draftModel,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      limitContext: draftLimitContext,
      skipPermissions:
        typeof payload.skipPermissions === 'boolean'
          ? payload.skipPermissions
          : savedRequest.skipPermissions,
      worktree:
        typeof payload.worktree === 'string'
          ? payload.worktree.trim() || undefined
          : savedRequest.worktree,
      extraCliArgs:
        typeof payload.extraCliArgs === 'string'
          ? payload.extraCliArgs.trim() || undefined
          : savedRequest.extraCliArgs,
      members: savedRequest.members,
    };

    return wrapTeamHandler('create', async () => {
      launchIoGovernor?.noteLaunchIntent(tn, 'draft-launch');
      // Draft launch runs through createTeam, so it needs the same immediate watch scope
      // as a normal launch before startup files begin changing.
      markTeamEngaged(tn);
      try {
        const response = await getTeamProvisioningStartApi().createTeam(
          createRequest,
          (progress) => {
            launchIoGovernor?.noteProvisioningProgress(progress);
            sendProvisioningProgress(progressTargetWindow, progress);
          }
        );
        invalidateTeamRosterSnapshotCaches(tn);
        return response;
      } catch (error) {
        noteLaunchIntentFailed(tn, 'draft-launch');
        throw error;
      }
    });
  }

  const persistedMeta = await teamMetaStore.getMeta(tn).catch(() => null);
  const persistedLaunchProviderId =
    persistedMeta?.launchIdentity?.providerId ?? persistedMeta?.providerId ?? 'anthropic';
  const launchProviderId =
    explicitProviderId ??
    persistedMeta?.launchIdentity?.providerId ??
    persistedMeta?.providerId ??
    providerId;
  const providerChangedFromPersisted =
    explicitProviderId != null && explicitProviderId !== persistedLaunchProviderId;
  const rawLaunchProviderBackendId = Object.hasOwn(payload, 'providerBackendId')
    ? payload.providerBackendId
    : providerChangedFromPersisted
      ? undefined
      : persistedMeta?.launchIdentity
        ? migrateProviderBackendId(
            persistedMeta.launchIdentity.providerId,
            persistedMeta.launchIdentity.providerBackendId ?? persistedMeta.providerBackendId
          )
        : (persistedMeta?.providerBackendId ?? undefined);
  const launchProviderBackendValidation = parseOptionalLaunchProviderBackendId(
    rawLaunchProviderBackendId,
    launchProviderId
  );
  if (!launchProviderBackendValidation.valid) {
    return { success: false, error: launchProviderBackendValidation.error };
  }
  const persistedLaunchEffort = providerChangedFromPersisted
    ? undefined
    : (persistedMeta?.launchIdentity?.selectedEffort ?? persistedMeta?.effort ?? undefined);
  const rawLaunchEffort = Object.hasOwn(payload, 'effort') ? payload.effort : persistedLaunchEffort;
  const effortValidation = parseOptionalTeamEffort(rawLaunchEffort, launchProviderId);
  if (!effortValidation.valid) {
    return { success: false, error: effortValidation.error };
  }
  const persistedLaunchFastMode = providerChangedFromPersisted
    ? undefined
    : (persistedMeta?.launchIdentity?.selectedFastMode ?? persistedMeta?.fastMode ?? undefined);
  const rawLaunchFastMode = Object.hasOwn(payload, 'fastMode')
    ? payload.fastMode
    : persistedLaunchFastMode;
  const fastModeValidation = parseOptionalTeamFastMode(rawLaunchFastMode);
  if (!fastModeValidation.valid) {
    return { success: false, error: fastModeValidation.error };
  }
  const persistedLaunchModel = providerChangedFromPersisted
    ? undefined
    : (persistedMeta?.launchIdentity?.selectedModel ?? persistedMeta?.model ?? undefined);
  const rawLaunchModel = Object.hasOwn(payload, 'model')
    ? typeof payload.model === 'string' && payload.model.trim().length > 0
      ? payload.model.trim()
      : undefined
    : persistedLaunchModel;
  const launchLimitContext =
    typeof payload.limitContext === 'boolean'
      ? payload.limitContext
      : providerChangedFromPersisted
        ? undefined
        : persistedMeta?.limitContext;

  return wrapTeamHandler('launch', async () => {
    addMainBreadcrumb('team', 'launch', { teamName: validatedTeamName.value! });
    launchIoGovernor?.noteLaunchIntent(validatedTeamName.value!, 'launch');
    // Keep this team's team-root/task artifacts file-watched for the whole launch (and the
    // engaged TTL after), so the lead's immediate startup writes are not missed during the
    // 0-30s window before the periodic watch-scope reconcile would otherwise pick it up.
    markTeamEngaged(validatedTeamName.value!);
    try {
      const response = await getTeamProvisioningStartApi().launchTeam(
        {
          teamName: validatedTeamName.value!,
          cwd,
          prompt:
            typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
          providerId: launchProviderId,
          providerBackendId: launchProviderBackendValidation.value,
          model: rawLaunchModel,
          effort: effortValidation.value,
          fastMode: fastModeValidation.value,
          limitContext: launchLimitContext,
          clearContext: payload.clearContext === true ? true : undefined,
          skipPermissions:
            typeof payload.skipPermissions === 'boolean' ? payload.skipPermissions : undefined,
          worktree:
            typeof payload.worktree === 'string' ? payload.worktree.trim() || undefined : undefined,
          extraCliArgs:
            typeof payload.extraCliArgs === 'string'
              ? payload.extraCliArgs.trim() || undefined
              : undefined,
        },
        (progress) => {
          launchIoGovernor?.noteProvisioningProgress(progress);
          sendProvisioningProgress(progressTargetWindow, progress);
        }
      );
      invalidateTeamRosterSnapshotCaches(validatedTeamName.value!);
      return response;
    } catch (error) {
      noteLaunchIntentFailed(validatedTeamName.value!, 'launch');
      throw error;
    }
  });
}

async function handleValidateCliArgs(
  _event: IpcMainInvokeEvent,
  rawArgs: unknown
): Promise<IpcResult<CliArgsValidationResult>> {
  if (typeof rawArgs !== 'string') {
    return { success: false, error: 'rawArgs must be a string' };
  }
  if (rawArgs.length > 2048) {
    return { success: false, error: 'rawArgs too long (max 2048)' };
  }
  return wrapTeamHandler('validateCliArgs', async () => {
    const helpOutput = await getTeamProvisioningPreflightApi().getCliHelpOutput();
    const knownFlags = extractFlagsFromHelp(helpOutput);
    const userFlags = extractUserFlags(rawArgs);

    const invalidFlags = userFlags.filter((f) => !knownFlags.has(f));
    const protectedFlags = userFlags.filter((f) => PROTECTED_CLI_FLAGS.has(f));
    const allBad = [...new Set([...invalidFlags, ...protectedFlags])];

    return {
      valid: allBad.length === 0,
      invalidFlags: allBad.length > 0 ? allBad : undefined,
    };
  });
}

async function handlePrepareProvisioning(
  _event: IpcMainInvokeEvent,
  cwd: unknown,
  providerId: unknown,
  providerIds: unknown,
  selectedModels: unknown,
  limitContext: unknown,
  modelVerificationMode: unknown,
  selectedModelChecks: unknown
): Promise<IpcResult<TeamProvisioningPrepareResult>> {
  let validatedCwd: string | undefined;
  let validatedProviderId: TeamLaunchRequest['providerId'];
  let validatedProviderIds: TeamProviderId[] | undefined;
  let validatedSelectedModels: string[] | undefined;
  let validatedLimitContext: boolean | undefined;
  let validatedModelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
  let validatedSelectedModelChecks: TeamProvisioningModelCheckRequest[] | undefined;
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      return { success: false, error: 'cwd must be a non-empty string' };
    }
    validatedCwd = cwd.trim();
    if (!path.isAbsolute(validatedCwd)) {
      return { success: false, error: 'cwd must be an absolute path' };
    }
  }
  if (providerId !== undefined) {
    if (!isTeamProviderId(providerId)) {
      return { success: false, error: 'providerId must be anthropic, codex, gemini, or opencode' };
    }
    validatedProviderId = providerId;
  }
  if (providerIds !== undefined) {
    if (!Array.isArray(providerIds)) {
      return { success: false, error: 'providerIds must be an array when provided' };
    }
    const normalized: TeamProviderId[] = [];
    for (const entry of providerIds) {
      if (!isTeamProviderId(entry)) {
        return {
          success: false,
          error: 'providerIds entries must be anthropic, codex, gemini, or opencode',
        };
      }
      if (!normalized.includes(entry)) {
        normalized.push(entry);
      }
    }
    validatedProviderIds = normalized;
  }
  if (selectedModels !== undefined) {
    if (!Array.isArray(selectedModels)) {
      return { success: false, error: 'selectedModels must be an array when provided' };
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < selectedModels.length; index += 1) {
      if (!Object.hasOwn(selectedModels, index)) {
        return { success: false, error: 'selectedModels entries must be non-empty strings' };
      }
      const entry = selectedModels[index];
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return { success: false, error: 'selectedModels entries must be non-empty strings' };
      }
      const model = entry.trim();
      if (!seen.has(model)) {
        seen.add(model);
        normalized.push(model);
      }
    }
    validatedSelectedModels = normalized;
  }
  if (limitContext !== undefined) {
    if (typeof limitContext !== 'boolean') {
      return { success: false, error: 'limitContext must be a boolean when provided' };
    }
    validatedLimitContext = limitContext;
  }
  if (modelVerificationMode !== undefined) {
    if (modelVerificationMode !== 'compatibility' && modelVerificationMode !== 'deep') {
      return {
        success: false,
        error: 'modelVerificationMode must be compatibility or deep when provided',
      };
    }
    validatedModelVerificationMode = modelVerificationMode;
  }
  if (selectedModelChecks !== undefined) {
    if (!Array.isArray(selectedModelChecks)) {
      return { success: false, error: 'selectedModelChecks must be an array when provided' };
    }
    const normalized: TeamProvisioningModelCheckRequest[] = [];
    const seen = new Set<string>();
    for (const entry of selectedModelChecks) {
      if (!entry || typeof entry !== 'object') {
        return { success: false, error: 'selectedModelChecks entries must be objects' };
      }
      const rawEntry = entry as {
        providerId?: unknown;
        model?: unknown;
        effort?: unknown;
      };
      if (!isTeamProviderId(rawEntry.providerId)) {
        return {
          success: false,
          error: 'selectedModelChecks entries must include a valid providerId',
        };
      }
      if (typeof rawEntry.model !== 'string' || rawEntry.model.trim().length === 0) {
        return {
          success: false,
          error: 'selectedModelChecks entries must include a non-empty model',
        };
      }
      const effortValidation = parseOptionalTeamEffort(rawEntry.effort, rawEntry.providerId);
      if (!effortValidation.valid) {
        return { success: false, error: `selectedModelChecks ${effortValidation.error}` };
      }
      const model = rawEntry.model.trim();
      const key = `${rawEntry.providerId}\n${model}\n${effortValidation.value ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({
        providerId: rawEntry.providerId,
        model,
        ...(effortValidation.value ? { effort: effortValidation.value } : {}),
      });
    }
    validatedSelectedModelChecks = normalized;
  }
  return wrapTeamHandler('prepareProvisioning', () =>
    getTeamProvisioningPreflightApi().prepareForProvisioning(validatedCwd, {
      providerId: validatedProviderId,
      providerIds: validatedProviderIds,
      modelIds: validatedSelectedModels,
      limitContext: validatedLimitContext,
      modelVerificationMode: validatedModelVerificationMode,
      modelChecks: validatedSelectedModelChecks,
    })
  );
}

async function handleProvisioningStatus(
  _event: IpcMainInvokeEvent,
  runId: unknown
): Promise<IpcResult<TeamProvisioningProgress>> {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return { success: false, error: 'runId is required' };
  }
  return wrapTeamHandler('provisioningStatus', () =>
    getTeamProvisioningStatusApi().getProvisioningStatus(runId.trim())
  );
}

async function handleLaunchFailureDiagnostics(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  runId: unknown
): Promise<IpcResult<TeamLaunchFailureDiagnosticsBundle>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  const validatedRunId = typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
  return wrapTeamHandler('launchFailureDiagnostics', () =>
    readTeamLaunchFailureDiagnosticsBundle(validatedTeamName.value!, validatedRunId)
  );
}

async function handleCancelProvisioning(
  _event: IpcMainInvokeEvent,
  runId: unknown
): Promise<IpcResult<void>> {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return { success: false, error: 'runId is required' };
  }
  return wrapTeamHandler('cancelProvisioning', () =>
    getTeamProvisioningRunApi().cancelProvisioning(runId.trim())
  );
}

async function handleGetAttachments(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  messageId: unknown
): Promise<IpcResult<AttachmentFileData[]>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    return { success: false, error: 'messageId must be a non-empty string' };
  }
  const safeMessageId = messageId.trim();
  if (safeMessageId.includes('/') || safeMessageId.includes('\\') || safeMessageId.includes('..')) {
    return { success: false, error: 'Invalid messageId' };
  }
  return wrapTeamHandler('getAttachments', () =>
    attachmentStore.getAttachments(vTeam.value!, safeMessageId)
  );
}

function validateAttachments(
  attachments: unknown
): { valid: true; value: AttachmentPayload[] } | { valid: false; error: string } {
  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'attachments must be an array' };
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return { valid: false, error: `Maximum ${MAX_ATTACHMENTS} attachments allowed` };
  }
  let totalSize = 0;
  const result: AttachmentPayload[] = [];
  for (const att of attachments) {
    if (!att || typeof att !== 'object') {
      return { valid: false, error: 'Invalid attachment entry' };
    }
    const a = att as Partial<AttachmentPayload>;
    if (typeof a.id !== 'string' || typeof a.filename !== 'string') {
      return { valid: false, error: 'Attachment must have id and filename' };
    }
    if (typeof a.data !== 'string' || typeof a.mimeType !== 'string') {
      return { valid: false, error: 'Attachment must have data and mimeType' };
    }
    if (typeof a.size !== 'number' || a.size <= 0) {
      return { valid: false, error: 'Attachment must have a positive size' };
    }
    if (!ALLOWED_ATTACHMENT_TYPES.has(a.mimeType)) {
      return { valid: false, error: `Unsupported attachment type: ${a.mimeType}` };
    }
    if (a.size > MAX_ATTACHMENT_SIZE) {
      return { valid: false, error: `Attachment "${a.filename}" exceeds 10MB limit` };
    }
    // Sanity check: base64 data should be roughly 4/3 of the reported binary size
    const estimatedBinarySize = Math.ceil(a.data.length * 0.75);
    if (estimatedBinarySize > MAX_ATTACHMENT_SIZE * 1.1) {
      return { valid: false, error: `Attachment "${a.filename}" data exceeds size limit` };
    }
    totalSize += Math.max(a.size, estimatedBinarySize);
    result.push({
      id: a.id,
      filename: a.filename,
      data: a.data,
      mimeType: a.mimeType,
      size: a.size,
    });
  }
  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    return { valid: false, error: 'Total attachment size exceeds 20MB limit' };
  }
  return { valid: true, value: result };
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateAttachmentSerializedPayload(input: {
  text: string;
  attachments: AttachmentPayload[];
}): { valid: true } | { valid: false; error: string } {
  const estimatedBytes = estimateAgentAttachmentSerializedPayloadBytes(input);
  if (estimatedBytes <= MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES) {
    return { valid: true };
  }
  return {
    valid: false,
    error: `Attachment payload is too large after optimization: ${formatAttachmentBytes(
      estimatedBytes
    )} serialized. Limit is ${formatAttachmentBytes(
      MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES
    )}. Remove an image or use a smaller screenshot.`,
  };
}

function formatAttachmentDeliveryFailure(error: unknown, teamStillAlive: boolean): string {
  if (!teamStillAlive) {
    return 'Failed to deliver message with attachments: team process became unavailable';
  }
  const message = getErrorMessage(error);
  if (message.startsWith('Failed to deliver message with attachments:')) {
    return message;
  }
  return `Failed to deliver message with attachments: ${message}`;
}

function buildMessageDeliveryText(
  baseText: string,
  opts: {
    actionMode?: AgentActionMode;
    isLeadRecipient: boolean;
    memberName?: string;
    messageId?: string;
    protocol?: VisibleDirectReplyProtocol;
    replyRecipient?: string;
    teamName?: string;
  }
): string {
  const hiddenBlocks: string[] = [];
  const actionModeBlock = buildActionModeAgentBlock(opts.actionMode);
  if (actionModeBlock) {
    hiddenBlocks.push(actionModeBlock);
  }
  if (!opts.isLeadRecipient) {
    const rawReplyRecipient =
      typeof opts.replyRecipient === 'string' && opts.replyRecipient.trim().length > 0
        ? opts.replyRecipient.trim()
        : 'user';
    const isUserReplyRecipient = rawReplyRecipient.toLowerCase() === 'user';
    const replyRecipient = isUserReplyRecipient ? 'user' : rawReplyRecipient;
    const senderDescriptor = isUserReplyRecipient ? 'the human user' : `"${replyRecipient}"`;
    const protocol = opts.protocol ?? 'send_message';
    const canUseAgentTeamsMessageSend =
      protocol === 'agent_teams_message_send' &&
      isUserReplyRecipient &&
      typeof opts.teamName === 'string' &&
      opts.teamName.trim().length > 0 &&
      typeof opts.memberName === 'string' &&
      opts.memberName.trim().length > 0 &&
      typeof opts.messageId === 'string' &&
      opts.messageId.trim().length > 0;
    const replyInstructionLines = canUseAgentTeamsMessageSend
      ? [
          'CRITICAL: Reply using the Agent Teams MCP message_send tool, not SendMessage.',
          'Use tool agent-teams_message_send or mcp__agent-teams__message_send, whichever exposed name is available.',
          `CRITICAL: The tool input must include teamName="${opts.teamName!.trim()}", to="user", from="${opts.memberName!.trim()}", text, summary, source="runtime_delivery", and relayOfMessageId="${opts.messageId!.trim()}".`,
          'Do NOT answer only with normal assistant text when the Agent Teams message_send tool is available because that will not appear in the UI message thread.',
        ]
      : [
          'CRITICAL: Reply using the SendMessage tool, not plain assistant text.',
          `CRITICAL: The destination must be exactly to="${replyRecipient}".`,
          'CRITICAL: The SendMessage tool input must use the exact field names `to`, `summary`, and `message`.',
          'Do NOT answer only with normal assistant text because that will not appear in the UI message thread.',
        ];
    hiddenBlocks.push(
      wrapAgentBlock(
        [
          `You received a direct message from ${senderDescriptor} via the UI.`,
          ...replyInstructionLines,
          `Please reply back to recipient "${replyRecipient}" with a short, human-readable answer.`,
          'If you cannot respond now, reply with a brief status (e.g. "Busy, will reply later").',
          ...(canUseAgentTeamsMessageSend
            ? [
                'If neither Agent Teams MCP message_send tool name is available before any visible-message tool attempt, write exactly the concise reply text as normal assistant text so the runtime can relay it.',
              ]
            : []),
          ...(isUserReplyRecipient
            ? [
                'CRITICAL: If the user asks you to check with the lead or another teammate before you can fully answer, FIRST send a short acknowledgement to "user" so the human sees you started (for example: "Принял, сейчас уточню и вернусь с ответом.").',
                'Only after that first acknowledgement may you message the lead or another teammate.',
                'After you get the needed information, send the final answer back to "user".',
                'Do NOT stay silent while you go ask someone else.',
              ]
            : []),
        ].join('\n')
      )
    );
  }

  if (hiddenBlocks.length === 0) {
    return baseText;
  }

  return [...hiddenBlocks, baseText].join('\n\n');
}

async function handleSendMessage(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  request: unknown
): Promise<IpcResult<SendMessageResult>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  if (!request || typeof request !== 'object') {
    return { success: false, error: 'Invalid send message request' };
  }

  const payload = request as Partial<SendMessageRequest>;
  const validatedMember = validateMemberName(payload.member);
  if (!validatedMember.valid) {
    return { success: false, error: validatedMember.error ?? 'Invalid member' };
  }
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    return { success: false, error: 'text must be non-empty string' };
  }
  if (payload.summary !== undefined && typeof payload.summary !== 'string') {
    return { success: false, error: 'summary must be string' };
  }
  if (payload.from !== undefined) {
    const validatedFrom = validateFromField(payload.from);
    if (!validatedFrom.valid) {
      return { success: false, error: validatedFrom.error ?? 'Invalid from' };
    }
  }
  if (payload.actionMode !== undefined && !isAgentActionMode(payload.actionMode)) {
    return { success: false, error: 'actionMode must be one of: do, ask, delegate' };
  }
  const validatedTaskRefs = validateTaskRefs(payload.taskRefs);
  if (!validatedTaskRefs.valid) {
    return { success: false, error: validatedTaskRefs.error };
  }

  let validatedAttachments: AttachmentPayload[] | undefined;
  if (
    payload.attachments !== undefined &&
    Array.isArray(payload.attachments) &&
    payload.attachments.length > 0
  ) {
    const attResult = validateAttachments(payload.attachments);
    if (!attResult.valid) {
      return { success: false, error: attResult.error };
    }
    validatedAttachments = attResult.value;
    const serializedResult = validateAttachmentSerializedPayload({
      text: payload.text,
      attachments: validatedAttachments,
    });
    if (!serializedResult.valid) {
      return { success: false, error: serializedResult.error };
    }
  }

  const tn = validatedTeamName.value!;
  const memberName = validatedMember.value!;
  let prevalidatedLeadName: string | null | undefined;
  let prevalidatedIsLeadRecipient: boolean | undefined;
  if (payload.actionMode === 'delegate') {
    try {
      prevalidatedLeadName = await getTeamDataService().getLeadMemberName(tn);
    } catch (error) {
      return wrapTeamHandler('sendMessage', async () => {
        throw error;
      });
    }
    prevalidatedIsLeadRecipient =
      prevalidatedLeadName !== null && memberName === prevalidatedLeadName;
    if (!prevalidatedIsLeadRecipient) {
      return {
        success: false,
        error: 'Delegate mode is only supported when messaging the team lead',
      };
    }
  }

  return wrapTeamHandler('sendMessage', async () => {
    const messaging = getTeamMessagingApi();
    const runtime = getTeamRuntimeApi();
    const isAlive = runtime.isTeamAlive(tn);

    const leadName =
      prevalidatedLeadName !== undefined
        ? prevalidatedLeadName
        : await getTeamDataService().getLeadMemberName(tn);
    const isLeadRecipient =
      prevalidatedIsLeadRecipient !== undefined
        ? prevalidatedIsLeadRecipient
        : leadName !== null && memberName === leadName;
    const actionMode = payload.actionMode;

    const recipientProviderId = await messaging.resolveRuntimeRecipientProviderId(tn, memberName);
    const isOpenCodeRecipient = recipientProviderId === 'opencode';

    // Attachments are routed through explicit provider transports only.
    // Native Claude/Codex teammates still read inbox files directly, so storing
    // attachment metadata there would look successful while silently dropping
    // the image at runtime. Keep those paths fail-closed until they have a
    // real runtime attachment transport.
    if (validatedAttachments?.length) {
      const supportedLiveLead = isLeadRecipient && isAlive;
      const supportedLiveOpenCodeRecipient = !isLeadRecipient && isOpenCodeRecipient && isAlive;
      if (!supportedLiveLead && !supportedLiveOpenCodeRecipient) {
        throw new Error(
          isOpenCodeRecipient
            ? 'Attachments for OpenCode teammates require the team to be online'
            : 'Attachments are supported for the online team lead and online OpenCode teammates only'
        );
      }
    }

    // Smart routing: lead + alive → stdin direct, else → inbox
    if (isLeadRecipient && isAlive && !isOpenCodeRecipient) {
      const resolvedLeadName = leadName ?? memberName;
      const teammateRoster = await getDurableLeadTeammateRoster(tn, resolvedLeadName);
      const rosterContextBlock = buildLeadRosterContextBlock(tn, resolvedLeadName, teammateRoster);
      const delegateAckBlock = buildLeadDirectDelegateAckBlock(actionMode);
      // Pre-generate stable messageId so both stdin and persistence use the same identity.
      // This allows the lead to call task_create_from_message with the exact messageId.
      const preGeneratedMessageId = crypto.randomUUID();
      // Separate try blocks: stdin delivery vs persistence
      // If stdin succeeds but persistence fails, do NOT fallback to inbox (would duplicate)
      const standaloneSlashCommand = !validatedAttachments?.length
        ? parseStandaloneSlashCommand(payload.text!)
        : null;
      const slashCommandMeta = standaloneSlashCommand
        ? buildStandaloneSlashCommandMeta(standaloneSlashCommand.raw)
        : null;
      const rawSlashCommandText = standaloneSlashCommand?.raw;
      const stdinTextForLead = rawSlashCommandText
        ? rawSlashCommandText
        : [
            `You received a direct message from the user.`,
            `IMPORTANT: Your text response here is shown to the user in the Messages panel. Always include a brief human-readable reply. Do NOT respond with only an agent-only block.`,
            ...(rosterContextBlock ? [rosterContextBlock] : []),
            ...(delegateAckBlock ? [delegateAckBlock] : []),
            wrapAgentBlock(
              [
                `MessageId: ${preGeneratedMessageId}`,
                `When creating a task from this user message, prefer task_create_from_message with messageId="${preGeneratedMessageId}" for reliable provenance. Only use this exact messageId — never guess or fabricate one.`,
              ].join('\n')
            ),
            ``,
            `Message from user:`,
            buildMessageDeliveryText(payload.text!, {
              actionMode,
              isLeadRecipient: true,
            }),
          ].join('\n');
      const persistTextForLead = rawSlashCommandText ?? payload.text!;

      let stdinSent = false;
      try {
        await messaging.sendMessageToTeam(
          tn,
          stdinTextForLead,
          rawSlashCommandText ? undefined : validatedAttachments
        );
        stdinSent = true;
      } catch (stdinError: unknown) {
        // If attachments were requested, fail rather than silently dropping them.
        // Only report offline when liveness confirms the process is unavailable.
        if (validatedAttachments?.length) {
          throw new Error(formatAttachmentDeliveryFailure(stdinError, runtime.isTeamAlive(tn)));
        }
        const errMsg = stdinError instanceof Error ? stdinError.message : 'unknown error';
        logger.warn(`stdin fallback for ${tn}: ${errMsg}`);
        // Fallback to inbox path below
      }

      if (stdinSent) {
        // Save attachment files to disk FIRST to get file paths for metadata
        let attachmentFilePaths: Map<string, string> | undefined;
        if (validatedAttachments?.length) {
          try {
            attachmentFilePaths = await attachmentStore.saveAttachments(
              tn,
              preGeneratedMessageId,
              validatedAttachments
            );
          } catch (e) {
            logger.warn(`Failed to save attachments: ${e}`);
          }
        }

        const attachmentMeta: AttachmentMeta[] | undefined = validatedAttachments?.map((a) => {
          const fp = attachmentFilePaths?.get(a.id);
          return {
            id: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            ...(fp ? { filePath: fp } : {}),
          };
        });

        // Persistence is best-effort — stdin already delivered the message
        let result: SendMessageResult;
        try {
          result = await getTeamDataService().sendDirectToLead(
            tn,
            resolvedLeadName,
            persistTextForLead,
            payload.summary,
            attachmentMeta,
            validatedTaskRefs.value,
            preGeneratedMessageId
          );
        } catch (persistError) {
          logger.warn(`Persistence failed after stdin delivery for ${tn}: ${String(persistError)}`);
          result = { deliveredToInbox: false, messageId: preGeneratedMessageId };
        }

        // Attachment files already saved above (before metadata construction)

        messaging.pushLiveLeadProcessMessage(tn, {
          from: 'user',
          to: resolvedLeadName,
          text: persistTextForLead,
          timestamp: new Date().toISOString(),
          read: true,
          summary: payload.summary,
          messageId: result.messageId,
          source: 'user_sent',
          attachments: attachmentMeta,
          taskRefs: validatedTaskRefs.value,
          ...(slashCommandMeta
            ? {
                messageKind: 'slash_command' as const,
                slashCommand: slashCommandMeta,
              }
            : {}),
        });

        return result;
      }
    }

    // Inbox path: offline lead or regular members.
    const baseText = payload.text!.trim();
    const replyRecipient =
      typeof payload.from === 'string' && payload.from.trim().length > 0
        ? payload.from.trim()
        : 'user';
    const storedFrom = replyRecipient.toLowerCase() === 'user' ? 'user' : replyRecipient;
    const directReplyProtocol = resolveVisibleDirectReplyProtocol({
      isLeadRecipient,
      replyRecipient,
      ...(recipientProviderId ? { providerId: recipientProviderId } : {}),
    });
    const inboxMessageId =
      directReplyProtocol === 'agent_teams_message_send' || validatedAttachments?.length
        ? crypto.randomUUID()
        : undefined;
    const memberDeliveryText = buildMessageDeliveryText(baseText, {
      actionMode,
      isLeadRecipient,
      memberName,
      protocol: directReplyProtocol,
      replyRecipient,
      teamName: tn,
      ...(inboxMessageId ? { messageId: inboxMessageId } : {}),
    });
    const inboxText = isOpenCodeRecipient ? baseText : memberDeliveryText;
    if (validatedAttachments?.length && inboxMessageId) {
      try {
        await attachmentStore.saveAttachments(tn, inboxMessageId, validatedAttachments);
      } catch (error) {
        throw new Error(`Failed to save message attachments: ${getErrorMessage(error)}`);
      }
    }

    const messageRequest: SendMessageRequest = {
      member: memberName,
      text: inboxText,
      summary: payload.summary,
      from: storedFrom,
      actionMode,
      source: 'user_sent',
      taskRefs: validatedTaskRefs.value,
      ...(inboxMessageId ? { messageId: inboxMessageId } : {}),
      ...(validatedAttachments?.length ? { attachments: validatedAttachments } : {}),
    };
    const teamDataService = getTeamDataService();
    const result = isOpenCodeRecipient
      ? await teamDataService.sendRuntimeRecipientMessage(tn, messageRequest)
      : await teamDataService.sendMessage(tn, messageRequest);

    // Teammate inbox relay DISABLED (2026-03-23).
    // Codex/Claude teammates read their own inbox files directly via fs.watch.
    // Relaying through the lead (relayMemberInboxMessages) caused multiple bugs:
    //   1. Lead responded to user instead of forwarding to the teammate
    //   2. Duplicate messages (relay loop: markInboxMessagesRead → FileWatcher → relay again)
    //   3. Fragile LLM-dependent prompt chain for routing
    // The message is already persisted in inboxes/{member}.json above.
    // Teammate responses go to inboxes/user.json and are read by TeamInboxReader.
    // Lead relay (relayLeadInboxMessages) is still needed because lead reads stdin only, not inbox.
    // OpenCode secondary lanes do not watch these inbox files, so they need runtime bridge delivery.
    //
    // if (!isLeadRecipient && isAlive) {
    //   try {
    //     await provisioning.relayMemberInboxMessages(tn, memberName);
    //   } catch (e: unknown) {
    //     logger.warn(`Relay after sendMessage failed for teammate "${memberName}": ${String(e)}`);
    //   }
    // }
    if (isOpenCodeRecipient) {
      try {
        const relay = await waitForOpenCodeRuntimeRelayForUi({
          messaging,
          teamName: tn,
          memberName,
          messageId: result.messageId,
          relayPromise: messaging.relayOpenCodeMemberInboxMessages(tn, memberName, {
            onlyMessageId: result.messageId,
            source: 'ui-send',
            deliveryMetadata: {
              replyRecipient,
              actionMode,
              taskRefs: validatedTaskRefs.value,
            },
          }),
        });
        const delivery = relay.lastDelivery ?? {
          delivered: relay.relayed > 0,
          reason: relay.relayed > 0 ? undefined : 'opencode_message_delivery_not_attempted',
          diagnostics: undefined,
        };
        result.runtimeDelivery = {
          providerId: 'opencode',
          attempted: true,
          delivered: delivery.delivered,
          accepted: delivery.accepted,
          responsePending: delivery.responsePending,
          acceptanceUnknown: delivery.acceptanceUnknown,
          responseState: delivery.responseState,
          ledgerStatus: delivery.ledgerStatus,
          visibleReplyMessageId: delivery.visibleReplyMessageId,
          visibleReplyCorrelation: delivery.visibleReplyCorrelation,
          ledgerRecordId: delivery.ledgerRecordId,
          laneId: delivery.laneId,
          queuedBehindMessageId: delivery.queuedBehindMessageId,
          reason: delivery.reason,
          diagnostics: delivery.diagnostics,
          userVisibleImpact:
            delivery.userVisibleImpact ?? buildOpenCodeRuntimeDeliveryUserVisibleImpact(delivery),
        };
        if (
          !delivery.delivered &&
          delivery.reason !== 'recipient_is_not_opencode' &&
          delivery.reason !== 'opencode_runtime_delivery_ui_timeout_pending'
        ) {
          logger.warn(
            `OpenCode runtime delivery after sendMessage failed for teammate "${memberName}": ${
              delivery.reason ?? 'unknown error'
            }`
          );
        }
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        result.runtimeDelivery = {
          providerId: 'opencode',
          attempted: true,
          delivered: false,
          reason,
          diagnostics: [reason],
          userVisibleImpact: buildOpenCodeRuntimeDeliveryUserVisibleImpact({
            delivered: false,
            reason,
            diagnostics: [reason],
          }),
        };
        logger.warn(
          `OpenCode runtime delivery after sendMessage crashed for teammate "${memberName}": ${reason}`
        );
      }
    }

    // Best-effort relay for lead via inbox
    if (isLeadRecipient && isAlive) {
      void messaging
        .relayLeadInboxMessages(tn)
        .catch((e: unknown) =>
          logger.warn(`Relay after sendMessage failed for ${tn}: ${String(e)}`)
        );
    }

    return result;
  });
}

async function handleGetOpenCodeRuntimeDeliveryStatus(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  messageId: unknown
): Promise<IpcResult<OpenCodeRuntimeDeliveryStatus | null>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    return { success: false, error: 'messageId must be a non-empty string' };
  }
  const safeMessageId = messageId.trim();
  if (safeMessageId.includes('/') || safeMessageId.includes('\\') || safeMessageId.includes('..')) {
    return { success: false, error: 'Invalid messageId' };
  }
  return wrapTeamHandler('getOpenCodeRuntimeDeliveryStatus', async () =>
    getTeamMessagingApi().getOpenCodeRuntimeDeliveryStatus(validatedTeamName.value!, safeMessageId)
  );
}

async function handleProcessSend(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  message: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { success: false, error: 'message must be a non-empty string' };
  }
  return wrapTeamHandler('processSend', () =>
    getTeamMessagingApi().sendMessageToTeam(validatedTeamName.value!, message)
  );
}

async function handleProcessAlive(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<boolean>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('processAlive', async () =>
    getTeamRuntimeApi().isTeamAlive(validatedTeamName.value!)
  );
}

async function handleCreateConfig(
  _event: IpcMainInvokeEvent,
  request: unknown
): Promise<IpcResult<void>> {
  if (!request || typeof request !== 'object') {
    return { success: false, error: 'Invalid create config request' };
  }

  const payload = request as Partial<TeamCreateConfigRequest>;
  if (typeof payload.teamName !== 'string' || payload.teamName.trim().length === 0) {
    return { success: false, error: 'teamName is required' };
  }
  const teamName = payload.teamName.trim();
  if (!isProvisioningTeamName(teamName)) {
    return { success: false, error: 'teamName must be kebab-case [a-z0-9-], max 64 chars' };
  }

  if (!Array.isArray(payload.members)) {
    return { success: false, error: 'members must be an array' };
  }

  if (payload.displayName !== undefined && typeof payload.displayName !== 'string') {
    return { success: false, error: 'displayName must be a string' };
  }
  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return { success: false, error: 'description must be a string' };
  }
  if (payload.color !== undefined && typeof payload.color !== 'string') {
    return { success: false, error: 'color must be a string' };
  }
  if (payload.cwd !== undefined) {
    if (typeof payload.cwd !== 'string' || payload.cwd.trim().length === 0) {
      return { success: false, error: 'cwd must be a non-empty string if provided' };
    }
    if (!path.isAbsolute(payload.cwd.trim())) {
      return { success: false, error: 'cwd must be an absolute path' };
    }
  }
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    return { success: false, error: 'prompt must be a string' };
  }
  const teamProviderValidation = parseOptionalTeamProviderId(payload.providerId);
  if (!teamProviderValidation.valid) {
    return { success: false, error: teamProviderValidation.error };
  }
  const effectiveTeamProviderId = teamProviderValidation.value ?? 'anthropic';
  const providerBackendValidation = parseOptionalLaunchProviderBackendId(
    payload.providerBackendId,
    effectiveTeamProviderId
  );
  if (!providerBackendValidation.valid) {
    return { success: false, error: providerBackendValidation.error };
  }
  if (payload.model !== undefined && typeof payload.model !== 'string') {
    return { success: false, error: 'model must be a string' };
  }
  const effortValidation = parseOptionalTeamEffort(payload.effort, effectiveTeamProviderId);
  if (!effortValidation.valid) {
    return { success: false, error: effortValidation.error };
  }
  const fastModeValidation = parseOptionalTeamFastMode(payload.fastMode);
  if (!fastModeValidation.valid) {
    return { success: false, error: fastModeValidation.error };
  }
  if (payload.limitContext !== undefined && typeof payload.limitContext !== 'boolean') {
    return { success: false, error: 'limitContext must be a boolean' };
  }
  if (payload.skipPermissions !== undefined && typeof payload.skipPermissions !== 'boolean') {
    return { success: false, error: 'skipPermissions must be a boolean' };
  }
  if (payload.worktree !== undefined) {
    if (typeof payload.worktree !== 'string') {
      return { success: false, error: 'worktree must be a string' };
    }
    const worktree = payload.worktree.trim();
    if (worktree.length > 128) {
      return { success: false, error: 'worktree name too long (max 128)' };
    }
    if (worktree && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(worktree)) {
      return {
        success: false,
        error: 'worktree name: start with alphanumeric, use [a-zA-Z0-9._-]',
      };
    }
  }
  if (payload.extraCliArgs !== undefined) {
    if (typeof payload.extraCliArgs !== 'string') {
      return { success: false, error: 'extraCliArgs must be a string' };
    }
    if (payload.extraCliArgs.length > 1024) {
      return { success: false, error: 'extraCliArgs too long (max 1024)' };
    }
    const protectedFlags = extractUserFlags(payload.extraCliArgs).filter((flag) =>
      PROTECTED_CLI_FLAGS.has(flag)
    );
    if (protectedFlags.length > 0) {
      return {
        success: false,
        error: `extraCliArgs contains app-managed flags: ${[...new Set(protectedFlags)].join(', ')}`,
      };
    }
  }

  const seenNames = new Set<string>();
  const members: TeamCreateConfigRequest['members'] = [];
  for (const member of payload.members) {
    if (!member || typeof member !== 'object') {
      return { success: false, error: 'member must be object' };
    }
    const nameValidation = validateTeammateName((member as { name?: unknown }).name);
    if (!nameValidation.valid) {
      return { success: false, error: nameValidation.error ?? 'Invalid member name' };
    }
    const memberName = nameValidation.value!;
    if (seenNames.has(memberName)) {
      return { success: false, error: 'member names must be unique' };
    }
    seenNames.add(memberName);

    const role = (member as { role?: unknown }).role;
    if (role !== undefined && typeof role !== 'string') {
      return { success: false, error: 'member role must be string' };
    }
    const workflow = (member as { workflow?: unknown }).workflow;
    if (workflow !== undefined && typeof workflow !== 'string') {
      return { success: false, error: 'member workflow must be string' };
    }
    const isolation = (member as { isolation?: unknown }).isolation;
    if (isolation !== undefined && isolation !== 'worktree') {
      return { success: false, error: 'member isolation must be "worktree" when provided' };
    }
    const providerValidation = parseOptionalMemberProviderId(
      (member as { providerId?: unknown }).providerId
    );
    if (!providerValidation.valid) {
      return { success: false, error: providerValidation.error };
    }
    const effectiveMemberProviderId = providerValidation.value ?? effectiveTeamProviderId;
    const providerBackendValidation = parseOptionalProviderBackendId(
      (member as { providerBackendId?: unknown }).providerBackendId,
      effectiveMemberProviderId
    );
    if (!providerBackendValidation.valid) {
      return { success: false, error: providerBackendValidation.error };
    }
    const model = (member as { model?: unknown }).model;
    if (model !== undefined && typeof model !== 'string') {
      return { success: false, error: 'member model must be string' };
    }
    const effortValidation = parseOptionalMemberEffort(
      (member as { effort?: unknown }).effort,
      effectiveMemberProviderId
    );
    if (!effortValidation.valid) {
      return { success: false, error: effortValidation.error };
    }
    const fastModeValidation = parseOptionalTeamFastMode(
      (member as { fastMode?: unknown }).fastMode
    );
    if (!fastModeValidation.valid) {
      return { success: false, error: fastModeValidation.error };
    }
    members.push({
      name: memberName,
      role: typeof role === 'string' ? role.trim() : undefined,
      workflow: typeof workflow === 'string' ? workflow.trim() : undefined,
      isolation: isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: providerValidation.value,
      providerBackendId: providerBackendValidation.value,
      model: typeof model === 'string' ? model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      mcpPolicy: normalizeTeamMemberMcpPolicy((member as { mcpPolicy?: unknown }).mcpPolicy),
    });
  }

  return wrapTeamHandler('createConfig', async () => {
    await getTeamDataService().createTeamConfig({
      teamName,
      displayName: payload.displayName?.trim() || undefined,
      description: payload.description?.trim() || undefined,
      color: typeof payload.color === 'string' ? payload.color.trim() || undefined : undefined,
      members,
      cwd: typeof payload.cwd === 'string' ? payload.cwd.trim() || undefined : undefined,
      prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
      providerId: teamProviderValidation.value,
      providerBackendId: providerBackendValidation.value,
      model: typeof payload.model === 'string' ? payload.model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      limitContext: typeof payload.limitContext === 'boolean' ? payload.limitContext : undefined,
      skipPermissions:
        typeof payload.skipPermissions === 'boolean' ? payload.skipPermissions : undefined,
      worktree:
        typeof payload.worktree === 'string' && payload.worktree.trim()
          ? payload.worktree.trim()
          : undefined,
      extraCliArgs:
        typeof payload.extraCliArgs === 'string' && payload.extraCliArgs.trim()
          ? payload.extraCliArgs.trim()
          : undefined,
    });
    getTeamDataWorkerClient().invalidateTeamConfig(teamName);
  });
}

function getTeamMemberLogsFinder(): TeamMemberLogsFinder {
  if (!teamMemberLogsFinder) {
    throw new Error('Team member logs finder is not initialized');
  }
  return teamMemberLogsFinder;
}

async function handleGetMemberLogs(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  memberName: unknown
): Promise<IpcResult<MemberLogSummary[]>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vMember = validateMemberName(memberName);
  if (!vMember.valid) {
    return { success: false, error: vMember.error ?? 'Invalid memberName' };
  }
  return wrapTeamHandler('getMemberLogs', () =>
    getTeamMemberLogsFinder().findMemberLogs(vTeam.value!, vMember.value!)
  );
}

async function handleGetLogsForTask(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  options?: {
    owner?: string;
    status?: string;
    intervals?: { startedAt: string; completedAt?: string }[];
    since?: string;
  }
): Promise<IpcResult<MemberLogSummary[]>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' };
  }
  const opts =
    options && typeof options === 'object'
      ? {
          owner: typeof options.owner === 'string' ? options.owner : undefined,
          status: typeof options.status === 'string' ? options.status : undefined,
          since: typeof options.since === 'string' ? options.since : undefined,
          intervals: Array.isArray(options.intervals)
            ? (options.intervals as unknown[]).filter(
                (i): i is { startedAt: string; completedAt?: string } =>
                  Boolean(i) &&
                  typeof i === 'object' &&
                  typeof (i as Record<string, unknown>).startedAt === 'string' &&
                  ((i as Record<string, unknown>).completedAt === undefined ||
                    typeof (i as Record<string, unknown>).completedAt === 'string')
              )
            : undefined,
        }
      : undefined;
  // Prefer worker thread to keep main event loop responsive.
  // Call worker directly (not via wrapTeamHandler) so that failures
  // propagate to the catch block and trigger the main-thread fallback.
  const worker = getTeamDataWorkerClient();
  if (worker.isAvailable()) {
    try {
      const result = await worker.findLogsForTask(vTeam.value!, vTask.value!, opts);
      return { success: true, data: result };
    } catch (workerErr) {
      const fatalError = getFatalTeamDataWorkerFailureMessage(workerErr);
      if (fatalError) {
        return { success: false, error: fatalError };
      }
      logger.warn(
        `[teams:getLogsForTask] worker failed, falling back: ${getWorkerErrorMessage(workerErr)}`
      );
    }
  }
  return wrapTeamHandler('getLogsForTask', () =>
    getTeamMemberLogsFinder().findLogsForTask(vTeam.value!, vTask.value!, opts)
  );
}

function getMemberStatsComputer(): MemberStatsComputer {
  if (!memberStatsComputer) {
    throw new Error('Member stats computer is not initialized');
  }
  return memberStatsComputer;
}

async function handleGetMemberStats(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  memberName: unknown
): Promise<IpcResult<MemberFullStats>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vMember = validateMemberName(memberName);
  if (!vMember.valid) {
    return { success: false, error: vMember.error ?? 'Invalid memberName' };
  }
  return wrapTeamHandler('getMemberStats', () =>
    getMemberStatsComputer().getStats(vTeam.value!, vMember.value!)
  );
}

async function handleAliveList(_event: IpcMainInvokeEvent): Promise<IpcResult<string[]>> {
  return wrapTeamHandler('aliveList', async () => getTeamRuntimeApi().getAliveTeams());
}

async function handleLeadActivity(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<LeadActivitySnapshot>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('leadActivity', async () =>
    getTeamDiagnosticsApi().getLeadActivityState(validated.value!)
  );
}

async function handleLeadContext(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<LeadContextUsageSnapshot>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('leadContext', async () =>
    getTeamDiagnosticsApi().getLeadContextUsage(validated.value!)
  );
}

async function handleMemberSpawnStatuses(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<MemberSpawnStatusesSnapshot>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('memberSpawnStatuses', async () =>
    getTeamMemberLifecycleApi().getMemberSpawnStatuses(validated.value!)
  );
}

async function handleGetAgentRuntime(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<TeamAgentRuntimeSnapshot>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('getAgentRuntime', async () =>
    getTeamDiagnosticsApi().getTeamAgentRuntimeSnapshot(validated.value!)
  );
}

async function handleRestartMember(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  memberName: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  const validatedMemberName = validateMemberName(memberName);
  if (!validatedMemberName.valid) {
    return { success: false, error: validatedMemberName.error ?? 'Invalid memberName' };
  }
  return wrapTeamHandler('restartMember', async () => {
    try {
      await getTeamMemberLifecycleApi().restartMember(
        validatedTeamName.value!,
        validatedMemberName.value!
      );
    } finally {
      getTeamDataService().invalidateMessageFeed(validatedTeamName.value!);
    }
  });
}

async function handleRetryFailedOpenCodeSecondaryLanes(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<RetryFailedOpenCodeSecondaryLanesResult>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('retryFailedOpenCodeSecondaryLanes', async () =>
    getTeamMemberLifecycleApi().retryFailedOpenCodeSecondaryLanes(validatedTeamName.value!)
  );
}

async function handleSkipMemberForLaunch(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  memberName: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  const validatedMemberName = validateMemberName(memberName);
  if (!validatedMemberName.valid) {
    return { success: false, error: validatedMemberName.error ?? 'Invalid memberName' };
  }
  return wrapTeamHandler('skipMemberForLaunch', async () =>
    getTeamMemberLifecycleApi().skipMemberForLaunch(
      validatedTeamName.value!,
      validatedMemberName.value!
    )
  );
}

async function handleStopTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('stop', async () => {
    addMainBreadcrumb('team', 'stop', { teamName: validated.value! });
    await getTeamRuntimeApi().stopTeam(validated.value!);
  });
}

async function handleAddMember(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  payload: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };

  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Invalid payload' };
  }
  const {
    name,
    role,
    workflow,
    isolation,
    providerId,
    providerBackendId,
    model,
    fastMode,
    mcpPolicy,
  } = payload as {
    name?: unknown;
    role?: unknown;
    workflow?: unknown;
    isolation?: unknown;
    providerId?: unknown;
    providerBackendId?: unknown;
    model?: unknown;
    effort?: unknown;
    fastMode?: unknown;
    mcpPolicy?: unknown;
  };
  const vName = validateTeammateName(name);
  if (!vName.valid) return { success: false, error: vName.error ?? 'Invalid member name' };
  if (role !== undefined && typeof role !== 'string') {
    return { success: false, error: 'role must be a string' };
  }
  if (workflow !== undefined && typeof workflow !== 'string') {
    return { success: false, error: 'workflow must be a string' };
  }
  if (isolation !== undefined && isolation !== 'worktree') {
    return { success: false, error: 'isolation must be "worktree" when provided' };
  }
  const providerValidation = parseOptionalMemberProviderId(providerId);
  if (!providerValidation.valid) {
    return { success: false, error: providerValidation.error };
  }
  const providerBackendValidation = parseOptionalProviderBackendId(
    providerBackendId,
    providerValidation.value
  );
  if (!providerBackendValidation.valid) {
    return { success: false, error: providerBackendValidation.error };
  }
  if (model !== undefined && typeof model !== 'string') {
    return { success: false, error: 'model must be a string' };
  }
  const effortValidation = parseOptionalMemberEffort(
    (payload as { effort?: unknown }).effort,
    providerValidation.value
  );
  if (!effortValidation.valid) {
    return { success: false, error: effortValidation.error };
  }
  const fastModeValidation = parseOptionalTeamFastMode(fastMode);
  if (!fastModeValidation.valid) {
    return { success: false, error: fastModeValidation.error };
  }

  return wrapTeamHandler('addMember', async () => {
    const tn = vTeam.value!;
    return getTeamMemberLifecycleApi().runLiveRosterMutation(tn, async () => {
      const memberName = vName.value!;
      const teamDataService = getTeamDataService();
      const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
      const previousTeamData = await teamDataService.getTeamData(tn);
      const previousMembers = previousTeamData.members as RuntimeRosterMutationMember[];
      const memberLifecycle = getTeamMemberLifecycleApi();
      const isTeamAlive = getTeamRuntimeApi().isTeamAlive(tn);
      if (isTeamAlive && isOpenCodeLedRoster(previousMembers)) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }

      await teamDataService.addMember(tn, {
        name: memberName,
        role: role,
        workflow: typeof workflow === 'string' ? workflow.trim() || undefined : undefined,
        isolation: isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: providerValidation.value,
        ...(providerBackendValidation.value
          ? { providerBackendId: providerBackendValidation.value }
          : {}),
        model: typeof model === 'string' ? model.trim() || undefined : undefined,
        effort: effortValidation.value,
        ...(fastModeValidation.value ? { fastMode: fastModeValidation.value } : {}),
        mcpPolicy: normalizeTeamMemberMcpPolicy(mcpPolicy),
      });
      invalidateTeamRosterSnapshotCaches(tn);

      if (isTeamAlive) {
        try {
          await memberLifecycle.attachLiveRosterMember(tn, memberName, {
            reason: 'member_added',
          });
        } catch (error) {
          await rollbackLiveRosterMutation({
            teamName: tn,
            teamDataService,
            memberLifecycle,
            previousMembers,
            previousMembersMeta,
            detachLiveMemberNames: [memberName],
          });
          throw error;
        }
      }
    });
  });
}

async function handleReplaceMembers(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  request: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  if (!request || typeof request !== 'object') {
    return { success: false, error: 'request must be an object' };
  }
  const payload = request as { members?: unknown };
  if (!Array.isArray(payload.members)) {
    return { success: false, error: 'members must be an array' };
  }
  const seenNames = new Set<string>();
  const members: {
    name: string;
    role?: string;
    workflow?: string;
    isolation?: 'worktree';
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
    mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
  }[] = [];
  for (const item of payload.members) {
    if (!item || typeof item !== 'object') {
      return { success: false, error: 'member must be object' };
    }
    const m = item as {
      name?: unknown;
      role?: unknown;
      workflow?: unknown;
      isolation?: unknown;
      providerId?: unknown;
      providerBackendId?: unknown;
      model?: unknown;
      effort?: unknown;
      fastMode?: unknown;
      mcpPolicy?: unknown;
    };
    const vName = validateTeammateName(m.name);
    if (!vName.valid) return { success: false, error: vName.error ?? 'Invalid member name' };
    const name = vName.value!;
    if (seenNames.has(name)) return { success: false, error: 'member names must be unique' };
    seenNames.add(name);
    if (m.role !== undefined && typeof m.role !== 'string') {
      return { success: false, error: 'member role must be string' };
    }
    if (m.workflow !== undefined && typeof m.workflow !== 'string') {
      return { success: false, error: 'member workflow must be string' };
    }
    if (m.isolation !== undefined && m.isolation !== 'worktree') {
      return { success: false, error: 'member isolation must be "worktree" when provided' };
    }
    const providerValidation = parseOptionalMemberProviderId(
      (m as { providerId?: unknown }).providerId
    );
    if (!providerValidation.valid) {
      return { success: false, error: providerValidation.error };
    }
    const providerBackendValidation = parseOptionalProviderBackendId(
      (m as { providerBackendId?: unknown }).providerBackendId,
      providerValidation.value
    );
    if (!providerBackendValidation.valid) {
      return { success: false, error: providerBackendValidation.error };
    }
    if (m.model !== undefined && typeof m.model !== 'string') {
      return { success: false, error: 'member model must be string' };
    }
    const effortValidation = parseOptionalMemberEffort(
      (m as { effort?: unknown }).effort,
      providerValidation.value
    );
    if (!effortValidation.valid) {
      return { success: false, error: effortValidation.error };
    }
    const fastModeValidation = parseOptionalTeamFastMode((m as { fastMode?: unknown }).fastMode);
    if (!fastModeValidation.valid) {
      return { success: false, error: fastModeValidation.error };
    }
    members.push({
      name,
      role: typeof m.role === 'string' ? m.role.trim() : undefined,
      workflow: typeof m.workflow === 'string' ? m.workflow.trim() : undefined,
      isolation: m.isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: providerValidation.value,
      providerBackendId: providerBackendValidation.value,
      model: typeof m.model === 'string' ? m.model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      mcpPolicy: normalizeTeamMemberMcpPolicy(m.mcpPolicy),
    });
  }

  return wrapTeamHandler('replaceMembers', async () => {
    const tn = vTeam.value!;
    return getTeamMemberLifecycleApi().runLiveRosterMutation(tn, async () => {
      const teamDataService = getTeamDataService();
      const memberLifecycle = getTeamMemberLifecycleApi();
      const isTeamAlive = getTeamRuntimeApi().isTeamAlive(tn);
      if (!isTeamAlive) {
        await teamDataService.replaceMembers(tn, { members });
        invalidateTeamRosterSnapshotCaches(tn);
        return;
      }

      const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
      const previousTeamData = await teamDataService.getTeamData(tn);
      const previousMembers = previousTeamData.members as RuntimeRosterMutationMember[];
      const useSecondaryOpenCodeLaneRouting = isTeamAlive && !isOpenCodeLedRoster(previousMembers);
      if (!useSecondaryOpenCodeLaneRouting) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }
      if (useSecondaryOpenCodeLaneRouting) {
        const ownershipMigrationNames = findOpenCodeOwnershipMigrationNames({
          previousMembers,
          nextMembers: members,
        });
        if (ownershipMigrationNames.length > 0) {
          throw new Error(
            `${OPENCODE_OWNERSHIP_MIGRATION_BLOCK_MESSAGE} Affected member(s): ${ownershipMigrationNames.join(', ')}`
          );
        }
      }
      const primaryDiff = buildReplaceMembersDiff(
        previousMembers.filter((member) =>
          useSecondaryOpenCodeLaneRouting ? !isOpenCodeRosterMutationMember(member) : true
        ),
        members.filter((member) =>
          useSecondaryOpenCodeLaneRouting ? !isOpenCodeRosterMutationMember(member) : true
        )
      );
      const previousByName = new Map(
        previousMembers
          .filter((member) => !member.removedAt)
          .map((member) => [member.name.trim().toLowerCase(), member])
      );
      const nextByName = new Map(
        members.map((member) => [
          member.name.trim().toLowerCase(),
          member as RuntimeRosterMutationMember,
        ])
      );
      const removedOpenCodeMembers = useSecondaryOpenCodeLaneRouting
        ? previousMembers.filter((member) => {
            const normalizedName = member.name.trim().toLowerCase();
            return (
              !member.removedAt &&
              isOpenCodeRosterMutationMember(member) &&
              !nextByName.has(normalizedName)
            );
          })
        : [];
      const addedOpenCodeMembers = useSecondaryOpenCodeLaneRouting
        ? members.filter((member) => {
            const normalizedName = member.name.trim().toLowerCase();
            return isOpenCodeRosterMutationMember(member) && !previousByName.has(normalizedName);
          })
        : [];
      const updatedOpenCodeMembers = useSecondaryOpenCodeLaneRouting
        ? members.filter((member) => {
            const normalizedName = member.name.trim().toLowerCase();
            const previousMember = previousByName.get(normalizedName);
            return (
              isOpenCodeRosterMutationMember(member) &&
              isOpenCodeRosterMutationMember(previousMember) &&
              didOpenCodeRosterMemberChange(previousMember, member)
            );
          })
        : [];

      await teamDataService.replaceMembers(tn, { members });
      invalidateTeamRosterSnapshotCaches(tn);

      if (!isTeamAlive) {
        return;
      }

      try {
        for (const removedMember of removedOpenCodeMembers) {
          await memberLifecycle.detachLiveRosterMember(tn, removedMember.name);
        }

        for (const addedMember of addedOpenCodeMembers) {
          await memberLifecycle.attachLiveRosterMember(tn, addedMember.name, {
            reason: 'member_added',
          });
        }

        for (const updatedMember of updatedOpenCodeMembers) {
          await memberLifecycle.attachLiveRosterMember(tn, updatedMember.name, {
            reason: 'member_updated',
          });
        }

        for (const removedMemberName of primaryDiff.removed) {
          await memberLifecycle.detachLiveRosterMember(tn, removedMemberName);
        }

        for (const addedMember of primaryDiff.added) {
          await memberLifecycle.attachLiveRosterMember(tn, addedMember.name, {
            reason: 'member_added',
          });
        }

        for (const updatedMember of primaryDiff.updated) {
          await memberLifecycle.attachLiveRosterMember(tn, updatedMember.name, {
            reason: 'member_updated',
          });
        }
      } catch (error) {
        await rollbackLiveRosterMutation({
          teamName: tn,
          teamDataService,
          memberLifecycle,
          previousMembers,
          previousMembersMeta,
          restoreLiveMemberNames: [
            ...removedOpenCodeMembers.map((member) => member.name),
            ...primaryDiff.removed,
            ...updatedOpenCodeMembers.map((member) => member.name),
            ...primaryDiff.updated.map((member) => member.name),
          ],
          detachLiveMemberNames: [
            ...addedOpenCodeMembers.map((member) => member.name),
            ...primaryDiff.added.map((member) => member.name),
          ],
        });
        throw error;
      }

      const summaryMessage = buildReplaceMembersSummaryMessage({
        ...primaryDiff,
        updated: [],
      });
      if (!summaryMessage) {
        return;
      }
      try {
        await getTeamMessagingApi().sendMessageToTeam(tn, summaryMessage);
      } catch {
        logger.warn(`Failed to notify lead about member updates in ${tn}`);
      }
    });
  });
}

async function handleRemoveMember(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  memberName: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vMember = validateMemberName(memberName);
  if (!vMember.valid) return { success: false, error: vMember.error ?? 'Invalid memberName' };

  return wrapTeamHandler('removeMember', async () => {
    const tn = vTeam.value!;
    return getTeamMemberLifecycleApi().runLiveRosterMutation(tn, async () => {
      const name = vMember.value!;
      const teamDataService = getTeamDataService();
      const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
      const previousTeamData = await teamDataService.getTeamData(tn);
      const previousMembers = previousTeamData.members as RuntimeRosterMutationMember[];
      const normalizedMemberName = name.trim().toLowerCase();
      const isAlreadyRemoved = previousMembersMeta?.members.some(
        (member) =>
          member.name.trim().toLowerCase() === normalizedMemberName &&
          typeof member.removedAt === 'number'
      );
      if (isAlreadyRemoved) {
        return;
      }
      const memberLifecycle = getTeamMemberLifecycleApi();
      const isTeamAlive = getTeamRuntimeApi().isTeamAlive(tn);
      if (isTeamAlive && isOpenCodeLedRoster(previousMembers)) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }
      await teamDataService.removeMember(tn, name);
      invalidateTeamRosterSnapshotCaches(tn);

      try {
        await memberLifecycle.detachLiveRosterMember(tn, name);
      } catch (error) {
        await rollbackLiveRosterMutation({
          teamName: tn,
          teamDataService,
          memberLifecycle,
          previousMembers,
          previousMembersMeta,
          restoreLiveMemberNames: isTeamAlive ? [name] : [],
        });
        throw error;
      }

      if (isTeamAlive) {
        const message =
          `Teammate "${name}" has been removed from the team. ` +
          `They will no longer participate in team activities. Please reassign their tasks if needed.`;
        try {
          await getTeamMessagingApi().sendMessageToTeam(tn, message);
        } catch {
          logger.warn(`Failed to notify lead about removal of "${name}" in ${tn}`);
        }
      }
    });
  });
}

async function handleRestoreMember(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  memberName: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vMember = validateMemberName(memberName);
  if (!vMember.valid) return { success: false, error: vMember.error ?? 'Invalid memberName' };

  return wrapTeamHandler('restoreMember', async () => {
    const tn = vTeam.value!;
    return getTeamMemberLifecycleApi().runLiveRosterMutation(tn, async () => {
      const name = vMember.value!;
      const teamDataService = getTeamDataService();
      const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
      const previousTeamData = await teamDataService.getTeamData(tn);
      const previousMembers = previousTeamData.members as RuntimeRosterMutationMember[];
      const memberLifecycle = getTeamMemberLifecycleApi();
      const isTeamAlive = getTeamRuntimeApi().isTeamAlive(tn);
      if (isTeamAlive && isOpenCodeLedRoster(previousMembers)) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }

      await teamDataService.restoreMember(tn, name);
      invalidateTeamRosterSnapshotCaches(tn);

      if (!isTeamAlive) {
        return;
      }

      try {
        await memberLifecycle.attachLiveRosterMember(tn, name, {
          reason: 'member_restored',
        });
      } catch (error) {
        await rollbackLiveRosterMutation({
          teamName: tn,
          teamDataService,
          memberLifecycle,
          previousMembers,
          previousMembersMeta,
          detachLiveMemberNames: [name],
        });
        throw error;
      }
    });
  });
}

async function handleUpdateMemberRole(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  memberName: unknown,
  role: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vMember = validateMemberName(memberName);
  if (!vMember.valid) return { success: false, error: vMember.error ?? 'Invalid memberName' };

  if (role !== undefined && role !== null && typeof role !== 'string') {
    return { success: false, error: 'role must be a string, null, or undefined' };
  }

  const normalizedRole =
    role === undefined || role === null
      ? undefined
      : typeof role === 'string'
        ? role.trim() || undefined
        : undefined;

  return wrapTeamHandler('updateMemberRole', async () => {
    const tn = vTeam.value!;
    return getTeamMemberLifecycleApi().runLiveRosterMutation(tn, async () => {
      const name = vMember.value!;
      const { oldRole, changed } = await getTeamDataService().updateMemberRole(
        tn,
        name,
        normalizedRole
      );

      if (changed) {
        invalidateTeamRosterSnapshotCaches(tn);
        if (getTeamRuntimeApi().isTeamAlive(tn)) {
          const oldDesc = oldRole ? `"${oldRole}"` : 'none';
          const newDesc = normalizedRole ? `"${normalizedRole}"` : 'none';
          const message = `Teammate "${name}" role changed from ${oldDesc} to ${newDesc}. This will take effect on next launch.`;
          try {
            await getTeamMessagingApi().sendMessageToTeam(tn, message);
          } catch {
            logger.warn(`Failed to notify lead about role change for "${name}" in ${tn}`);
          }
        }
      }
    });
  });
}

async function handleKillProcess(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  pid: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { success: false, error: 'pid must be a positive integer' };
  }
  return wrapTeamHandler('killProcess', async () => {
    const tn = vTeam.value!;
    const pidNum = pid;

    // Read process label before killing (for notification message)
    let processLabel = `PID ${pidNum}`;
    try {
      const data = await getTeamDataService().getTeamData(tn);
      const proc = data.processes?.find((p) => p.pid === pidNum);
      if (proc) {
        processLabel = proc.label + (proc.port != null ? ` (:${proc.port})` : '');
      }
    } catch {
      // best-effort label lookup
    }

    await getTeamDataService().killProcess(tn, pidNum);

    // Notify the team lead about the killed process
    if (getTeamRuntimeApi().isTeamAlive(tn)) {
      const message =
        `Process "${processLabel}" (PID ${pidNum}) has been stopped by the user from the UI. ` +
        `You may need to restart it if it was still needed.`;
      try {
        await getTeamMessagingApi().sendMessageToTeam(tn, message);
      } catch {
        logger.warn(`Failed to notify lead about killed process ${pidNum} in ${tn}`);
      }
    }
  });
}

async function handleShowMessageNotification(
  _event: IpcMainInvokeEvent,
  data: unknown
): Promise<IpcResult<void>> {
  if (!data || typeof data !== 'object') {
    return { success: false, error: 'Invalid notification data' };
  }
  const d = data as TeamMessageNotificationData;
  if (!d.teamDisplayName || !d.from || !d.body) {
    return { success: false, error: 'Missing required fields (teamDisplayName, from, body)' };
  }
  if (!d.teamName) {
    return {
      success: false,
      error: 'Missing required field: teamName (needed for deep-link navigation)',
    };
  }

  // Route through NotificationManager for unified storage + native toast.
  // dedupeKey is required from renderer — built from stable identifiers (taskId, teamName, etc.)
  const dedupeKey =
    d.dedupeKey ?? `msg:${d.teamName}:${d.from}:${d.summary ?? d.body.slice(0, 50)}`;

  void NotificationManager.getInstance()
    .addTeamNotification({
      teamEventType: d.teamEventType ?? 'task_clarification',
      teamName: d.teamName,
      teamDisplayName: d.teamDisplayName,
      from: d.from,
      to: d.to,
      summary: d.summary ?? `${d.from} → ${d.to ?? 'team'}`,
      body: d.body,
      dedupeKey,
      target: d.target,
      suppressToast: d.suppressToast,
    })
    .catch(() => undefined);

  return { success: true, data: undefined };
}

/**
 * Show a native OS notification for a team event.
 * @deprecated Use NotificationManager.addTeamNotification() instead for unified storage + toast.
 * Kept for backward compatibility with any remaining callers.
 */
export function showTeamNativeNotification(opts: {
  title: string;
  subtitle?: string;
  body: string;
}): void {
  const config = ConfigManager.getInstance().getConfig();
  if (!config.notifications.enabled) {
    logger.debug('[native-notification] skipped: notifications disabled');
    return;
  }
  if (config.notifications.snoozedUntil && Date.now() < config.notifications.snoozedUntil) {
    logger.debug('[native-notification] skipped: snoozed');
    return;
  }

  if (
    typeof Notification === 'undefined' ||
    typeof Notification.isSupported !== 'function' ||
    !Notification.isSupported()
  ) {
    logger.warn('[native-notification] skipped: Notification not supported on this platform');
    return;
  }

  const isMac = process.platform === 'darwin';
  const truncatedBody = stripMarkdown(opts.body).slice(0, 300);
  const iconPath = isMac ? undefined : getAppIconPath();
  const notification = new Notification({
    title: opts.title,
    ...(isMac && opts.subtitle ? { subtitle: opts.subtitle } : {}),
    body: !isMac && opts.subtitle ? `${opts.subtitle}\n${truncatedBody}` : truncatedBody,
    sound: config.notifications.soundEnabled ? 'default' : undefined,
    ...(iconPath ? { icon: iconPath } : {}),
  });

  // Hold a strong reference to prevent GC from collecting the notification.
  // macOS never fires 'close' for toasts the user ignores, so also drop the
  // reference after a grace window — otherwise ignored toasts accumulate for
  // the whole session. Late clicks from Notification Center past this window
  // are best-effort only.
  activeTeamNotifications.add(notification);
  const releaseTimer = setTimeout(cleanup, 15 * 60_000);
  releaseTimer.unref?.();
  function cleanup(): void {
    clearTimeout(releaseTimer);
    activeTeamNotifications.delete(notification);
  }

  notification.on('click', () => {
    const windows = BrowserWindow.getAllWindows();
    const mainWin = windows[0];
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
    }
    cleanup();
  });
  notification.on('close', cleanup);

  notification.on('show', () => {
    logger.debug(`[native-notification] shown: "${opts.title}" — ${opts.subtitle ?? ''}`);
  });

  notification.on('failed', (_, error) => {
    logger.warn(`[native-notification] failed: ${error}`);
    cleanup();
  });

  notification.show();
}

// ---------------------------------------------------------------------------
// Task Attachment Handlers
// ---------------------------------------------------------------------------

async function handleSaveTaskAttachment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  attachmentId: unknown,
  filename: unknown,
  mimeType: unknown,
  base64Data: unknown
): Promise<IpcResult<TaskAttachmentMeta>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
    return { success: false, error: 'attachmentId must be a non-empty string' };
  }
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    return { success: false, error: 'filename must be a non-empty string' };
  }
  if (!isValidStoredAttachmentMimeType(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  if (typeof base64Data !== 'string' || base64Data.length === 0) {
    return { success: false, error: 'base64Data must be a non-empty string' };
  }
  // Sanitize IDs against path traversal
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('saveTaskAttachment', async () => {
    const meta = await taskAttachmentStore.saveAttachment(
      vTeam.value!,
      vTask.value!,
      safeAttId,
      filename,
      mimeType.trim(),
      base64Data
    );
    // Write metadata into the task JSON
    await getTeamDataService().addTaskAttachment(vTeam.value!, vTask.value!, meta);
    return meta;
  });
}

async function handleGetTaskAttachment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  attachmentId: unknown,
  mimeType: unknown
): Promise<IpcResult<string | null>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
    return { success: false, error: 'attachmentId must be a non-empty string' };
  }
  if (!isValidStoredAttachmentMimeType(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('getTaskAttachment', () =>
    taskAttachmentStore.getAttachment(vTeam.value!, vTask.value!, safeAttId, mimeType.trim())
  );
}

async function handleDeleteTaskAttachment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  attachmentId: unknown,
  mimeType: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
    return { success: false, error: 'attachmentId must be a non-empty string' };
  }
  if (!isValidStoredAttachmentMimeType(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('deleteTaskAttachment', async () => {
    await taskAttachmentStore.deleteAttachment(
      vTeam.value!,
      vTask.value!,
      safeAttId,
      mimeType.trim()
    );
    // Remove metadata from task JSON
    await getTeamDataService().removeTaskAttachment(vTeam.value!, vTask.value!, safeAttId);
  });
}

async function handleGetSavedRequest(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<TeamCreateRequest | null>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('getSavedRequest', async () => {
    return getTeamDataService().getSavedRequest(validated.value!);
  });
}

async function handleDeleteDraft(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('deleteDraft', async () => {
    // Only allow deleting draft teams (no config.json)
    const configPath = path.join(getTeamsBasePath(), validated.value!, 'config.json');
    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      throw new Error('Cannot delete draft: team has config.json (use deleteTeam instead)');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await getTeamDataService().permanentlyDeleteTeam(validated.value!);
  });
}
