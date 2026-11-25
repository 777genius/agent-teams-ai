import { createLogger } from '@shared/utils/logger';

import {
  REVIEW_FLOW_GET_OVERVIEW,
  REVIEW_FLOW_SET_DEFAULTS,
  REVIEW_FLOW_SET_TEAM_OVERRIDE,
  type ReviewFlowIpcResult,
} from '../../../contracts';
import { type ReviewFlowService,ReviewFlowValidationError } from '../../../core/application';

import type { IpcMain } from 'electron';

const logger = createLogger('Feature:ReviewFlow:IPC');

async function toResult<T>(operation: () => Promise<T>): Promise<ReviewFlowIpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ReviewFlowValidationError)) {
      logger.error('Review flow request failed', error);
    }
    return { ok: false, error: message };
  }
}

export function registerReviewFlowIpc(ipcMain: IpcMain, service: ReviewFlowService): void {
  ipcMain.handle(REVIEW_FLOW_GET_OVERVIEW, () => toResult(() => service.getOverview()));
  ipcMain.handle(REVIEW_FLOW_SET_DEFAULTS, (_event, settings: unknown) =>
    toResult(() => service.saveDefaults(settings))
  );
  ipcMain.handle(REVIEW_FLOW_SET_TEAM_OVERRIDE, (_event, teamName: unknown, settings: unknown) =>
    toResult(() => service.saveTeamOverride(teamName as string, settings))
  );
}

export function removeReviewFlowIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(REVIEW_FLOW_GET_OVERVIEW);
  ipcMain.removeHandler(REVIEW_FLOW_SET_DEFAULTS);
  ipcMain.removeHandler(REVIEW_FLOW_SET_TEAM_OVERRIDE);
}
