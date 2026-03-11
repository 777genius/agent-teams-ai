import {
  CROSS_TEAM_GET_OUTBOX,
  CROSS_TEAM_LIST_TARGETS,
  CROSS_TEAM_SEND,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import { isAgentActionMode } from '../services/team/actionModeInstructions';
import { validateTaskId, validateTeamName } from './guards';
import type { CrossTeamService } from '../services/team/CrossTeamService';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { IpcResult, TaskRef } from '@shared/types';

const logger = createLogger('IPC:crossTeam');

let crossTeamService: CrossTeamService | null = null;

export function initializeCrossTeamHandlers(service: CrossTeamService): void {
  crossTeamService = service;
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
    const vTaskId = validateTaskId(taskId);
    if (!vTaskId.valid) {
      return { valid: false, error: vTaskId.error ?? 'Invalid taskRef taskId' };
    }
    const vTeamName = validateTeamName(teamName);
    if (!vTeamName.valid) {
      return { valid: false, error: vTeamName.error ?? 'Invalid taskRef teamName' };
    }
    taskRefs.push({ taskId: vTaskId.value!, displayId, teamName: vTeamName.value! });
  }

  return { valid: true, value: taskRefs };
}

function getService(): CrossTeamService {
  if (!crossTeamService) {
    throw new Error('CrossTeamService not initialized');
  }
  return crossTeamService;
}

async function wrapCrossTeamHandler<T>(
  operation: string,
  handler: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    const data = await handler();
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[crossTeam:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

async function handleSend(
  _event: IpcMainInvokeEvent,
  request: unknown
): Promise<IpcResult<unknown>> {
  return wrapCrossTeamHandler('send', () => {
    if (!request || typeof request !== 'object') {
      throw new Error('Invalid request');
    }
    const req = request as Record<string, unknown>;
    if (req.actionMode !== undefined && !isAgentActionMode(req.actionMode)) {
      throw new Error('actionMode must be one of: do, ask, delegate');
    }
    const taskRefs = validateTaskRefs(req.taskRefs);
    if (!taskRefs.valid) {
      throw new Error(taskRefs.error);
    }
    return getService().send({
      fromTeam: String(req.fromTeam ?? ''),
      fromMember: String(req.fromMember ?? ''),
      toTeam: String(req.toTeam ?? ''),
      conversationId: typeof req.conversationId === 'string' ? req.conversationId : undefined,
      replyToConversationId:
        typeof req.replyToConversationId === 'string' ? req.replyToConversationId : undefined,
      text: String(req.text ?? ''),
      taskRefs: taskRefs.value,
      actionMode: isAgentActionMode(req.actionMode) ? req.actionMode : undefined,
      summary: typeof req.summary === 'string' ? req.summary : undefined,
      chainDepth: typeof req.chainDepth === 'number' ? req.chainDepth : undefined,
    });
  });
}

async function handleListTargets(
  _event: IpcMainInvokeEvent,
  excludeTeam?: string
): Promise<IpcResult<unknown>> {
  return wrapCrossTeamHandler('listTargets', () =>
    getService().listAvailableTargets(typeof excludeTeam === 'string' ? excludeTeam : undefined)
  );
}

async function handleGetOutbox(
  _event: IpcMainInvokeEvent,
  teamName: string
): Promise<IpcResult<unknown>> {
  return wrapCrossTeamHandler('getOutbox', () => {
    if (typeof teamName !== 'string' || !teamName.trim()) {
      throw new Error('teamName is required');
    }
    return getService().getOutbox(teamName);
  });
}

export function registerCrossTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(CROSS_TEAM_SEND, handleSend);
  ipcMain.handle(CROSS_TEAM_LIST_TARGETS, handleListTargets);
  ipcMain.handle(CROSS_TEAM_GET_OUTBOX, handleGetOutbox);
}

export function removeCrossTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CROSS_TEAM_SEND);
  ipcMain.removeHandler(CROSS_TEAM_LIST_TARGETS);
  ipcMain.removeHandler(CROSS_TEAM_GET_OUTBOX);
}
