import {
  TEAM_ADD_TASK_COMMENT,
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_TASK,
  TEAM_DELETE_TEAM,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_DATA,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_LAUNCH,
  TEAM_LIST,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_PROVISIONING_PROGRESS,
  TEAM_PROVISIONING_STATUS,
  TEAM_REQUEST_REVIEW,
  TEAM_SEND_MESSAGE,
  TEAM_START_TASK,
  TEAM_STOP,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_TASK_STATUS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { validateFromField, validateMemberName, validateTaskId, validateTeamName } from './guards';

import type {
  MemberStatsComputer,
  TeamDataService,
  TeamMemberLogsFinder,
  TeamProvisioningService,
} from '../services';
import type {
  CreateTaskRequest,
  GlobalTask,
  IpcResult,
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
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamUpdateConfigRequest,
  UpdateKanbanPatch,
} from '@shared/types';

const logger = createLogger('IPC:teams');

let teamDataService: TeamDataService | null = null;
let teamProvisioningService: TeamProvisioningService | null = null;
let teamMemberLogsFinder: TeamMemberLogsFinder | null = null;
let memberStatsComputer: MemberStatsComputer | null = null;

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
  ipcMain.handle(TEAM_UPDATE_TASK_STATUS, handleUpdateTaskStatus);
  ipcMain.handle(TEAM_DELETE_TEAM, handleDeleteTeam);
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
  ipcMain.removeHandler(TEAM_UPDATE_TASK_STATUS);
  ipcMain.removeHandler(TEAM_DELETE_TEAM);
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

async function handleListTeams(_event: IpcMainInvokeEvent): Promise<IpcResult<TeamSummary[]>> {
  return wrapTeamHandler('list', () => getTeamDataService().listTeams());
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
  const provisioning = getTeamProvisioningService();
  const isAlive = provisioning.isTeamAlive(tn);

  if (isAlive) {
    void provisioning.relayLeadInboxMessages(tn).catch(() => undefined);
  }

  const live = provisioning.getLiveLeadProcessMessages(tn);
  if (live.length === 0) {
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
    const result = await getTeamDataService().updateConfig(validated.value!, {
      name,
      description,
      color,
    });
    if (!result) {
      throw new Error('Team config not found');
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

  if (!Array.isArray(payload.members) || payload.members.length === 0) {
    return { valid: false, error: 'members must contain at least one member' };
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
    members.push({ name: memberName, role: typeof role === 'string' ? role.trim() : undefined });
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

  return wrapTeamHandler('launch', () =>
    getTeamProvisioningService().launchTeam(
      {
        teamName: validatedTeamName.value!,
        cwd,
        prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
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

  return wrapTeamHandler('sendMessage', async () => {
    const tn = validatedTeamName.value!;
    const result = await getTeamDataService().sendMessage(tn, {
      member: validatedMember.value!,
      text: payload.text!,
      summary: payload.summary,
      from: payload.from,
    });

    // Best-effort: if messaging the lead while process is alive, relay immediately (no UI dependency).
    try {
      const provisioning = getTeamProvisioningService();
      if (provisioning.isTeamAlive(tn)) {
        // Avoid reading unrelated inboxes; relayLeadInboxMessages will no-op when nothing new exists.
        void provisioning.relayLeadInboxMessages(tn).catch(() => undefined);
      }
    } catch {
      // ignore
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

  if (!Array.isArray(payload.members) || payload.members.length === 0) {
    return { success: false, error: 'members must contain at least one member' };
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
    members.push({ name: memberName, role: typeof role === 'string' ? role.trim() : undefined });
  }

  return wrapTeamHandler('createConfig', () =>
    getTeamDataService().createTeamConfig({
      teamName,
      displayName: payload.displayName?.trim() || undefined,
      description: payload.description?.trim() || undefined,
      color: typeof payload.color === 'string' ? payload.color.trim() || undefined : undefined,
      members,
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
  options?: { owner?: string; status?: string }
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
): Promise<IpcResult<void>> {
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
  return wrapTeamHandler('getAllTasks', () => getTeamDataService().getAllTasks());
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
