import { addMainBreadcrumb } from '@main/sentry';
import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { getAppIconPath } from '@main/utils/appIcon';
import { getAppDataPath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { stripMarkdown } from '@main/utils/textFormatting';
import {
  TEAM_ADD_MEMBER,
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_TASK,
  TEAM_DELETE_DRAFT,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_DELETE_TEAM,
  TEAM_GET_AGENT_RUNTIME,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_CLAUDE_LOGS,
  TEAM_GET_DATA,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_ACTIVITY_META,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_MESSAGES_PAGE,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_SAVED_REQUEST,
  TEAM_GET_TASK_ACTIVITY,
  TEAM_GET_TASK_ACTIVITY_DETAIL,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_GET_TASK_EXACT_LOG_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
  TEAM_GET_TASK_LOG_STREAM,
  TEAM_GET_TASK_LOG_STREAM_SUMMARY,
  TEAM_KILL_PROCESS,
  TEAM_LAUNCH,
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
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REPLACE_MEMBERS,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTART_MEMBER,
  TEAM_RESTORE,
  TEAM_RESTORE_TASK,
  TEAM_SAVE_TASK_ATTACHMENT,
  TEAM_SEND_MESSAGE,
  TEAM_SET_CHANGE_PRESENCE_TRACKING,
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  TEAM_SKIP_MEMBER_FOR_LAUNCH,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_START_TASK_BY_USER,
  TEAM_STOP,
  TEAM_TOOL_APPROVAL_READ_FILE,
  TEAM_TOOL_APPROVAL_RESPOND,
  TEAM_TOOL_APPROVAL_SETTINGS,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
  TEAM_VALIDATE_CLI_ARGS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN, wrapAgentBlock } from '@shared/constants/agentBlocks';
import { KANBAN_COLUMN_IDS } from '@shared/constants/kanban';
import { MAX_TEXT_LENGTH } from '@shared/constants/teamLimits';
import { isApiErrorMessage } from '@shared/utils/apiErrorDetector';
import {
  extractFlagsFromHelp,
  extractUserFlags,
  PROTECTED_CLI_FLAGS,
} from '@shared/utils/cliArgsParser';
import {
  formatEffortLevelListForProvider,
  isTeamEffortLevelForProvider,
} from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import { isRateLimitMessage } from '@shared/utils/rateLimitDetector';
import {
  buildStandaloneSlashCommandMeta,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import crypto from 'crypto';
import { app, BrowserWindow, type IpcMain, type IpcMainInvokeEvent, Notification } from 'electron';
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
  getAutoResumeService,
  initializeAutoResumeService,
} from '../services/team/AutoResumeService';
import {
  buildReplaceMembersDiff,
  buildReplaceMembersSummaryMessage,
} from '../services/team/memberUpdateNotifications';
import { mergeLiveLeadProcessMessages } from '../services/team/mergeLiveLeadProcessMessages';
import { TeamAttachmentStore } from '../services/team/TeamAttachmentStore';
import { TeamMembersMetaStore } from '../services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../services/team/TeamMetaStore';
import { buildAddMemberSpawnMessage } from '../services/team/TeamProvisioningService';
import { TeamTaskAttachmentStore } from '../services/team/TeamTaskAttachmentStore';

import {
  validateFromField,
  validateMemberName,
  validateTaskId,
  validateTeammateName,
  validateTeamName,
} from './guards';

import type {
  BoardTaskActivityDetailService,
  BoardTaskActivityService,
  BoardTaskExactLogDetailService,
  BoardTaskExactLogsService,
  BoardTaskLogStreamService,
  BranchStatusService,
  MemberStatsComputer,
  TeamDataService,
  TeamLogSourceTracker,
  TeammateToolTracker,
  TeamMemberLogsFinder,
  TeamProvisioningService,
} from '../services';
import type { TeamBackupService } from '../services/team/TeamBackupService';
import type { TeamMembersMetaFile } from '../services/team/TeamMembersMetaStore';
import type {
  AddTaskCommentRequest,
  AgentActionMode,
  AttachmentFileData,
  AttachmentMeta,
  AttachmentPayload,
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskLogStreamResponse,
  BoardTaskLogStreamSummary,
  CreateTaskRequest,
  EffortLevel,
  GlobalTask,
  IpcResult,
  KanbanColumnId,
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberFullStats,
  MemberLogSummary,
  MemberSpawnStatusesSnapshot,
  MessagesPage,
  SendMessageRequest,
  SendMessageResult,
  TaskAttachmentMeta,
  TaskChangePresenceState,
  TaskComment,
  TaskRef,
  TeamAgentRuntimeSnapshot,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamFastMode,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMemberActivityMeta,
  TeamMessageNotificationData,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamUpdateConfigRequest,
  TeamViewSnapshot,
  ToolApprovalFileContent,
  ToolApprovalSettings,
  UpdateKanbanPatch,
} from '@shared/types';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

const logger = createLogger('IPC:teams');
const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS = 12_000;

/**
 * In-memory set of rate-limit message keys already processed.
 * Independent of NotificationManager storage — survives notification deletion/pruning.
 * Without this, deleted rate-limit notifications would re-appear on next getData() scan.
 */
const seenRateLimitKeys = new Set<string>();
const SEEN_RATE_LIMIT_KEYS_MAX = 500;

async function withTimeoutValue<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function noteHeavyTeamDataWorkerFallback(operation: string): void {
  if (!app.isPackaged) {
    return;
  }

  logger.error(
    `[${operation}] team-data-worker unavailable in packaged runtime; falling back to main-thread execution for heavy message/activity path`
  );
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

/**
 * In-memory set of API error message keys already processed.
 * Independent of NotificationManager storage — survives notification deletion/pruning.
 */
const seenApiErrorKeys = new Set<string>();
const SEEN_API_ERROR_KEYS_MAX = 500;

/**
 * Check messages for rate limit indicators and fire notifications for new ones.
 * Uses both in-memory seenRateLimitKeys (to prevent resurrection after deletion)
 * and NotificationManager dedupeKey (to prevent storage duplicates).
 */
function checkRateLimitMessages(
  messages: readonly {
    messageId?: string;
    from: string;
    text: string;
    timestamp: string;
    to?: string;
    source?: string;
    leadSessionId?: string;
  }[],
  teamName: string,
  teamDisplayName: string,
  projectPath?: string,
  teamIsAlive = true,
  currentLeadSessionId: string | null = null
): void {
  const observedAt = new Date();
  const autoResumeEnabled =
    ConfigManager.getInstance().getConfig().notifications.autoResumeOnRateLimit;

  for (const msg of messages) {
    if (msg.from === 'user') continue;
    if (!isRateLimitMessage(msg.text)) continue;

    const rawKey = msg.messageId ?? `${msg.from}:${msg.timestamp}`;
    const dedupeKey = `rate-limit:${teamName}:${rawKey}`;

    // In-memory guard: prevents resurrection after user deletes the notification.
    if (!seenRateLimitKeys.has(dedupeKey)) {
      seenRateLimitKeys.add(dedupeKey);

      // Evict oldest entries to prevent unbounded growth
      if (seenRateLimitKeys.size > SEEN_RATE_LIMIT_KEYS_MAX) {
        const first = seenRateLimitKeys.values().next().value;
        if (first) seenRateLimitKeys.delete(first);
      }

      void NotificationManager.getInstance()
        .addTeamNotification({
          teamEventType: 'rate_limit',
          teamName,
          teamDisplayName,
          from: msg.from,
          summary: `Rate limit: ${msg.from}`,
          body: msg.text.slice(0, 200),
          dedupeKey,
          projectPath,
        })
        .catch(() => undefined);
    }

    // Only schedule auto-resume while a live team run currently exists.
    // Persisted history for an offline/stopped team may still contain the old
    // rate-limit message, but arming a new timer from that stale history would
    // resurrect the nudge into a later manual restart.
    const isLeadAutoResumeCandidate =
      !msg.to && (msg.source === 'lead_process' || msg.source === 'lead_session');

    if (autoResumeEnabled && teamIsAlive && isLeadAutoResumeCandidate) {
      // Only let persisted lead_session history rebuild auto-resume when it
      // clearly belongs to the currently running lead session. Otherwise an old
      // rate-limit from a previous manual run can resurrect into a newer restart.
      if (msg.source === 'lead_session') {
        if (!currentLeadSessionId) continue;
        if (msg.leadSessionId !== currentLeadSessionId) continue;
      }

      // Pass the original message timestamp so relative reset windows survive restarts
      // and old history does not rebuild a fresh auto-resume timer from "now".
      getAutoResumeService().handleRateLimitMessage(
        teamName,
        msg.text,
        observedAt,
        new Date(msg.timestamp)
      );
    }
  }
}

/**
 * Check messages for API errors (e.g. "API Error: 429 ...") and fire OS notifications.
 * Mirrors the rate-limit approach: in-memory dedup + NotificationManager dedupeKey.
 * Skips rate-limit messages (they have their own notification path).
 */
function checkApiErrorMessages(
  messages: readonly { messageId?: string; from: string; text: string; timestamp: string }[],
  teamName: string,
  teamDisplayName: string,
  projectPath?: string
): void {
  for (const msg of messages) {
    if (msg.from === 'user') continue;
    if (!isApiErrorMessage(msg.text)) continue;
    // Don't double-notify if it's also a rate limit message
    if (isRateLimitMessage(msg.text)) continue;

    const rawKey = msg.messageId ?? `${msg.from}:${msg.timestamp}`;
    const dedupeKey = `api-error:${teamName}:${rawKey}`;

    if (seenApiErrorKeys.has(dedupeKey)) continue;
    seenApiErrorKeys.add(dedupeKey);

    if (seenApiErrorKeys.size > SEEN_API_ERROR_KEYS_MAX) {
      const first = seenApiErrorKeys.values().next().value;
      if (first) seenApiErrorKeys.delete(first);
    }

    // Extract status code for summary
    const statusMatch = /^API Error:\s*(\d{3})/.exec(msg.text);
    const statusCode = statusMatch?.[1] ?? '???';

    void NotificationManager.getInstance()
      .addTeamNotification({
        teamEventType: 'rate_limit', // reuse rate_limit type — closest fit
        teamName,
        teamDisplayName,
        from: msg.from,
        summary: `API Error ${statusCode}: ${msg.from}`,
        body: msg.text.slice(0, 400),
        dedupeKey,
        projectPath,
      })
      .catch(() => undefined);
  }
}

function scanTeamMessageNotifications(
  messages: readonly { messageId?: string; from: string; text: string; timestamp: string }[],
  teamName: string,
  teamDisplayName: string,
  projectPath?: string
): void {
  if (messages.length === 0) {
    return;
  }
  checkRateLimitMessages(messages, teamName, teamDisplayName, projectPath);
  checkApiErrorMessages(messages, teamName, teamDisplayName, projectPath);
}

let teamDataService: TeamDataService | null = null;
let teamProvisioningService: TeamProvisioningService | null = null;
let teamMemberLogsFinder: TeamMemberLogsFinder | null = null;
let memberStatsComputer: MemberStatsComputer | null = null;
let teamBackupService: TeamBackupService | null = null;
let teammateToolTracker: TeammateToolTracker | null = null;
let teamLogSourceTracker: TeamLogSourceTracker | null = null;
let branchStatusService: BranchStatusService | null = null;
let boardTaskActivityService: BoardTaskActivityService | null = null;
let boardTaskActivityDetailService: BoardTaskActivityDetailService | null = null;
let boardTaskLogStreamService: BoardTaskLogStreamService | null = null;
let boardTaskExactLogsService: BoardTaskExactLogsService | null = null;
let boardTaskExactLogDetailService: BoardTaskExactLogDetailService | null = null;

const attachmentStore = new TeamAttachmentStore();
const taskAttachmentStore = new TeamTaskAttachmentStore();
const teamMetaStore = new TeamMetaStore();

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB per file

/**
 * Prevents GC from collecting Notification objects in the deprecated showTeamNativeNotification.
 * @see https://blog.bloomca.me/2025/02/22/electron-mac-notifications.html
 */
const activeTeamNotifications = new Set<Notification>();
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB total

export function initializeTeamHandlers(
  service: TeamDataService,
  provisioningService: TeamProvisioningService,
  logsFinder?: TeamMemberLogsFinder,
  statsComputer?: MemberStatsComputer,
  backupService?: TeamBackupService,
  toolTracker?: TeammateToolTracker,
  logSourceTracker?: TeamLogSourceTracker,
  branchTracker?: BranchStatusService,
  taskActivityService?: BoardTaskActivityService,
  taskActivityDetailService?: BoardTaskActivityDetailService,
  taskLogStreamService?: BoardTaskLogStreamService,
  taskExactLogsService?: BoardTaskExactLogsService,
  taskExactLogDetailService?: BoardTaskExactLogDetailService
): void {
  teamDataService = service;
  teamProvisioningService = provisioningService;
  initializeAutoResumeService(provisioningService);
  teamMemberLogsFinder = logsFinder ?? null;
  memberStatsComputer = statsComputer ?? null;
  teamBackupService = backupService ?? null;
  teammateToolTracker = toolTracker ?? null;
  teamLogSourceTracker = logSourceTracker ?? null;
  branchStatusService = branchTracker ?? null;
  boardTaskActivityService = taskActivityService ?? null;
  boardTaskActivityDetailService = taskActivityDetailService ?? null;
  boardTaskLogStreamService = taskLogStreamService ?? null;
  boardTaskExactLogsService = taskExactLogsService ?? null;
  boardTaskExactLogDetailService = taskExactLogDetailService ?? null;
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(TEAM_LIST, handleListTeams);
  ipcMain.handle(TEAM_GET_DATA, handleGetData);
  ipcMain.handle(TEAM_GET_TASK_CHANGE_PRESENCE, handleGetTaskChangePresence);
  ipcMain.handle(TEAM_SET_CHANGE_PRESENCE_TRACKING, handleSetChangePresenceTracking);
  ipcMain.handle(TEAM_SET_PROJECT_BRANCH_TRACKING, handleSetProjectBranchTracking);
  ipcMain.handle(TEAM_SET_TASK_LOG_STREAM_TRACKING, handleSetTaskLogStreamTracking);
  ipcMain.handle(TEAM_SET_TOOL_ACTIVITY_TRACKING, handleSetToolActivityTracking);
  ipcMain.handle(TEAM_GET_CLAUDE_LOGS, handleGetClaudeLogs);
  ipcMain.handle(TEAM_PREPARE_PROVISIONING, handlePrepareProvisioning);
  ipcMain.handle(TEAM_CREATE, handleCreateTeam);
  ipcMain.handle(TEAM_LAUNCH, handleLaunchTeam);
  ipcMain.handle(TEAM_PROVISIONING_STATUS, handleProvisioningStatus);
  ipcMain.handle(TEAM_CANCEL_PROVISIONING, handleCancelProvisioning);
  ipcMain.handle(TEAM_SEND_MESSAGE, handleSendMessage);
  ipcMain.handle(TEAM_GET_MESSAGES_PAGE, handleGetMessagesPage);
  ipcMain.handle(TEAM_GET_MEMBER_ACTIVITY_META, handleGetMemberActivityMeta);
  ipcMain.handle(TEAM_CREATE_TASK, handleCreateTask);
  ipcMain.handle(TEAM_REQUEST_REVIEW, handleRequestReview);
  ipcMain.handle(TEAM_UPDATE_KANBAN, handleUpdateKanban);
  ipcMain.handle(TEAM_UPDATE_KANBAN_COLUMN_ORDER, handleUpdateKanbanColumnOrder);
  ipcMain.handle(TEAM_UPDATE_TASK_STATUS, handleUpdateTaskStatus);
  ipcMain.handle(TEAM_UPDATE_TASK_OWNER, handleUpdateTaskOwner);
  ipcMain.handle(TEAM_UPDATE_TASK_FIELDS, handleUpdateTaskFields);
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
  ipcMain.handle(TEAM_GET_TASK_ACTIVITY, handleGetTaskActivity);
  ipcMain.handle(TEAM_GET_TASK_ACTIVITY_DETAIL, handleGetTaskActivityDetail);
  ipcMain.handle(TEAM_GET_TASK_LOG_STREAM_SUMMARY, handleGetTaskLogStreamSummary);
  ipcMain.handle(TEAM_GET_TASK_LOG_STREAM, handleGetTaskLogStream);
  ipcMain.handle(TEAM_GET_TASK_EXACT_LOG_SUMMARIES, handleGetTaskExactLogSummaries);
  ipcMain.handle(TEAM_GET_TASK_EXACT_LOG_DETAIL, handleGetTaskExactLogDetail);
  ipcMain.handle(TEAM_GET_MEMBER_STATS, handleGetMemberStats);
  ipcMain.handle(TEAM_UPDATE_CONFIG, handleUpdateConfig);
  ipcMain.handle(TEAM_START_TASK, handleStartTask);
  ipcMain.handle(TEAM_START_TASK_BY_USER, handleStartTaskByUser);
  ipcMain.handle(TEAM_GET_ALL_TASKS, handleGetAllTasks);
  ipcMain.handle(TEAM_ADD_TASK_COMMENT, handleAddTaskComment);
  ipcMain.handle(TEAM_ADD_MEMBER, handleAddMember);
  ipcMain.handle(TEAM_REPLACE_MEMBERS, handleReplaceMembers);
  ipcMain.handle(TEAM_REMOVE_MEMBER, handleRemoveMember);
  ipcMain.handle(TEAM_UPDATE_MEMBER_ROLE, handleUpdateMemberRole);
  ipcMain.handle(TEAM_GET_PROJECT_BRANCH, handleGetProjectBranch);
  ipcMain.handle(TEAM_GET_ATTACHMENTS, handleGetAttachments);
  ipcMain.handle(TEAM_KILL_PROCESS, handleKillProcess);
  ipcMain.handle(TEAM_LEAD_ACTIVITY, handleLeadActivity);
  ipcMain.handle(TEAM_LEAD_CONTEXT, handleLeadContext);
  ipcMain.handle(TEAM_MEMBER_SPAWN_STATUSES, handleMemberSpawnStatuses);
  ipcMain.handle(TEAM_GET_AGENT_RUNTIME, handleGetAgentRuntime);
  ipcMain.handle(TEAM_RESTART_MEMBER, handleRestartMember);
  ipcMain.handle(TEAM_SKIP_MEMBER_FOR_LAUNCH, handleSkipMemberForLaunch);
  ipcMain.handle(TEAM_SOFT_DELETE_TASK, handleSoftDeleteTask);
  ipcMain.handle(TEAM_RESTORE_TASK, handleRestoreTask);
  ipcMain.handle(TEAM_GET_DELETED_TASKS, handleGetDeletedTasks);
  ipcMain.handle(TEAM_SET_TASK_CLARIFICATION, handleSetTaskClarification);
  ipcMain.handle(TEAM_SHOW_MESSAGE_NOTIFICATION, handleShowMessageNotification);
  ipcMain.handle(TEAM_ADD_TASK_RELATIONSHIP, handleAddTaskRelationship);
  ipcMain.handle(TEAM_REMOVE_TASK_RELATIONSHIP, handleRemoveTaskRelationship);
  ipcMain.handle(TEAM_SAVE_TASK_ATTACHMENT, handleSaveTaskAttachment);
  ipcMain.handle(TEAM_GET_TASK_ATTACHMENT, handleGetTaskAttachment);
  ipcMain.handle(TEAM_DELETE_TASK_ATTACHMENT, handleDeleteTaskAttachment);
  ipcMain.handle(TEAM_TOOL_APPROVAL_RESPOND, handleToolApprovalRespond);
  ipcMain.handle(TEAM_TOOL_APPROVAL_READ_FILE, handleToolApprovalReadFile);
  ipcMain.handle(TEAM_VALIDATE_CLI_ARGS, handleValidateCliArgs);
  ipcMain.handle(TEAM_TOOL_APPROVAL_SETTINGS, handleToolApprovalSettings);
  ipcMain.handle(TEAM_GET_SAVED_REQUEST, handleGetSavedRequest);
  ipcMain.handle(TEAM_DELETE_DRAFT, handleDeleteDraft);
  logger.info('Team handlers registered');
}

export function removeTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_LIST);
  ipcMain.removeHandler(TEAM_GET_DATA);
  ipcMain.removeHandler(TEAM_GET_TASK_CHANGE_PRESENCE);
  ipcMain.removeHandler(TEAM_SET_CHANGE_PRESENCE_TRACKING);
  ipcMain.removeHandler(TEAM_SET_PROJECT_BRANCH_TRACKING);
  ipcMain.removeHandler(TEAM_SET_TASK_LOG_STREAM_TRACKING);
  ipcMain.removeHandler(TEAM_SET_TOOL_ACTIVITY_TRACKING);
  ipcMain.removeHandler(TEAM_GET_CLAUDE_LOGS);
  ipcMain.removeHandler(TEAM_PREPARE_PROVISIONING);
  ipcMain.removeHandler(TEAM_CREATE);
  ipcMain.removeHandler(TEAM_LAUNCH);
  ipcMain.removeHandler(TEAM_PROVISIONING_STATUS);
  ipcMain.removeHandler(TEAM_CANCEL_PROVISIONING);
  ipcMain.removeHandler(TEAM_SEND_MESSAGE);
  ipcMain.removeHandler(TEAM_GET_MESSAGES_PAGE);
  ipcMain.removeHandler(TEAM_GET_MEMBER_ACTIVITY_META);
  ipcMain.removeHandler(TEAM_CREATE_TASK);
  ipcMain.removeHandler(TEAM_REQUEST_REVIEW);
  ipcMain.removeHandler(TEAM_UPDATE_KANBAN);
  ipcMain.removeHandler(TEAM_UPDATE_KANBAN_COLUMN_ORDER);
  ipcMain.removeHandler(TEAM_UPDATE_TASK_STATUS);
  ipcMain.removeHandler(TEAM_UPDATE_TASK_OWNER);
  ipcMain.removeHandler(TEAM_UPDATE_TASK_FIELDS);
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
  ipcMain.removeHandler(TEAM_GET_TASK_ACTIVITY);
  ipcMain.removeHandler(TEAM_GET_TASK_ACTIVITY_DETAIL);
  ipcMain.removeHandler(TEAM_GET_TASK_LOG_STREAM_SUMMARY);
  ipcMain.removeHandler(TEAM_GET_TASK_LOG_STREAM);
  ipcMain.removeHandler(TEAM_GET_TASK_EXACT_LOG_SUMMARIES);
  ipcMain.removeHandler(TEAM_GET_TASK_EXACT_LOG_DETAIL);
  ipcMain.removeHandler(TEAM_GET_MEMBER_STATS);
  ipcMain.removeHandler(TEAM_UPDATE_CONFIG);
  ipcMain.removeHandler(TEAM_START_TASK);
  ipcMain.removeHandler(TEAM_START_TASK_BY_USER);
  ipcMain.removeHandler(TEAM_GET_ALL_TASKS);
  ipcMain.removeHandler(TEAM_ADD_TASK_COMMENT);
  ipcMain.removeHandler(TEAM_ADD_MEMBER);
  ipcMain.removeHandler(TEAM_REPLACE_MEMBERS);
  ipcMain.removeHandler(TEAM_REMOVE_MEMBER);
  ipcMain.removeHandler(TEAM_UPDATE_MEMBER_ROLE);
  ipcMain.removeHandler(TEAM_GET_PROJECT_BRANCH);
  ipcMain.removeHandler(TEAM_GET_ATTACHMENTS);
  ipcMain.removeHandler(TEAM_KILL_PROCESS);
  ipcMain.removeHandler(TEAM_LEAD_ACTIVITY);
  ipcMain.removeHandler(TEAM_LEAD_CONTEXT);
  ipcMain.removeHandler(TEAM_MEMBER_SPAWN_STATUSES);
  ipcMain.removeHandler(TEAM_GET_AGENT_RUNTIME);
  ipcMain.removeHandler(TEAM_RESTART_MEMBER);
  ipcMain.removeHandler(TEAM_SKIP_MEMBER_FOR_LAUNCH);
  ipcMain.removeHandler(TEAM_SOFT_DELETE_TASK);
  ipcMain.removeHandler(TEAM_RESTORE_TASK);
  ipcMain.removeHandler(TEAM_GET_DELETED_TASKS);
  ipcMain.removeHandler(TEAM_SET_TASK_CLARIFICATION);
  ipcMain.removeHandler(TEAM_SHOW_MESSAGE_NOTIFICATION);
  ipcMain.removeHandler(TEAM_ADD_TASK_RELATIONSHIP);
  ipcMain.removeHandler(TEAM_REMOVE_TASK_RELATIONSHIP);
  ipcMain.removeHandler(TEAM_SAVE_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_GET_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_DELETE_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_TOOL_APPROVAL_RESPOND);
  ipcMain.removeHandler(TEAM_TOOL_APPROVAL_READ_FILE);
  ipcMain.removeHandler(TEAM_VALIDATE_CLI_ARGS);
  ipcMain.removeHandler(TEAM_TOOL_APPROVAL_SETTINGS);
  ipcMain.removeHandler(TEAM_GET_SAVED_REQUEST);
  ipcMain.removeHandler(TEAM_DELETE_DRAFT);
}

function getTeamDataService(): TeamDataService {
  if (!teamDataService) {
    throw new Error('Team handlers are not initialized');
  }
  return teamDataService;
}

function getTeamProvisioningService(): TeamProvisioningService {
  if (!teamProvisioningService) {
    throw new Error('Team provisioning handlers are not initialized');
  }
  return teamProvisioningService;
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

function getBoardTaskActivityService(): BoardTaskActivityService {
  if (!boardTaskActivityService) {
    throw new Error('Board task activity service is not initialized');
  }
  return boardTaskActivityService;
}

function getBoardTaskActivityDetailService(): BoardTaskActivityDetailService {
  if (!boardTaskActivityDetailService) {
    throw new Error('Board task activity detail service is not initialized');
  }
  return boardTaskActivityDetailService;
}

function getBoardTaskLogStreamService(): BoardTaskLogStreamService {
  if (!boardTaskLogStreamService) {
    throw new Error('Board task log stream service is not initialized');
  }
  return boardTaskLogStreamService;
}

function getBoardTaskExactLogsService(): BoardTaskExactLogsService {
  if (!boardTaskExactLogsService) {
    throw new Error('Board task exact logs service is not initialized');
  }
  return boardTaskExactLogsService;
}

function getBoardTaskExactLogDetailService(): BoardTaskExactLogDetailService {
  if (!boardTaskExactLogDetailService) {
    throw new Error('Board task exact log detail service is not initialized');
  }
  return boardTaskExactLogDetailService;
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

async function handleListTeams(_event: IpcMainInvokeEvent): Promise<IpcResult<TeamSummary[]>> {
  setCurrentMainOp('team:list');
  const startedAt = Date.now();
  try {
    return await wrapTeamHandler('list', () => getTeamDataService().listTeams());
  } finally {
    const ms = Date.now() - startedAt;
    if (ms >= 1500) {
      logger.warn(`[teams:list] slow ms=${ms}`);
    }
    setCurrentMainOp(null);
  }
}

async function handleGetData(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<TeamViewSnapshot>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  const tn = validated.value!;
  const startedAt = Date.now();
  let data: TeamViewSnapshot;
  setCurrentMainOp('team:getData');
  try {
    // Prefer worker thread to keep main event loop responsive
    const worker = getTeamDataWorkerClient();
    if (worker.isAvailable()) {
      try {
        data = await worker.getTeamData(tn);
      } catch (workerErr) {
        logger.warn(
          `[teams:getData] worker failed, falling back: ${workerErr instanceof Error ? workerErr.message : workerErr}`
        );
        noteHeavyTeamDataWorkerFallback('teams:getData');
        data = await getTeamDataService().getTeamData(tn);
      }
    } else {
      noteHeavyTeamDataWorkerFallback('teams:getData');
      data = await getTeamDataService().getTeamData(tn);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === `Team not found: ${tn}` &&
      getTeamProvisioningService().hasProvisioningRun(tn)
    ) {
      return { success: false, error: 'TEAM_PROVISIONING' };
    }
    // Draft team: team.meta.json exists but config.json doesn't (provisioning failed before TeamCreate)
    if (message === `Team not found: ${tn}`) {
      const meta = await teamMetaStore.getMeta(tn);
      if (meta) {
        return { success: false, error: 'TEAM_DRAFT' };
      }
    }
    logger.error(`[teams:getData] ${message}`);
    return { success: false, error: message };
  } finally {
    setCurrentMainOp(null);
  }
  const getDataMs = Date.now() - startedAt;

  if (getDataMs >= 1500) {
    logger.warn(`[teams:getData] slow team=${tn} ms=${getDataMs}`);
  }
  const teamDataService = getTeamDataService();
  if (data.processes.some((process) => !process.stoppedAt)) {
    teamDataService.trackProcessHealthForTeam?.(tn);
  } else {
    teamDataService.untrackProcessHealthForTeam?.(tn);
  }
  const provisioning = getTeamProvisioningService();
  const isAlive = provisioning.isTeamAlive(tn);
  const currentLeadSessionId = provisioning.getCurrentLeadSessionId(tn);

  const displayName = data.config.name || tn;
  const projectPath = data.config.projectPath;
  const live = provisioning.getLiveLeadProcessMessages(tn);
  const durableMessages = Array.isArray((data as { messages?: unknown }).messages)
    ? ((data as { messages?: typeof live }).messages ?? [])
    : [];

  if (live.length === 0) {
    if (durableMessages.length > 0) {
      checkRateLimitMessages(
        durableMessages,
        tn,
        displayName,
        projectPath,
        isAlive,
        currentLeadSessionId
      );
      checkApiErrorMessages(durableMessages, tn, displayName, projectPath);
    } else {
      scanTeamMessageNotifications(live, tn, displayName, projectPath);
    }
    return { success: true, data: { ...data, isAlive } };
  }

  let merged = mergeLiveLeadProcessMessages(durableMessages, live);
  if (durableMessages.length >= 50) {
    try {
      const newestPage = await teamDataService.getMessagesPage(tn, {
        limit: 50,
        liveMessages: live,
      });
      merged = newestPage.messages;
    } catch (error) {
      logger.warn(
        `[teams:getData] failed to rebuild newest merged messages for ${tn}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  checkRateLimitMessages(merged, tn, displayName, projectPath, isAlive, currentLeadSessionId);
  checkApiErrorMessages(merged, tn, displayName, projectPath);
  return { success: true, data: { ...data, isAlive } };
}

async function handleGetTaskChangePresence(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<Record<string, TaskChangePresenceState>>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }

  return wrapTeamHandler('getTaskChangePresence', () =>
    getTeamDataService().getTaskChangePresence(validated.value!)
  );
}

async function handleSetChangePresenceTracking(
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

  return wrapTeamHandler('setChangePresenceTracking', async () => {
    getTeamDataService().setTaskChangePresenceTracking(validated.value!, enabled);
  });
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
    getAutoResumeService().cancelPendingAutoResume(validated.value!);
    await getTeamProvisioningService().stopTeam(validated.value!);
    await getTeamDataService().deleteTeam(validated.value!);
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
  return wrapTeamHandler('restoreTeam', () => getTeamDataService().restoreTeam(validated.value!));
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
    getAutoResumeService().cancelPendingAutoResume(validated.value!);
    await getTeamDataService().permanentlyDeleteTeam(validated.value!);
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
      const provisioning = getTeamProvisioningService();
      if (provisioning.isTeamAlive(tn)) {
        const msg = `The team has been renamed to "${requestedName}". Please use this name when referring to the team going forward.`;
        try {
          await provisioning.sendMessageToTeam(tn, msg);
        } catch {
          logger.warn(`Failed to notify lead about team rename for ${tn}`);
        }
      }
    }

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

function parseOptionalMemberProviderId(
  value: unknown
): { valid: true; value: TeamProviderId | undefined } | { valid: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: undefined };
  }
  if (isTeamProviderId(value)) {
    return { valid: true, value };
  }
  return { valid: false, error: 'member providerId must be anthropic, codex, gemini, or opencode' };
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
    error: 'providerBackendId must be one of auto, adapter, api, cli-sdk, or codex-native',
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
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
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
    previous.fastMode !== next.fastMode
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
        `Failed to restore exact live OpenCode roster metadata for ${teamName}: ${
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
      `Failed to roll back fallback live OpenCode roster metadata for ${teamName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

async function rollbackOpenCodeLiveRosterMutation(options: {
  teamName: string;
  teamDataService: TeamDataService;
  provisioning: TeamProvisioningService;
  previousMembers: RuntimeRosterMutationMember[];
  previousMembersMeta: TeamMembersMetaFile | null;
  restoreOpenCodeMemberNames?: string[];
  detachOpenCodeMemberNames?: string[];
}): Promise<void> {
  const {
    teamName,
    teamDataService,
    provisioning,
    previousMembers,
    previousMembersMeta,
    restoreOpenCodeMemberNames = [],
    detachOpenCodeMemberNames = [],
  } = options;

  const metadataRestored = await restorePreviousMembersMetaSnapshot({
    teamName,
    teamDataService,
    previousMembers,
    previousMembersMeta,
  });

  const detachNames = Array.from(
    new Set(detachOpenCodeMemberNames.map((memberName) => memberName.trim()).filter(Boolean))
  );
  for (const memberName of detachNames) {
    try {
      await provisioning.detachOpenCodeOwnedMemberLane(teamName, memberName);
    } catch (error) {
      logger.warn(
        `Failed to clean up OpenCode lane for ${teamName}/${memberName} during rollback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (!metadataRestored) {
    return;
  }

  const restoreNames = Array.from(
    new Set(restoreOpenCodeMemberNames.map((memberName) => memberName.trim()).filter(Boolean))
  );
  for (const memberName of restoreNames) {
    try {
      await provisioning.reattachOpenCodeOwnedMemberLane(teamName, memberName, {
        reason: 'member_updated',
      });
    } catch (error) {
      logger.warn(
        `Failed to restore OpenCode lane for ${teamName}/${memberName} during rollback: ${
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
  const explicitProviderId =
    payload.providerId === 'codex'
      ? 'codex'
      : payload.providerId === 'gemini'
        ? 'gemini'
        : payload.providerId === 'anthropic'
          ? 'anthropic'
          : undefined;
  const providerId = explicitProviderId ?? 'anthropic';

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
    members.push({
      name: memberName,
      role: typeof role === 'string' ? role.trim() : undefined,
      workflow: typeof workflow === 'string' ? workflow.trim() : undefined,
      isolation: isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: providerValidation.value,
      model: typeof model === 'string' ? model.trim() || undefined : undefined,
      effort: effortValidation.value,
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
  const providerBackendValidation = parseOptionalProviderBackendId(
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
    const data = await getTeamProvisioningService().getClaudeLogs(validated.value!, parsed);
    return {
      lines: data.lines,
      total: data.total,
      hasMore: data.hasMore,
      updatedAt: data.updatedAt,
    };
  });
}

async function handleCreateTeam(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<IpcResult<TeamCreateResponse>> {
  const validation = await validateProvisioningRequest(request);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return wrapTeamHandler('create', () => {
    addMainBreadcrumb('team', 'create', { teamName: validation.value.teamName });
    return getTeamProvisioningService().createTeam(validation.value, (progress) => {
      try {
        event.sender.send(TEAM_PROVISIONING_PROGRESS, progress);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to emit provisioning progress: ${message}`);
      }
    });
  });
}

async function handleLaunchTeam(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<IpcResult<TeamLaunchResponse>> {
  if (!request || typeof request !== 'object') {
    return { success: false, error: 'Invalid team launch request' };
  }

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
  const explicitProviderId =
    payload.providerId === 'codex'
      ? 'codex'
      : payload.providerId === 'gemini'
        ? 'gemini'
        : payload.providerId === 'anthropic'
          ? 'anthropic'
          : undefined;
  const providerId = explicitProviderId ?? 'anthropic';
  const providerBackendValidation = parseOptionalProviderBackendId(
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
    const meta = await teamMetaStore.getMeta(tn);
    const membersStore = new TeamMembersMetaStore();
    const membersMeta = await membersStore.getMeta(tn);
    const members = membersMeta?.members ?? [];

    const resolvedProviderId =
      providerId === 'codex' || providerId === 'gemini'
        ? providerId
        : meta?.providerId === 'codex'
          ? 'codex'
          : meta?.providerId === 'gemini'
            ? 'gemini'
            : 'anthropic';
    const effortValidation = parseOptionalTeamEffort(payload.effort, resolvedProviderId);
    if (!effortValidation.valid) {
      return { success: false, error: effortValidation.error };
    }
    const fastModeValidation = parseOptionalTeamFastMode(payload.fastMode);
    if (!fastModeValidation.valid) {
      return { success: false, error: fastModeValidation.error };
    }

    const createRequest: TeamCreateRequest = {
      teamName: tn,
      displayName: meta?.displayName,
      description: meta?.description,
      color: meta?.color,
      cwd,
      prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
      providerId: resolvedProviderId,
      providerBackendId: migrateProviderBackendId(
        resolvedProviderId,
        providerBackendValidation.value ?? meta?.providerBackendId ?? membersMeta?.providerBackendId
      ),
      model: typeof payload.model === 'string' ? payload.model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value ?? meta?.fastMode,
      limitContext: typeof payload.limitContext === 'boolean' ? payload.limitContext : undefined,
      skipPermissions:
        typeof payload.skipPermissions === 'boolean' ? payload.skipPermissions : undefined,
      worktree:
        typeof payload.worktree === 'string' ? payload.worktree.trim() || undefined : undefined,
      extraCliArgs:
        typeof payload.extraCliArgs === 'string'
          ? payload.extraCliArgs.trim() || undefined
          : undefined,
      members: members.map((m) => ({
        name: m.name,
        role: m.role,
        workflow: m.workflow,
        isolation: m.isolation,
        providerId: m.providerId,
        model: m.model,
        effort: m.effort,
      })),
    };

    return wrapTeamHandler('create', () =>
      getTeamProvisioningService().createTeam(createRequest, (progress) => {
        try {
          event.sender.send(TEAM_PROVISIONING_PROGRESS, progress);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to emit draft launch provisioning progress: ${message}`);
        }
      })
    );
  }

  const persistedMeta = await teamMetaStore.getMeta(tn).catch(() => null);
  const launchProviderId = explicitProviderId ?? persistedMeta?.providerId ?? providerId;
  const rawLaunchProviderBackendId =
    payload.providerBackendId ??
    persistedMeta?.providerBackendId ??
    persistedMeta?.launchIdentity?.providerBackendId ??
    undefined;
  const launchProviderBackendValidation = parseOptionalProviderBackendId(
    rawLaunchProviderBackendId,
    launchProviderId
  );
  if (!launchProviderBackendValidation.valid) {
    return { success: false, error: launchProviderBackendValidation.error };
  }
  const rawLaunchEffort =
    payload.effort ??
    persistedMeta?.effort ??
    persistedMeta?.launchIdentity?.selectedEffort ??
    undefined;
  const effortValidation = parseOptionalTeamEffort(rawLaunchEffort, launchProviderId);
  if (!effortValidation.valid) {
    return { success: false, error: effortValidation.error };
  }
  const rawLaunchFastMode =
    payload.fastMode ??
    persistedMeta?.fastMode ??
    persistedMeta?.launchIdentity?.selectedFastMode ??
    undefined;
  const fastModeValidation = parseOptionalTeamFastMode(rawLaunchFastMode);
  if (!fastModeValidation.valid) {
    return { success: false, error: fastModeValidation.error };
  }
  const rawLaunchModel =
    typeof payload.model === 'string' && payload.model.trim().length > 0
      ? payload.model.trim()
      : (persistedMeta?.model ?? persistedMeta?.launchIdentity?.selectedModel ?? undefined);
  const launchLimitContext =
    typeof payload.limitContext === 'boolean' ? payload.limitContext : persistedMeta?.limitContext;

  return wrapTeamHandler('launch', () => {
    addMainBreadcrumb('team', 'launch', { teamName: validatedTeamName.value! });
    return getTeamProvisioningService().launchTeam(
      {
        teamName: validatedTeamName.value!,
        cwd,
        prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
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
        try {
          event.sender.send(TEAM_PROVISIONING_PROGRESS, progress);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to emit launch provisioning progress: ${message}`);
        }
      }
    );
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
    const helpOutput = await getTeamProvisioningService().getCliHelpOutput();
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
  modelVerificationMode: unknown
): Promise<IpcResult<TeamProvisioningPrepareResult>> {
  let validatedCwd: string | undefined;
  let validatedProviderId: TeamLaunchRequest['providerId'];
  let validatedProviderIds: TeamProviderId[] | undefined;
  let validatedSelectedModels: string[] | undefined;
  let validatedLimitContext: boolean | undefined;
  let validatedModelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
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
    const normalized = Array.from(
      new Set(
        selectedModels
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      )
    );
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
  return wrapTeamHandler('prepareProvisioning', () =>
    getTeamProvisioningService().prepareForProvisioning(validatedCwd, {
      providerId: validatedProviderId,
      providerIds: validatedProviderIds,
      modelIds: validatedSelectedModels,
      limitContext: validatedLimitContext,
      modelVerificationMode: validatedModelVerificationMode,
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
    getTeamProvisioningService().getProvisioningStatus(runId.trim())
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
    getTeamProvisioningService().cancelProvisioning(runId.trim())
  );
}

function isUpdateKanbanPatch(value: unknown): value is UpdateKanbanPatch {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const patch = value as Partial<UpdateKanbanPatch> & { op?: unknown; column?: unknown };
  if (patch.op === 'remove') {
    return true;
  }

  if (patch.op === 'request_changes') {
    return (
      (patch.comment === undefined || typeof patch.comment === 'string') &&
      validateTaskRefs((patch as { taskRefs?: unknown }).taskRefs).valid
    );
  }

  return patch.op === 'set_column' && (patch.column === 'review' || patch.column === 'approved');
}

function validateTaskRefs(
  value: unknown
): { valid: true; value: TaskRef[] | undefined } | { valid: false; error: string } {
  if (value === undefined) {
    return { valid: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return { valid: false, error: 'taskRefs must be an array' };
  }

  const taskRefs: TaskRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return { valid: false, error: 'taskRefs entries must be objects' };
    }
    const row = entry as Partial<TaskRef>;
    const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
    const displayId = typeof row.displayId === 'string' ? row.displayId.trim() : '';
    const teamName = typeof row.teamName === 'string' ? row.teamName.trim() : '';
    if (!taskId || !displayId || !teamName) {
      return { valid: false, error: 'Each taskRef must include taskId, displayId, and teamName' };
    }
    const validatedTaskId = validateTaskId(taskId);
    if (!validatedTaskId.valid) {
      return { valid: false, error: validatedTaskId.error ?? 'Invalid taskRef taskId' };
    }
    const validatedTeamName = validateTeamName(teamName);
    if (!validatedTeamName.valid) {
      return { valid: false, error: validatedTeamName.error ?? 'Invalid taskRef teamName' };
    }
    taskRefs.push({
      taskId: validatedTaskId.value!,
      displayId,
      teamName: validatedTeamName.value!,
    });
  }

  return { valid: true, value: taskRefs };
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

function buildMessageDeliveryText(
  baseText: string,
  opts: {
    actionMode?: AgentActionMode;
    isLeadRecipient: boolean;
    replyRecipient?: string;
  }
): string {
  const hiddenBlocks: string[] = [];
  const actionModeBlock = buildActionModeAgentBlock(opts.actionMode);
  if (actionModeBlock) {
    hiddenBlocks.push(actionModeBlock);
  }
  if (!opts.isLeadRecipient) {
    const replyRecipient =
      typeof opts.replyRecipient === 'string' && opts.replyRecipient.trim().length > 0
        ? opts.replyRecipient.trim()
        : 'user';
    const senderDescriptor = replyRecipient === 'user' ? 'the human user' : `"${replyRecipient}"`;
    hiddenBlocks.push(
      [
        AGENT_BLOCK_OPEN,
        `You received a direct message from ${senderDescriptor} via the UI.`,
        'CRITICAL: Reply using the SendMessage tool, not plain assistant text.',
        `CRITICAL: The destination must be exactly to="${replyRecipient}".`,
        'CRITICAL: The SendMessage tool input must use the exact field names `to`, `summary`, and `message`.',
        'Do NOT answer only with normal assistant text because that will not appear in the UI message thread.',
        `Please reply back to recipient "${replyRecipient}" with a short, human-readable answer.`,
        'If you cannot respond now, reply with a brief status (e.g. "Busy, will reply later").',
        ...(replyRecipient === 'user'
          ? [
              'CRITICAL: If the user asks you to check with the lead or another teammate before you can fully answer, FIRST send a short acknowledgement to "user" so the human sees you started (for example: "Принял, сейчас уточню и вернусь с ответом.").',
              'Only after that first acknowledgement may you message the lead or another teammate.',
              'After you get the needed information, send the final answer back to "user".',
              'Do NOT stay silent while you go ask someone else.',
            ]
          : []),
        AGENT_BLOCK_CLOSE,
      ].join('\n')
    );
  }

  if (hiddenBlocks.length === 0) {
    return baseText;
  }

  return [...hiddenBlocks, baseText].join('\n\n');
}

async function handleGetMessagesPage(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  options: unknown
): Promise<IpcResult<MessagesPage>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const opts = (options && typeof options === 'object' ? options : {}) as {
    cursor?: string | null;
    limit?: number;
  };
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const cursor =
    typeof opts.cursor === 'string' ? opts.cursor : opts.cursor === null ? null : undefined;

  return wrapTeamHandler('getMessagesPage', async () => {
    let page: MessagesPage;
    const notificationContext = await getTeamDataService().getTeamNotificationContext(vTeam.value!);
    const liveMessages =
      cursor == null ? getTeamProvisioningService().getLiveLeadProcessMessages(vTeam.value!) : [];

    if (liveMessages.length > 0) {
      page = await getTeamDataService().getMessagesPage(vTeam.value!, {
        cursor,
        limit,
        liveMessages,
      });
      scanTeamMessageNotifications(
        page.messages,
        vTeam.value!,
        notificationContext.displayName,
        notificationContext.projectPath
      );
      return page;
    }

    const worker = getTeamDataWorkerClient();
    if (worker.isAvailable()) {
      try {
        page = await worker.getMessagesPage(vTeam.value!, { cursor, limit });
        scanTeamMessageNotifications(
          page.messages,
          vTeam.value!,
          notificationContext.displayName,
          notificationContext.projectPath
        );
        return page;
      } catch (workerErr) {
        logger.warn(
          `[teams:getMessagesPage] worker failed, falling back: ${
            workerErr instanceof Error ? workerErr.message : workerErr
          }`
        );
      }
    }
    noteHeavyTeamDataWorkerFallback('teams:getMessagesPage');
    page = await getTeamDataService().getMessagesPage(vTeam.value!, { cursor, limit });
    scanTeamMessageNotifications(
      page.messages,
      vTeam.value!,
      notificationContext.displayName,
      notificationContext.projectPath
    );
    return page;
  });
}

async function handleGetMemberActivityMeta(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<TeamMemberActivityMeta>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }

  return wrapTeamHandler('getMemberActivityMeta', async () => {
    const worker = getTeamDataWorkerClient();
    if (worker.isAvailable()) {
      try {
        return await worker.getMemberActivityMeta(vTeam.value!);
      } catch (workerErr) {
        logger.warn(
          `[teams:getMemberActivityMeta] worker failed, falling back: ${
            workerErr instanceof Error ? workerErr.message : workerErr
          }`
        );
      }
    }
    noteHeavyTeamDataWorkerFallback('teams:getMemberActivityMeta');
    return getTeamDataService().getMemberActivityMeta(vTeam.value!);
  });
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
    const provisioning = getTeamProvisioningService();
    const isAlive = provisioning.isTeamAlive(tn);

    const leadName =
      prevalidatedLeadName !== undefined
        ? prevalidatedLeadName
        : await getTeamDataService().getLeadMemberName(tn);
    const isLeadRecipient =
      prevalidatedIsLeadRecipient !== undefined
        ? prevalidatedIsLeadRecipient
        : leadName !== null && memberName === leadName;
    const actionMode = payload.actionMode;

    // Attachments only supported for live lead (stdin content blocks)
    if (validatedAttachments?.length && (!isLeadRecipient || !isAlive)) {
      throw new Error(
        'Attachments are only supported when sending to the team lead while the team is online'
      );
    }

    // Smart routing: lead + alive → stdin direct, else → inbox
    if (isLeadRecipient && isAlive) {
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
            AGENT_BLOCK_OPEN,
            `MessageId: ${preGeneratedMessageId}`,
            `When creating a task from this user message, prefer task_create_from_message with messageId="${preGeneratedMessageId}" for reliable provenance. Only use this exact messageId — never guess or fabricate one.`,
            AGENT_BLOCK_CLOSE,
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
        await provisioning.sendMessageToTeam(
          tn,
          stdinTextForLead,
          rawSlashCommandText ? undefined : validatedAttachments
        );
        stdinSent = true;
      } catch (stdinError: unknown) {
        // Stdin failed (process died between check and write)
        // If attachments were requested, fail rather than silently dropping them
        if (validatedAttachments?.length) {
          throw new Error(
            'Failed to deliver message with attachments: team process became unavailable'
          );
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

        provisioning.pushLiveLeadProcessMessage(tn, {
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

    // Inbox path: offline lead or regular members (no attachment support)
    const baseText = payload.text!.trim();
    const replyRecipient =
      typeof payload.from === 'string' && payload.from.trim().length > 0
        ? payload.from.trim()
        : 'user';
    const isOpenCodeRecipient =
      !isLeadRecipient && (await provisioning.isOpenCodeRuntimeRecipient(tn, memberName));
    const memberDeliveryText = buildMessageDeliveryText(baseText, {
      actionMode,
      isLeadRecipient,
      replyRecipient,
    });
    const inboxText = isOpenCodeRecipient ? baseText : memberDeliveryText;
    const result = await getTeamDataService().sendMessage(tn, {
      member: memberName,
      text: inboxText,
      summary: payload.summary,
      from: payload.from,
      actionMode,
      source: 'user_sent',
      taskRefs: validatedTaskRefs.value,
    });

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
        const relay = await withTimeoutValue(
          provisioning.relayOpenCodeMemberInboxMessages(tn, memberName, {
            onlyMessageId: result.messageId,
            source: 'ui-send',
            deliveryMetadata: {
              replyRecipient,
              actionMode,
              taskRefs: validatedTaskRefs.value,
            },
          }),
          OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS,
          {
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
              reason: 'opencode_runtime_delivery_ui_timeout_pending',
              diagnostics: ['opencode_runtime_delivery_ui_timeout_pending'],
            },
          }
        );
        const delivery = relay.lastDelivery ?? {
          delivered: relay.relayed > 0,
          reason: relay.relayed > 0 ? undefined : 'opencode_message_delivery_not_attempted',
          diagnostics: undefined,
        };
        result.runtimeDelivery = {
          providerId: 'opencode',
          attempted: true,
          delivered: delivery.delivered,
          responsePending: delivery.responsePending,
          acceptanceUnknown: delivery.acceptanceUnknown,
          responseState: delivery.responseState,
          ledgerStatus: delivery.ledgerStatus,
          visibleReplyMessageId: delivery.visibleReplyMessageId,
          visibleReplyCorrelation: delivery.visibleReplyCorrelation,
          reason: delivery.reason,
          diagnostics: delivery.diagnostics,
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
        };
        logger.warn(
          `OpenCode runtime delivery after sendMessage crashed for teammate "${memberName}": ${reason}`
        );
      }
    }

    // Best-effort relay for lead via inbox
    if (isLeadRecipient && isAlive) {
      void provisioning
        .relayLeadInboxMessages(tn)
        .catch((e: unknown) =>
          logger.warn(`Relay after sendMessage failed for ${tn}: ${String(e)}`)
        );
    }

    return result;
  });
}

async function handleCreateTask(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  request: unknown
): Promise<IpcResult<TeamTask>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  if (!request || typeof request !== 'object') {
    return { success: false, error: 'Invalid create task request' };
  }

  const payload = request as Partial<CreateTaskRequest>;
  if (typeof payload.subject !== 'string' || payload.subject.trim().length === 0) {
    return { success: false, error: 'subject must be a non-empty string' };
  }
  if (payload.subject.trim().length > 500) {
    return { success: false, error: 'subject exceeds max length (500)' };
  }
  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return { success: false, error: 'description must be string' };
  }
  const validatedDescriptionTaskRefs = validateTaskRefs(payload.descriptionTaskRefs);
  if (!validatedDescriptionTaskRefs.valid) {
    return { success: false, error: validatedDescriptionTaskRefs.error };
  }
  if (payload.owner !== undefined) {
    const validatedOwner = validateMemberName(payload.owner);
    if (!validatedOwner.valid) {
      return { success: false, error: validatedOwner.error ?? 'Invalid owner' };
    }
  }
  if (payload.blockedBy !== undefined) {
    if (
      !Array.isArray(payload.blockedBy) ||
      payload.blockedBy.some((id) => typeof id !== 'string')
    ) {
      return { success: false, error: 'blockedBy must be an array of task ID strings' };
    }
  }
  if (payload.related !== undefined) {
    if (!Array.isArray(payload.related) || payload.related.some((id) => typeof id !== 'string')) {
      return { success: false, error: 'related must be an array of task ID strings' };
    }
    for (const id of payload.related) {
      const validated = validateTaskId(id);
      if (!validated.valid) {
        return { success: false, error: validated.error ?? 'Invalid related task id' };
      }
    }
  }
  if (payload.prompt !== undefined) {
    if (typeof payload.prompt !== 'string') {
      return { success: false, error: 'prompt must be a string' };
    }
    if (payload.prompt.length > 5000) {
      return { success: false, error: 'prompt exceeds max length (5000)' };
    }
  }
  const validatedPromptTaskRefs = validateTaskRefs(payload.promptTaskRefs);
  if (!validatedPromptTaskRefs.valid) {
    return { success: false, error: validatedPromptTaskRefs.error };
  }
  if (payload.startImmediately !== undefined && typeof payload.startImmediately !== 'boolean') {
    return { success: false, error: 'startImmediately must be a boolean' };
  }

  return wrapTeamHandler('createTask', () =>
    getTeamDataService().createTask(validatedTeamName.value!, {
      subject: payload.subject!.trim(),
      description: payload.description?.trim(),
      owner: payload.owner?.trim() || undefined,
      blockedBy: payload.blockedBy,
      related: payload.related,
      descriptionTaskRefs: validatedDescriptionTaskRefs.value,
      prompt: payload.prompt?.trim() || undefined,
      promptTaskRefs: validatedPromptTaskRefs.value,
      startImmediately: payload.startImmediately,
    })
  );
}

async function handleRequestReview(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }

  return wrapTeamHandler('requestReview', () =>
    getTeamDataService().requestReview(validatedTeamName.value!, validatedTaskId.value!)
  );
}

async function handleUpdateKanban(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  patch: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }

  if (!isUpdateKanbanPatch(patch)) {
    return { success: false, error: 'Invalid kanban patch' };
  }

  return wrapTeamHandler('updateKanban', async () => {
    await getTeamDataService().updateKanban(
      validatedTeamName.value!,
      validatedTaskId.value!,
      patch
    );
  });
}

function validateKanbanColumnId(
  value: unknown
): { valid: true; value: KanbanColumnId } | { valid: false; error: string } {
  if (typeof value !== 'string' || !KANBAN_COLUMN_IDS.includes(value as KanbanColumnId)) {
    return { valid: false, error: `columnId must be one of: ${KANBAN_COLUMN_IDS.join(', ')}` };
  }
  return { valid: true, value: value as KanbanColumnId };
}

async function handleUpdateKanbanColumnOrder(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  columnId: unknown,
  orderedTaskIds: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  const validatedColumnId = validateKanbanColumnId(columnId);
  if (!validatedColumnId.valid) {
    return { success: false, error: validatedColumnId.error ?? 'Invalid columnId' };
  }
  if (!Array.isArray(orderedTaskIds)) {
    return { success: false, error: 'orderedTaskIds must be an array' };
  }
  const ids = orderedTaskIds.filter((id): id is string => typeof id === 'string');
  return wrapTeamHandler('updateKanbanColumnOrder', () =>
    getTeamDataService().updateKanbanColumnOrder(
      validatedTeamName.value!,
      validatedColumnId.value,
      ids
    )
  );
}

const VALID_TASK_STATUSES: TeamTaskStatus[] = ['pending', 'in_progress', 'completed'];

async function handleUpdateTaskStatus(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  status: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }

  if (typeof status !== 'string' || !VALID_TASK_STATUSES.includes(status as TeamTaskStatus)) {
    return { success: false, error: `status must be one of: ${VALID_TASK_STATUSES.join(', ')}` };
  }

  return wrapTeamHandler('updateTaskStatus', () =>
    getTeamDataService().updateTaskStatus(
      validatedTeamName.value!,
      validatedTaskId.value!,
      status as TeamTaskStatus
    )
  );
}

async function handleSoftDeleteTask(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }

  return wrapTeamHandler('softDeleteTask', () =>
    getTeamDataService().softDeleteTask(validatedTeamName.value!, validatedTaskId.value!)
  );
}

async function handleRestoreTask(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }

  return wrapTeamHandler('restoreTask', () =>
    getTeamDataService().restoreTask(validatedTeamName.value!, validatedTaskId.value!)
  );
}

async function handleGetDeletedTasks(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<TeamTask[]>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  return wrapTeamHandler('getDeletedTasks', () =>
    getTeamDataService().getDeletedTasks(validatedTeamName.value!)
  );
}

const VALID_CLARIFICATION_VALUES = ['lead', 'user'] as const;

async function handleSetTaskClarification(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  value: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }

  if (
    value !== null &&
    (typeof value !== 'string' || !VALID_CLARIFICATION_VALUES.includes(value as 'lead' | 'user'))
  ) {
    return {
      success: false,
      error: `value must be "lead", "user", or null`,
    };
  }

  return wrapTeamHandler('setTaskClarification', () =>
    getTeamDataService().setTaskNeedsClarification(
      validatedTeamName.value!,
      validatedTaskId.value!,
      value as 'lead' | 'user' | null
    )
  );
}

async function handleUpdateTaskOwner(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  owner: unknown
): Promise<IpcResult<void>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }

  let nextOwner: string | null = null;
  if (owner !== null) {
    const validatedOwner = validateMemberName(owner);
    if (!validatedOwner.valid) {
      return { success: false, error: validatedOwner.error ?? 'Invalid owner' };
    }
    nextOwner = validatedOwner.value!;
  }

  return wrapTeamHandler('updateTaskOwner', () =>
    getTeamDataService().updateTaskOwner(
      validatedTeamName.value!,
      validatedTaskId.value!,
      nextOwner
    )
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
    getTeamProvisioningService().sendMessageToTeam(validatedTeamName.value!, message)
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
    getTeamProvisioningService().isTeamAlive(validatedTeamName.value!)
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
  const providerBackendValidation = parseOptionalProviderBackendId(payload.providerBackendId);
  if (!providerBackendValidation.valid) {
    return { success: false, error: providerBackendValidation.error };
  }
  const fastModeValidation = parseOptionalTeamFastMode(payload.fastMode);
  if (!fastModeValidation.valid) {
    return { success: false, error: fastModeValidation.error };
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
    const model = (member as { model?: unknown }).model;
    if (model !== undefined && typeof model !== 'string') {
      return { success: false, error: 'member model must be string' };
    }
    const effortValidation = parseOptionalMemberEffort(
      (member as { effort?: unknown }).effort,
      providerValidation.value
    );
    if (!effortValidation.valid) {
      return { success: false, error: effortValidation.error };
    }
    members.push({
      name: memberName,
      role: typeof role === 'string' ? role.trim() : undefined,
      workflow: typeof workflow === 'string' ? workflow.trim() : undefined,
      isolation: isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: providerValidation.value,
      model: typeof model === 'string' ? model.trim() || undefined : undefined,
      effort: effortValidation.value,
    });
  }

  return wrapTeamHandler('createConfig', () =>
    getTeamDataService().createTeamConfig({
      teamName,
      displayName: payload.displayName?.trim() || undefined,
      description: payload.description?.trim() || undefined,
      color: typeof payload.color === 'string' ? payload.color.trim() || undefined : undefined,
      members,
      cwd: typeof payload.cwd === 'string' ? payload.cwd.trim() || undefined : undefined,
      providerBackendId: providerBackendValidation.value,
      fastMode: fastModeValidation.value,
    })
  );
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
      logger.warn(
        `[teams:getLogsForTask] worker failed, falling back: ${workerErr instanceof Error ? workerErr.message : workerErr}`
      );
    }
  }
  return wrapTeamHandler('getLogsForTask', () =>
    getTeamMemberLogsFinder().findLogsForTask(vTeam.value!, vTask.value!, opts)
  );
}

async function handleGetTaskActivity(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<BoardTaskActivityEntry[]>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' };
  }
  return wrapTeamHandler('getTaskActivity', () =>
    getBoardTaskActivityService().getTaskActivity(vTeam.value!, vTask.value!)
  );
}

async function handleGetTaskActivityDetail(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  activityId: unknown
): Promise<IpcResult<BoardTaskActivityDetailResult>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' };
  }
  if (typeof activityId !== 'string' || activityId.trim().length === 0) {
    return { success: false, error: 'activityId must be a non-empty string' };
  }
  return wrapTeamHandler('getTaskActivityDetail', () =>
    getBoardTaskActivityDetailService().getTaskActivityDetail(
      vTeam.value!,
      vTask.value!,
      activityId.trim()
    )
  );
}

async function handleGetTaskLogStream(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<BoardTaskLogStreamResponse>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' };
  }
  return wrapTeamHandler('getTaskLogStream', () =>
    getBoardTaskLogStreamService().getTaskLogStream(vTeam.value!, vTask.value!)
  );
}

async function handleGetTaskLogStreamSummary(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<BoardTaskLogStreamSummary>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' };
  }
  return wrapTeamHandler('getTaskLogStreamSummary', () =>
    getBoardTaskLogStreamService().getTaskLogStreamSummary(vTeam.value!, vTask.value!)
  );
}

async function handleGetTaskExactLogSummaries(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<BoardTaskExactLogSummariesResponse>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' };
  }
  return wrapTeamHandler('getTaskExactLogSummaries', () =>
    getBoardTaskExactLogsService().getTaskExactLogSummaries(vTeam.value!, vTask.value!)
  );
}

async function handleGetTaskExactLogDetail(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  exactLogId: unknown,
  expectedSourceGeneration: unknown
): Promise<IpcResult<BoardTaskExactLogDetailResult>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  }
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' };
  }
  if (typeof exactLogId !== 'string' || exactLogId.trim().length === 0) {
    return { success: false, error: 'exactLogId must be a non-empty string' };
  }
  if (
    typeof expectedSourceGeneration !== 'string' ||
    expectedSourceGeneration.trim().length === 0
  ) {
    return { success: false, error: 'expectedSourceGeneration must be a non-empty string' };
  }
  return wrapTeamHandler('getTaskExactLogDetail', () =>
    getBoardTaskExactLogDetailService().getTaskExactLogDetail(
      vTeam.value!,
      vTask.value!,
      exactLogId.trim(),
      expectedSourceGeneration.trim()
    )
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
  return wrapTeamHandler('aliveList', async () => getTeamProvisioningService().getAliveTeams());
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
    getTeamProvisioningService().getLeadActivityState(validated.value!)
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
    getTeamProvisioningService().getLeadContextUsage(validated.value!)
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
    getTeamProvisioningService().getMemberSpawnStatuses(validated.value!)
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
    getTeamProvisioningService().getTeamAgentRuntimeSnapshot(validated.value!)
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
  return wrapTeamHandler('restartMember', async () =>
    getTeamProvisioningService().restartMember(validatedTeamName.value!, validatedMemberName.value!)
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
    getTeamProvisioningService().skipMemberForLaunch(
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
    getAutoResumeService().cancelPendingAutoResume(validated.value!);
    await getTeamProvisioningService().stopTeam(validated.value!);
  });
}

async function handleStartTask(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<{ notifiedOwner: boolean }>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }
  return wrapTeamHandler('startTask', () =>
    getTeamDataService().startTask(validatedTeamName.value!, validatedTaskId.value!)
  );
}

async function handleStartTaskByUser(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown
): Promise<IpcResult<{ notifiedOwner: boolean }>> {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
  }
  return wrapTeamHandler('startTaskByUser', () =>
    getTeamDataService().startTaskByUser(validatedTeamName.value!, validatedTaskId.value!)
  );
}

async function handleGetAllTasks(_event: IpcMainInvokeEvent): Promise<IpcResult<GlobalTask[]>> {
  setCurrentMainOp('team:getAllTasks');
  const startedAt = Date.now();
  try {
    return await wrapTeamHandler('getAllTasks', () => getTeamDataService().getAllTasks());
  } finally {
    const ms = Date.now() - startedAt;
    if (ms >= 1500) {
      logger.warn(`[teams:getAllTasks] slow ms=${ms}`);
    }
    setCurrentMainOp(null);
  }
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
  const { name, role, workflow, isolation, providerId, model } = payload as {
    name?: unknown;
    role?: unknown;
    workflow?: unknown;
    isolation?: unknown;
    providerId?: unknown;
    model?: unknown;
    effort?: unknown;
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

  return wrapTeamHandler('addMember', async () => {
    const tn = vTeam.value!;
    const memberName = vName.value!;
    const teamDataService = getTeamDataService();
    const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
    const previousMembers = (await teamDataService.getTeamData(tn))
      .members as RuntimeRosterMutationMember[];
    const provisioning = getTeamProvisioningService();
    const isTeamAlive = provisioning.isTeamAlive(tn);
    if (isTeamAlive && isOpenCodeLedRoster(previousMembers)) {
      throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
    }

    await teamDataService.addMember(tn, {
      name: memberName,
      role: role,
      workflow: typeof workflow === 'string' ? workflow.trim() || undefined : undefined,
      isolation: isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: providerValidation.value,
      model: typeof model === 'string' ? model.trim() || undefined : undefined,
      effort: effortValidation.value,
    });

    // If team is alive, notify the lead to spawn the new teammate
    if (isTeamAlive) {
      if (providerValidation.value === 'opencode') {
        try {
          await provisioning.reattachOpenCodeOwnedMemberLane(tn, memberName, {
            reason: 'member_added',
          });
        } catch (error) {
          await rollbackOpenCodeLiveRosterMutation({
            teamName: tn,
            teamDataService,
            provisioning,
            previousMembers,
            previousMembersMeta,
            detachOpenCodeMemberNames: [memberName],
          });
          throw error;
        }
        return;
      }

      let leadName = 'team-lead';
      let displayName = tn;
      try {
        const [resolvedLeadName, resolvedDisplayName] = await Promise.all([
          teamDataService.getLeadMemberName(tn),
          teamDataService.getTeamDisplayName(tn),
        ]);
        leadName = resolvedLeadName || 'team-lead';
        displayName = resolvedDisplayName || tn;
      } catch {
        // Best-effort: fall back to default lead and team names
      }
      const spawnMessage = buildAddMemberSpawnMessage(tn, displayName, leadName, {
        name: memberName,
        ...(typeof role === 'string' ? { role } : {}),
        ...(typeof workflow === 'string' ? { workflow } : {}),
        ...(isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
        ...(providerValidation.value ? { providerId: providerValidation.value } : {}),
        ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
        ...(effortValidation.value ? { effort: effortValidation.value } : {}),
      });
      try {
        await provisioning.sendMessageToTeam(tn, spawnMessage);
      } catch {
        // Best-effort: lead process may not be responsive
        logger.warn(`Failed to notify lead about new member "${memberName}" in ${tn}`);
      }
    }
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
    });
  }

  return wrapTeamHandler('replaceMembers', async () => {
    const tn = vTeam.value!;
    const teamDataService = getTeamDataService();
    const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
    const previousMembers = (await teamDataService.getTeamData(tn))
      .members as RuntimeRosterMutationMember[];
    const provisioning = getTeamProvisioningService();
    const isTeamAlive = provisioning.isTeamAlive(tn);
    const useSecondaryOpenCodeLaneRouting = isTeamAlive && !isOpenCodeLedRoster(previousMembers);
    if (isTeamAlive && !useSecondaryOpenCodeLaneRouting) {
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

    if (!isTeamAlive) {
      return;
    }

    let leadName = 'team-lead';
    let displayName = tn;
    try {
      const [resolvedLeadName, resolvedDisplayName] = await Promise.all([
        teamDataService.getLeadMemberName(tn),
        teamDataService.getTeamDisplayName(tn),
      ]);
      leadName = resolvedLeadName || 'team-lead';
      displayName = resolvedDisplayName || tn;
    } catch {
      // Best-effort: fall back to default lead and team names
    }

    try {
      for (const removedMember of removedOpenCodeMembers) {
        await provisioning.detachOpenCodeOwnedMemberLane(tn, removedMember.name);
      }

      for (const addedMember of addedOpenCodeMembers) {
        await provisioning.reattachOpenCodeOwnedMemberLane(tn, addedMember.name, {
          reason: 'member_added',
        });
      }

      for (const updatedMember of updatedOpenCodeMembers) {
        await provisioning.reattachOpenCodeOwnedMemberLane(tn, updatedMember.name, {
          reason: 'member_updated',
        });
      }
    } catch (error) {
      await rollbackOpenCodeLiveRosterMutation({
        teamName: tn,
        teamDataService,
        provisioning,
        previousMembers,
        previousMembersMeta,
        restoreOpenCodeMemberNames: [
          ...removedOpenCodeMembers.map((member) => member.name),
          ...updatedOpenCodeMembers.map((member) => member.name),
        ],
        detachOpenCodeMemberNames: addedOpenCodeMembers.map((member) => member.name),
      });
      throw error;
    }

    for (const addedMember of primaryDiff.added) {
      const spawnMessage = buildAddMemberSpawnMessage(tn, displayName, leadName, addedMember);
      try {
        await provisioning.sendMessageToTeam(tn, spawnMessage);
      } catch {
        logger.warn(`Failed to notify lead about new member "${addedMember.name}" in ${tn}`);
      }
    }

    const summaryMessage = buildReplaceMembersSummaryMessage(primaryDiff);
    if (!summaryMessage) {
      return;
    }
    try {
      await provisioning.sendMessageToTeam(tn, summaryMessage);
    } catch {
      logger.warn(`Failed to notify lead about member updates in ${tn}`);
    }
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
    const name = vMember.value!;
    const teamDataService = getTeamDataService();
    const previousMembersMeta = await new TeamMembersMetaStore().getMeta(tn).catch(() => null);
    const previousMembers = (await teamDataService.getTeamData(tn))
      .members as RuntimeRosterMutationMember[];
    const provisioning = getTeamProvisioningService();
    const isTeamAlive = provisioning.isTeamAlive(tn);
    if (isTeamAlive && isOpenCodeLedRoster(previousMembers)) {
      throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
    }
    const removedMember = previousMembers.find(
      (member) => member.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    await teamDataService.removeMember(tn, name);

    // Notify the lead about removed member
    if (isTeamAlive) {
      if (isOpenCodeRosterMutationMember(removedMember)) {
        try {
          await provisioning.detachOpenCodeOwnedMemberLane(tn, name);
        } catch (error) {
          await rollbackOpenCodeLiveRosterMutation({
            teamName: tn,
            teamDataService,
            provisioning,
            previousMembers,
            previousMembersMeta,
            restoreOpenCodeMemberNames: [name],
          });
          throw error;
        }
        return;
      }

      const message =
        `Teammate "${name}" has been removed from the team. ` +
        `They will no longer participate in team activities. Please reassign their tasks if needed.`;
      try {
        await provisioning.sendMessageToTeam(tn, message);
      } catch {
        logger.warn(`Failed to notify lead about removal of "${name}" in ${tn}`);
      }
    }
  });
}

async function handleUpdateTaskFields(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  fields: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  const tid = vTask.value!;
  if (!fields || typeof fields !== 'object') {
    return { success: false, error: 'fields must be an object' };
  }
  const { subject, description } = fields as { subject?: unknown; description?: unknown };
  if (subject !== undefined) {
    if (typeof subject !== 'string') return { success: false, error: 'subject must be a string' };
    if (subject.trim().length === 0) return { success: false, error: 'subject cannot be empty' };
    if (subject.length > 500)
      return { success: false, error: 'subject must be 500 characters or less' };
  }
  if (description !== undefined && typeof description !== 'string') {
    return { success: false, error: 'description must be a string' };
  }

  const validFields: { subject?: string; description?: string } = {};
  if (typeof subject === 'string') validFields.subject = subject.trim();
  if (typeof description === 'string') validFields.description = description;

  if (Object.keys(validFields).length === 0) {
    return { success: false, error: 'At least one field must be provided' };
  }

  return wrapTeamHandler('updateTaskFields', async () => {
    const tn = vTeam.value!;
    await getTeamDataService().updateTaskFields(tn, tid, validFields);

    // Notify the lead about updated task fields
    const provisioning = getTeamProvisioningService();
    if (provisioning.isTeamAlive(tn)) {
      const changedParts: string[] = [];
      if (validFields.subject) changedParts.push('title');
      if (validFields.description !== undefined) changedParts.push('description');
      const message =
        `Task #${tid} has been updated by the user (changed: ${changedParts.join(', ')}). ` +
        `New title: "${validFields.subject ?? '(unchanged)'}".`;
      try {
        await provisioning.sendMessageToTeam(tn, message);
      } catch {
        logger.warn(`Failed to notify lead about task fields update for #${tid} in ${tn}`);
      }
    }
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

  const normalizedRole =
    role === undefined || role === null
      ? undefined
      : typeof role === 'string'
        ? role.trim() || undefined
        : undefined;

  return wrapTeamHandler('updateMemberRole', async () => {
    const tn = vTeam.value!;
    const name = vMember.value!;
    const { oldRole, changed } = await getTeamDataService().updateMemberRole(
      tn,
      name,
      normalizedRole
    );

    if (changed) {
      const provisioning = getTeamProvisioningService();
      if (provisioning.isTeamAlive(tn)) {
        const oldDesc = oldRole ? `"${oldRole}"` : 'none';
        const newDesc = normalizedRole ? `"${normalizedRole}"` : 'none';
        const message = `Teammate "${name}" role changed from ${oldDesc} to ${newDesc}. This will take effect on next launch.`;
        try {
          await provisioning.sendMessageToTeam(tn, message);
        } catch {
          logger.warn(`Failed to notify lead about role change for "${name}" in ${tn}`);
        }
      }
    }
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
    const provisioning = getTeamProvisioningService();
    if (provisioning.isTeamAlive(tn)) {
      const message =
        `Process "${processLabel}" (PID ${pidNum}) has been stopped by the user from the UI. ` +
        `You may need to restart it if it was still needed.`;
      try {
        await provisioning.sendMessageToTeam(tn, message);
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

  // Hold a strong reference to prevent GC from collecting the notification
  activeTeamNotifications.add(notification);
  const cleanup = (): void => {
    activeTeamNotifications.delete(notification);
  };

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

async function handleAddTaskComment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  request: unknown
): Promise<IpcResult<TaskComment>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (!request || typeof request !== 'object') {
    return { success: false, error: 'Invalid add task comment request' };
  }
  const payload = request as Partial<AddTaskCommentRequest>;
  const text = payload.text;
  if (typeof text !== 'string' || text.trim().length === 0)
    return { success: false, error: 'Comment text must be non-empty' };
  if (text.trim().length > MAX_TEXT_LENGTH)
    return { success: false, error: `Comment exceeds ${MAX_TEXT_LENGTH} characters` };
  const validatedTaskRefs = validateTaskRefs(payload.taskRefs);
  if (!validatedTaskRefs.valid) {
    return { success: false, error: validatedTaskRefs.error };
  }

  const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    return { success: false, error: `Maximum ${MAX_ATTACHMENTS} attachments per comment` };
  }

  return wrapTeamHandler('addTaskComment', async () => {
    // Save comment attachments (images). Done inside wrapTeamHandler so failures return IpcResult.
    let savedAttachments: TaskAttachmentMeta[] | undefined;
    if (rawAttachments.length > 0) {
      savedAttachments = [];
      for (const att of rawAttachments) {
        if (!att || typeof att !== 'object') {
          throw new Error('Invalid attachment data');
        }
        const a = att as unknown as Record<string, unknown>;
        if (
          typeof a.id !== 'string' ||
          typeof a.filename !== 'string' ||
          typeof a.mimeType !== 'string' ||
          typeof a.base64Data !== 'string' ||
          a.base64Data.length === 0 ||
          !ALLOWED_ATTACHMENT_TYPES.has(a.mimeType)
        ) {
          throw new Error('Invalid attachment data');
        }
        const safeId = a.id.trim();
        if (safeId.includes('/') || safeId.includes('\\') || safeId.includes('..')) {
          throw new Error('Invalid attachment ID');
        }
        const meta = await taskAttachmentStore.saveAttachment(
          vTeam.value!,
          vTask.value!,
          safeId,
          a.filename,
          a.mimeType,
          a.base64Data
        );
        savedAttachments.push(meta);
      }
    }

    return getTeamDataService().addTaskComment(
      vTeam.value!,
      vTask.value!,
      text.trim(),
      savedAttachments,
      validatedTaskRefs.value
    );
  });
}

const VALID_RELATIONSHIP_TYPES = ['blockedBy', 'blocks', 'related'] as const;
type RelationshipType = (typeof VALID_RELATIONSHIP_TYPES)[number];

async function handleAddTaskRelationship(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  targetId: unknown,
  type: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  const vTarget = validateTaskId(targetId);
  if (!vTarget.valid) return { success: false, error: vTarget.error ?? 'Invalid targetId' };
  if (typeof type !== 'string' || !VALID_RELATIONSHIP_TYPES.includes(type as RelationshipType)) {
    return {
      success: false,
      error: `type must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}`,
    };
  }

  return wrapTeamHandler('addTaskRelationship', () =>
    getTeamDataService().addTaskRelationship(
      vTeam.value!,
      vTask.value!,
      vTarget.value!,
      type as RelationshipType
    )
  );
}

async function handleRemoveTaskRelationship(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  targetId: unknown,
  type: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  const vTarget = validateTaskId(targetId);
  if (!vTarget.valid) return { success: false, error: vTarget.error ?? 'Invalid targetId' };
  if (typeof type !== 'string' || !VALID_RELATIONSHIP_TYPES.includes(type as RelationshipType)) {
    return {
      success: false,
      error: `type must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}`,
    };
  }

  return wrapTeamHandler('removeTaskRelationship', () =>
    getTeamDataService().removeTaskRelationship(
      vTeam.value!,
      vTask.value!,
      vTarget.value!,
      type as RelationshipType
    )
  );
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
  if (typeof mimeType !== 'string' || !ALLOWED_ATTACHMENT_TYPES.has(mimeType)) {
    return {
      success: false,
      error: `mimeType must be one of: ${[...ALLOWED_ATTACHMENT_TYPES].join(', ')}`,
    };
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
      mimeType,
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
  if (typeof mimeType !== 'string' || !ALLOWED_ATTACHMENT_TYPES.has(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('getTaskAttachment', () =>
    taskAttachmentStore.getAttachment(vTeam.value!, vTask.value!, safeAttId, mimeType)
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
  if (typeof mimeType !== 'string' || !ALLOWED_ATTACHMENT_TYPES.has(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('deleteTaskAttachment', async () => {
    await taskAttachmentStore.deleteAttachment(vTeam.value!, vTask.value!, safeAttId, mimeType);
    // Remove metadata from task JSON
    await getTeamDataService().removeTaskAttachment(vTeam.value!, vTask.value!, safeAttId);
  });
}

async function handleToolApprovalRespond(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  runId: unknown,
  requestId: unknown,
  allow: unknown,
  message?: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return { success: false, error: 'runId must be a non-empty string' };
  }
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return { success: false, error: 'requestId must be a non-empty string' };
  }
  if (typeof allow !== 'boolean') {
    return { success: false, error: 'allow must be a boolean' };
  }
  return wrapTeamHandler('toolApprovalRespond', () =>
    getTeamProvisioningService().respondToToolApproval(
      validated.value!,
      runId,
      requestId,
      allow,
      typeof message === 'string' ? message : undefined
    )
  );
}

async function handleToolApprovalSettings(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  settings: unknown
): Promise<IpcResult<void>> {
  if (typeof teamName !== 'string' || teamName.trim().length === 0) {
    return { success: false, error: 'teamName must be a non-empty string' };
  }
  if (typeof settings !== 'object' || settings === null) {
    return { success: false, error: 'Settings must be an object' };
  }
  const s = settings as Record<string, unknown>;
  if (typeof s.autoAllowAll !== 'boolean') {
    return { success: false, error: 'autoAllowAll must be a boolean' };
  }
  if (typeof s.autoAllowFileEdits !== 'boolean') {
    return { success: false, error: 'autoAllowFileEdits must be a boolean' };
  }
  if (typeof s.autoAllowSafeBash !== 'boolean') {
    return { success: false, error: 'autoAllowSafeBash must be a boolean' };
  }
  if (typeof s.timeoutAction !== 'string' || !['allow', 'deny', 'wait'].includes(s.timeoutAction)) {
    return { success: false, error: 'timeoutAction must be "allow", "deny", or "wait"' };
  }
  if (
    typeof s.timeoutSeconds !== 'number' ||
    !Number.isFinite(s.timeoutSeconds) ||
    s.timeoutSeconds < 5 ||
    s.timeoutSeconds > 300
  ) {
    return { success: false, error: 'timeoutSeconds must be a number between 5 and 300' };
  }

  try {
    getTeamProvisioningService().updateToolApprovalSettings(
      teamName,
      s as unknown as ToolApprovalSettings
    );
  } catch (err) {
    return {
      success: false,
      error: `Failed to update tool approval settings: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { success: true, data: undefined };
}

/** Max file size for tool approval diff preview (2MB). */
const TOOL_APPROVAL_MAX_FILE_SIZE = 2 * 1024 * 1024;

async function handleToolApprovalReadFile(
  _event: IpcMainInvokeEvent,
  filePath: unknown
): Promise<IpcResult<ToolApprovalFileContent>> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return { success: false, error: 'filePath must be a non-empty string' };
  }
  if (!path.isAbsolute(filePath)) {
    return { success: false, error: 'filePath must be an absolute path' };
  }

  try {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          success: true,
          data: { content: '', exists: false, truncated: false, isBinary: false },
        };
      }
      throw err;
    }

    if (!stats.isFile()) {
      return {
        success: true,
        data: { content: '', exists: true, truncated: false, isBinary: false, error: 'Not a file' },
      };
    }

    const truncated = stats.size > TOOL_APPROVAL_MAX_FILE_SIZE;
    const readSize = truncated ? TOOL_APPROVAL_MAX_FILE_SIZE : stats.size;

    // Read file (potentially truncated)
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, 0);

      // Binary detection: check first 8KB for null bytes
      const checkSize = Math.min(readSize, 8192);
      for (let i = 0; i < checkSize; i++) {
        if (buffer[i] === 0) {
          return {
            success: true,
            data: { content: '', exists: true, truncated: false, isBinary: true },
          };
        }
      }

      return {
        success: true,
        data: { content: buffer.toString('utf-8'), exists: true, truncated, isBinary: false },
      };
    } finally {
      await fd.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: true,
      data: { content: '', exists: true, truncated: false, isBinary: false, error: msg },
    };
  }
}

async function handleGetSavedRequest(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<TeamCreateRequest | null>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  const tn = validated.value!;

  const meta = await teamMetaStore.getMeta(tn);
  if (!meta) {
    return { success: true, data: null };
  }

  const membersStore = new TeamMembersMetaStore();
  const membersMeta = await membersStore.getMeta(tn);
  const members = membersMeta?.members ?? [];

  const resolvedProviderId = meta.providerId ?? 'anthropic';

  return {
    success: true,
    data: {
      teamName: tn,
      displayName: meta.displayName,
      description: meta.description,
      color: meta.color,
      cwd: meta.cwd,
      prompt: meta.prompt,
      providerId: resolvedProviderId,
      providerBackendId: migrateProviderBackendId(
        resolvedProviderId,
        meta.providerBackendId ?? membersMeta?.providerBackendId
      ),
      model: meta.model,
      effort: meta.effort as TeamCreateRequest['effort'],
      fastMode: meta.fastMode,
      skipPermissions: meta.skipPermissions,
      worktree: meta.worktree,
      extraCliArgs: meta.extraCliArgs,
      limitContext: meta.limitContext,
      members: members.map((m) => ({
        name: m.name,
        role: m.role,
        workflow: m.workflow,
        providerId: m.providerId,
        model: m.model,
        effort: m.effort,
      })),
    },
  };
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
