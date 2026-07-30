import path from 'node:path';

import { createLogger } from '@shared/utils/logger';

import { WORKSPACE_TRUST_GET_PROJECT_STATUS } from '../../../contracts';

import type { WorkspaceTrustStatusFeatureFacade } from '../../composition/createWorkspaceTrustStatusFeature';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:WorkspaceTrust:IPC');
const MAX_PROJECT_PATH_LENGTH = 4096;

function readProjectPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const projectPath = (input as { projectPath?: unknown }).projectPath;
  if (typeof projectPath !== 'string') {
    return null;
  }
  const normalized = projectPath.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PROJECT_PATH_LENGTH ||
    !path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function registerWorkspaceTrustIpc(
  ipcMain: IpcMain,
  feature: WorkspaceTrustStatusFeatureFacade
): void {
  ipcMain.handle(WORKSPACE_TRUST_GET_PROJECT_STATUS, async (_event, input: unknown) => {
    const projectPath = readProjectPath(input);
    if (!projectPath) {
      return { status: 'unknown' };
    }
    try {
      return await feature.getProjectStatus({ projectPath });
    } catch (error) {
      logger.warn(
        `Failed to read workspace trust status: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { status: 'unknown' };
    }
  });
}

export function removeWorkspaceTrustIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(WORKSPACE_TRUST_GET_PROJECT_STATUS);
}
