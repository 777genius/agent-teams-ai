import {
  CROSS_TEAM_GET_OUTBOX,
  CROSS_TEAM_LIST_TARGETS,
  CROSS_TEAM_SEND,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import type { CrossTeamService } from '../services/team/CrossTeamService';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { IpcResult } from '@shared/types';

const logger = createLogger('IPC:crossTeam');

let crossTeamService: CrossTeamService | null = null;

export function initializeCrossTeamHandlers(service: CrossTeamService): void {
  crossTeamService = service;
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
    return getService().send({
      fromTeam: String(req.fromTeam ?? ''),
      fromMember: String(req.fromMember ?? ''),
      toTeam: String(req.toTeam ?? ''),
      text: String(req.text ?? ''),
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
