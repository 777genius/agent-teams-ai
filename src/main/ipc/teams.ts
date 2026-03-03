import { randomUUID } from 'node:crypto';

import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import { getAppIconPath } from '@main/utils/appIcon';
import {
  TEAM_ADD_MEMBER,
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_TASK,
  TEAM_DELETE_TEAM,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_DATA,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_KILL_PROCESS,
  TEAM_LAUNCH,
  TEAM_LEAD_ACTIVITY,
  TEAM_LIST,
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
  TEAM_RESTORE,
  TEAM_RESTORE_TASK,
  TEAM_SEND_MESSAGE,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_STOP,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { KANBAN_COLUMN_IDS } from '@shared/constants/kanban';
import { createLogger } from '@shared/utils/logger';
import { isRateLimitMessage } from '@shared/utils/rateLimitDetector';
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, Notification } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigManager } from '../services/infrastructure/ConfigManager';
import { NotificationManager } from '../services/infrastructure/NotificationManager';
import { gitIdentityResolver } from '../services/parsing/GitIdentityResolver';

import { validateFromField, validateMemberName, validateTaskId, validateTeamName } from './guards';

/** Track rate limit message keys already notified to avoid duplicate OS notifications across refreshes. */
const notifiedRateLimitKeys = new Set<string>();
const RATE_LIMIT_KEYS_MAX = 500;

import { TeamAttachmentStore } from '../services/team/TeamAttachmentStore';

import type {
  MemberStatsComputer,
  TeamDataService,
  TeamMemberLogsFinder,
  TeamProvisioningService,
} from '../services';
import type {
  AttachmentFileData,
  AttachmentMeta,
  AttachmentPayload,
  CreateTaskRequest,
  GlobalTask,
  IpcResult,
  KanbanColumnId,
  MemberFullStats,
  MemberLogSummary,
  SendMessageRequest,
  SendMessageResult,
  TaskComment,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamData,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMessageNotificationData,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamUpdateConfigRequest,
  UpdateKanbanPatch,
} from '@shared/types';

const logger = createLogger('IPC:teams');

/**
 * Check messages for rate limit indicators and fire native notifications for new ones.
 */
function checkRateLimitMessages(
  messages: readonly { messageId?: string; from: string; text: string; timestamp: string }[],
  teamName: string,
  teamDisplayName: string,
  projectPath?: string
): void {
  for (const msg of messages) {
    if (msg.from === 'user') continue;
    if (!isRateLimitMessage(msg.text)) continue;

    // Prefix key with teamName to avoid collisions across teams
    const rawKey = msg.messageId ?? `${msg.from}:${msg.timestamp}`;
    const key = `${teamName}:${rawKey}`;
    if (notifiedRateLimitKeys.has(key)) continue;
    notifiedRateLimitKeys.add(key);

    // Prevent unbounded memory growth
    if (notifiedRateLimitKeys.size > RATE_LIMIT_KEYS_MAX) {
      const first = notifiedRateLimitKeys.values().next().value!;
      notifiedRateLimitKeys.delete(first);
    }

    void NotificationManager.getInstance()
      .addError({
        id: randomUUID(),
        timestamp: Date.now(),
        sessionId: `team:${teamName}`,
        projectId: teamName,
        filePath: '',
        source: 'rate-limit',
        message: `[${msg.from}] ${msg.text.slice(0, 200)}`,
        triggerColor: 'red',
        triggerName: 'Rate Limit',
        context: {
          projectName: teamDisplayName,
          cwd: projectPath,
        },
      })
      .catch(() => undefined);
  }
}

let teamDataService: TeamDataService | null = null;
let teamProvisioningService: TeamProvisioningService | null = null;
let teamMemberLogsFinder: TeamMemberLogsFinder | null = null;
let memberStatsComputer: MemberStatsComputer | null = null;

const attachmentStore = new TeamAttachmentStore();

const ALLOWED_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB total

export function initializeTeamHandlers(
  service: TeamDataService,
  provisioningService: TeamProvisioningService,
  logsFinder?: TeamMemberLogsFinder,
  statsComputer?: MemberStatsComputer
): void {
  teamDataService = service;
  teamProvisioningService = provisioningService;
  teamMemberLogsFinder = logsFinder ?? null;
  memberStatsComputer = statsComputer ?? null;
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(TEAM_LIST, handleListTeams);
  ipcMain.handle(TEAM_GET_DATA, handleGetData);
  ipcMain.handle(TEAM_PREPARE_PROVISIONING, handlePrepareProvisioning);
  ipcMain.handle(TEAM_CREATE, handleCreateTeam);
  ipcMain.handle(TEAM_LAUNCH, handleLaunchTeam);
  ipcMain.handle(TEAM_PROVISIONING_STATUS, handleProvisioningStatus);
  ipcMain.handle(TEAM_CANCEL_PROVISIONING, handleCancelProvisioning);
  ipcMain.handle(TEAM_SEND_MESSAGE, handleSendMessage);
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
  ipcMain.handle(TEAM_GET_MEMBER_STATS, handleGetMemberStats);
  ipcMain.handle(TEAM_UPDATE_CONFIG, handleUpdateConfig);
  ipcMain.handle(TEAM_START_TASK, handleStartTask);
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
  ipcMain.handle(TEAM_SOFT_DELETE_TASK, handleSoftDeleteTask);
  ipcMain.handle(TEAM_RESTORE_TASK, handleRestoreTask);
  ipcMain.handle(TEAM_GET_DELETED_TASKS, handleGetDeletedTasks);
  ipcMain.handle(TEAM_SET_TASK_CLARIFICATION, handleSetTaskClarification);
  ipcMain.handle(TEAM_SHOW_MESSAGE_NOTIFICATION, handleShowMessageNotification);
  ipcMain.handle(TEAM_ADD_TASK_RELATIONSHIP, handleAddTaskRelationship);
  ipcMain.handle(TEAM_REMOVE_TASK_RELATIONSHIP, handleRemoveTaskRelationship);
  logger.info('Team handlers registered');
}

export function removeTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_LIST);
  ipcMain.removeHandler(TEAM_GET_DATA);
  ipcMain.removeHandler(TEAM_PREPARE_PROVISIONING);
  ipcMain.removeHandler(TEAM_CREATE);
  ipcMain.removeHandler(TEAM_LAUNCH);
  ipcMain.removeHandler(TEAM_PROVISIONING_STATUS);
  ipcMain.removeHandler(TEAM_CANCEL_PROVISIONING);
  ipcMain.removeHandler(TEAM_SEND_MESSAGE);
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
  ipcMain.removeHandler(TEAM_GET_MEMBER_STATS);
  ipcMain.removeHandler(TEAM_UPDATE_CONFIG);
  ipcMain.removeHandler(TEAM_START_TASK);
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
  ipcMain.removeHandler(TEAM_SOFT_DELETE_TASK);
  ipcMain.removeHandler(TEAM_RESTORE_TASK);
  ipcMain.removeHandler(TEAM_GET_DELETED_TASKS);
  ipcMain.removeHandler(TEAM_SET_TASK_CLARIFICATION);
  ipcMain.removeHandler(TEAM_SHOW_MESSAGE_NOTIFICATION);
  ipcMain.removeHandler(TEAM_ADD_TASK_RELATIONSHIP);
  ipcMain.removeHandler(TEAM_REMOVE_TASK_RELATIONSHIP);
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
    const branch = await gitIdentityResolver.getBranch(projectPath.trim());
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
): Promise<IpcResult<TeamData>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  const tn = validated.value!;
  const startedAt = Date.now();
  let data: TeamData;
  try {
    data = await getTeamDataService().getTeamData(tn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === `Team not found: ${tn}` &&
      getTeamProvisioningService().hasProvisioningRun(tn)
    ) {
      return { success: false, error: 'TEAM_PROVISIONING' };
    }
    logger.error(`[teams:getData] ${message}`);
    return { success: false, error: message };
  }
  const getDataMs = Date.now() - startedAt;
  if (getDataMs >= 1500) {
    logger.warn(`[teams:getData] slow team=${tn} ms=${getDataMs}`);
  }
  const provisioning = getTeamProvisioningService();
  const isAlive = provisioning.isTeamAlive(tn);

  if (isAlive) {
    void provisioning.relayLeadInboxMessages(tn).catch(() => undefined);
  }

  const displayName = data.config.name || tn;
  const projectPath = data.config.projectPath;

  const live = provisioning.getLiveLeadProcessMessages(tn);
  if (live.length === 0) {
    checkRateLimitMessages(data.messages, tn, displayName, projectPath);
    return { success: true, data: { ...data, isAlive } };
  }

  const normalizeText = (text: string): string => text.trim().replace(/\r\n/g, '\n');
  const leadSessionTextFingerprints = new Set<string>();
  for (const msg of data.messages) {
    if ((msg as { source?: unknown }).source !== 'lead_session') continue;
    if (typeof msg.from !== 'string' || typeof msg.text !== 'string') continue;
    leadSessionTextFingerprints.add(`${msg.from}\0${normalizeText(msg.text)}`);
  }

  const keyFor = (m: {
    messageId?: string;
    timestamp: string;
    from: string;
    text: string;
  }): string => {
    if (typeof m.messageId === 'string' && m.messageId.trim().length > 0) {
      return m.messageId;
    }
    return `${m.timestamp}\0${m.from}\0${(m.text ?? '').slice(0, 80)}`;
  };

  const merged: typeof data.messages = [];
  const seen = new Set<string>();
  for (const msg of [...data.messages, ...live]) {
    if ((msg as { source?: unknown }).source === 'lead_process') {
      const fp = `${msg.from}\0${normalizeText(msg.text ?? '')}`;
      if (leadSessionTextFingerprints.has(fp)) {
        continue;
      }
    }
    const key = keyFor(msg);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(msg);
  }
  merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  checkRateLimitMessages(merged, tn, displayName, projectPath);
  return { success: true, data: { ...data, isAlive, messages: merged } };
}

async function handleDeleteTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('deleteTeam', () => getTeamDataService().deleteTeam(validated.value!));
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
  return wrapTeamHandler('permanentlyDeleteTeam', () =>
    getTeamDataService().permanentlyDeleteTeam(validated.value!)
  );
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
    const result = await getTeamDataService().updateConfig(tn, {
      name,
      description,
      color,
    });
    if (!result) {
      throw new Error('Team config not found');
    }

    // Notify running lead about the rename so it stays aware of current team name
    if (typeof name === 'string' && name.trim()) {
      const provisioning = getTeamProvisioningService();
      if (provisioning.isTeamAlive(tn)) {
        const msg = `The team has been renamed to "${name.trim()}". Please use this name when referring to the team going forward.`;
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

  const seenNames = new Set<string>();
  const members: TeamCreateRequest['members'] = [];
  for (const member of payload.members) {
    if (!member || typeof member !== 'object') {
      return { valid: false, error: 'member must be object' };
    }
    const nameValidation = validateMemberName((member as { name?: unknown }).name);
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
    members.push({
      name: memberName,
      role: typeof role === 'string' ? role.trim() : undefined,
      workflow: typeof workflow === 'string' ? workflow.trim() : undefined,
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
      model: typeof payload.model === 'string' ? payload.model.trim() || undefined : undefined,
    },
  };
}

async function handleCreateTeam(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<IpcResult<TeamCreateResponse>> {
  const validation = await validateProvisioningRequest(request);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return wrapTeamHandler('create', () =>
    getTeamProvisioningService().createTeam(validation.value, (progress) => {
      try {
        event.sender.send(TEAM_PROVISIONING_PROGRESS, progress);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to emit provisioning progress: ${message}`);
      }
    })
  );
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

  return wrapTeamHandler('launch', () =>
    getTeamProvisioningService().launchTeam(
      {
        teamName: validatedTeamName.value!,
        cwd,
        prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
        model: typeof payload.model === 'string' ? payload.model.trim() || undefined : undefined,
        clearContext: payload.clearContext === true ? true : undefined,
      },
      (progress) => {
        try {
          event.sender.send(TEAM_PROVISIONING_PROGRESS, progress);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to emit launch provisioning progress: ${message}`);
        }
      }
    )
  );
}

async function handlePrepareProvisioning(
  _event: IpcMainInvokeEvent,
  cwd: unknown
): Promise<IpcResult<TeamProvisioningPrepareResult>> {
  let validatedCwd: string | undefined;
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      return { success: false, error: 'cwd must be a non-empty string' };
    }
    validatedCwd = cwd.trim();
    if (!path.isAbsolute(validatedCwd)) {
      return { success: false, error: 'cwd must be an absolute path' };
    }
  }
  return wrapTeamHandler('prepareProvisioning', () =>
    getTeamProvisioningService().prepareForProvisioning(validatedCwd)
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
    return patch.comment === undefined || typeof patch.comment === 'string';
  }

  return patch.op === 'set_column' && (patch.column === 'review' || patch.column === 'approved');
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

  return wrapTeamHandler('sendMessage', async () => {
    const tn = validatedTeamName.value!;
    const provisioning = getTeamProvisioningService();
    const isAlive = provisioning.isTeamAlive(tn);

    const leadName = await getTeamDataService().getLeadMemberName(tn);
    const memberName = validatedMember.value!;
    const isLeadRecipient = leadName !== null && memberName === leadName;

    // Attachments only supported for live lead (stdin content blocks)
    if (validatedAttachments?.length && (!isLeadRecipient || !isAlive)) {
      throw new Error(
        'Attachments are only supported when sending to the team lead while the team is online'
      );
    }

    // Smart routing: lead + alive → stdin direct, else → inbox
    if (isLeadRecipient && isAlive) {
      // Separate try blocks: stdin delivery vs persistence
      // If stdin succeeds but persistence fails, do NOT fallback to inbox (would duplicate)
      let stdinSent = false;
      try {
        await provisioning.sendMessageToTeam(tn, payload.text!, validatedAttachments);
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
        // Persistence is best-effort — stdin already delivered the message
        let result: SendMessageResult;
        try {
          result = await getTeamDataService().sendDirectToLead(
            tn,
            leadName,
            payload.text!,
            payload.summary
          );
        } catch (persistError) {
          logger.warn(`Persistence failed after stdin delivery for ${tn}: ${String(persistError)}`);
          result = { deliveredToInbox: false, messageId: `stdin-${Date.now()}` };
        }

        const attachmentMeta: AttachmentMeta[] | undefined = validatedAttachments?.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        }));

        // Save attachment binary data to disk (best-effort)
        if (validatedAttachments?.length && result.messageId) {
          void attachmentStore
            .saveAttachments(tn, result.messageId, validatedAttachments)
            .catch((e) => logger.warn(`Failed to save attachments: ${e}`));
        }

        provisioning.pushLiveLeadProcessMessage(tn, {
          from: 'user',
          to: leadName,
          text: payload.text!,
          timestamp: new Date().toISOString(),
          read: true,
          summary: payload.summary,
          messageId: result.messageId,
          source: 'user_sent',
          attachments: attachmentMeta,
        });

        return result;
      }
    }

    // Inbox path: offline lead or regular members (no attachment support)
    const result = await getTeamDataService().sendMessage(tn, {
      member: memberName,
      text: payload.text!,
      summary: payload.summary,
      from: payload.from,
    });

    // Best-effort relay for lead via inbox
    if (isLeadRecipient && isAlive) {
      void provisioning.relayLeadInboxMessages(tn).catch(() => undefined);
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
      prompt: payload.prompt?.trim() || undefined,
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

  if (owner !== null && (typeof owner !== 'string' || owner.length === 0)) {
    return { success: false, error: 'owner must be a non-empty string or null' };
  }

  return wrapTeamHandler('updateTaskOwner', () =>
    getTeamDataService().updateTaskOwner(validatedTeamName.value!, validatedTaskId.value!, owner)
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

  const seenNames = new Set<string>();
  const members: TeamCreateConfigRequest['members'] = [];
  for (const member of payload.members) {
    if (!member || typeof member !== 'object') {
      return { success: false, error: 'member must be object' };
    }
    const nameValidation = validateMemberName((member as { name?: unknown }).name);
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
    members.push({
      name: memberName,
      role: typeof role === 'string' ? role.trim() : undefined,
      workflow: typeof workflow === 'string' ? workflow.trim() : undefined,
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
  return wrapTeamHandler('aliveList', async () => getTeamProvisioningService().getAliveTeams());
}

async function handleLeadActivity(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<string>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('leadActivity', async () =>
    getTeamProvisioningService().getLeadActivityState(validated.value!)
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
    getTeamProvisioningService().stopTeam(validated.value!);
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
  const { name, role } = payload as { name?: unknown; role?: unknown };
  const vName = validateMemberName(name);
  if (!vName.valid) return { success: false, error: vName.error ?? 'Invalid member name' };
  if (role !== undefined && typeof role !== 'string') {
    return { success: false, error: 'role must be a string' };
  }

  return wrapTeamHandler('addMember', async () => {
    const tn = vTeam.value!;
    const memberName = vName.value!;
    await getTeamDataService().addMember(tn, {
      name: memberName,
      role: role,
    });

    // If team is alive, notify the lead to spawn the new teammate
    const provisioning = getTeamProvisioningService();
    if (provisioning.isTeamAlive(tn)) {
      const roleHint = typeof role === 'string' && role.trim() ? ` with role "${role.trim()}"` : '';
      const spawnMessage =
        `A new teammate "${memberName}"${roleHint} has been added to the team. ` +
        `Please spawn them immediately using the Task tool with team_name="${tn}" and name="${memberName}".`;
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
  const members: { name: string; role?: string; workflow?: string }[] = [];
  for (const item of payload.members) {
    if (!item || typeof item !== 'object') {
      return { success: false, error: 'member must be object' };
    }
    const m = item as { name?: unknown; role?: unknown; workflow?: unknown };
    const vName = validateMemberName(m.name);
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
    members.push({
      name,
      role: typeof m.role === 'string' ? m.role.trim() : undefined,
      workflow: typeof m.workflow === 'string' ? m.workflow.trim() : undefined,
    });
  }

  return wrapTeamHandler('replaceMembers', async () => {
    await getTeamDataService().replaceMembers(vTeam.value!, { members });
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
    await getTeamDataService().removeMember(tn, name);

    // Notify the lead about removed member
    const provisioning = getTeamProvisioningService();
    if (provisioning.isTeamAlive(tn)) {
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
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return { success: false, error: 'taskId must be a non-empty string' };
  }
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
  if (typeof subject === 'string') validFields.subject = subject;
  if (typeof description === 'string') validFields.description = description;

  if (Object.keys(validFields).length === 0) {
    return { success: false, error: 'At least one field must be provided' };
  }

  return wrapTeamHandler('updateTaskFields', async () => {
    const tn = vTeam.value!;
    await getTeamDataService().updateTaskFields(tn, taskId, validFields);

    // Notify the lead about updated task fields
    const provisioning = getTeamProvisioningService();
    if (provisioning.isTeamAlive(tn)) {
      const changedParts: string[] = [];
      if (validFields.subject) changedParts.push('title');
      if (validFields.description !== undefined) changedParts.push('description');
      const message =
        `Task #${taskId} has been updated by the user (changed: ${changedParts.join(', ')}). ` +
        `New title: "${validFields.subject ?? '(unchanged)'}".`;
      try {
        await provisioning.sendMessageToTeam(tn, message);
      } catch {
        logger.warn(`Failed to notify lead about task fields update for #${taskId} in ${tn}`);
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

  showTeamNativeNotification({
    title: d.teamDisplayName,
    subtitle: d.summary ?? `${d.from} → ${d.to ?? 'team'}`,
    body: d.body,
  });
  return { success: true, data: undefined };
}

/**
 * Show a native OS notification for a team event.
 * Respects user's notification settings (enabled, snoozed).
 * Cross-platform: macOS, Linux, Windows via Electron Notification API.
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
  const truncatedBody = opts.body.slice(0, 300);
  const iconPath = getAppIconPath();
  const notification = new Notification({
    title: opts.title,
    ...(isMac && opts.subtitle ? { subtitle: opts.subtitle } : {}),
    body: !isMac && opts.subtitle ? `${opts.subtitle}\n${truncatedBody}` : truncatedBody,
    sound: config.notifications.soundEnabled ? 'default' : undefined,
    ...(iconPath ? { icon: iconPath } : {}),
  });

  notification.on('click', () => {
    const windows = BrowserWindow.getAllWindows();
    const mainWin = windows[0];
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
    }
  });

  notification.on('show', () => {
    logger.debug(`[native-notification] shown: "${opts.title}" — ${opts.subtitle ?? ''}`);
  });

  notification.on('failed', (_, error) => {
    logger.warn(`[native-notification] failed: ${error}`);
  });

  notification.show();
}

async function handleAddTaskComment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  text: unknown
): Promise<IpcResult<TaskComment>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (typeof text !== 'string' || text.trim().length === 0)
    return { success: false, error: 'Comment text must be non-empty' };
  if (text.trim().length > 2000)
    return { success: false, error: 'Comment exceeds 2000 characters' };

  return wrapTeamHandler('addTaskComment', () =>
    getTeamDataService().addTaskComment(vTeam.value!, vTask.value!, text.trim())
  );
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
