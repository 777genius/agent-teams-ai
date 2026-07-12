import {
  TEAM_IMPORT_CHOOSE_FOLDER_AND_PREVIEW,
  TEAM_IMPORT_CREATE_DRAFT,
} from '@features/team-import/contracts';
import { createLogger } from '@shared/utils/logger';

import type { TeamImportFeatureFacade } from '../../../composition/createTeamImportFeature';
import type { CreateTeamImportDraftRequest } from '@features/team-import/contracts';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:TeamImport:IPC');

function parseCreateDraftRequest(value: unknown): CreateTeamImportDraftRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid team import request.');
  }
  const request = value as Record<string, unknown>;
  if (typeof request.reviewId !== 'string' || typeof request.teamName !== 'string') {
    throw new Error('Import review and team name are required.');
  }
  return { reviewId: request.reviewId, teamName: request.teamName };
}

export function registerTeamImportIpc(ipcMain: IpcMain, feature: TeamImportFeatureFacade): void {
  ipcMain.handle(TEAM_IMPORT_CHOOSE_FOLDER_AND_PREVIEW, async () => {
    try {
      return await feature.chooseFolderAndPreview();
    } catch (error) {
      logger.error('Failed to inspect selected team folder', error);
      throw error;
    }
  });
  ipcMain.handle(TEAM_IMPORT_CREATE_DRAFT, async (_event, request: unknown) => {
    const parsedRequest = parseCreateDraftRequest(request);
    try {
      return await feature.createDraft(parsedRequest);
    } catch (error) {
      logger.error('Failed to create imported team draft', error);
      throw error;
    }
  });
}

export function removeTeamImportIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_IMPORT_CHOOSE_FOLDER_AND_PREVIEW);
  ipcMain.removeHandler(TEAM_IMPORT_CREATE_DRAFT);
}
