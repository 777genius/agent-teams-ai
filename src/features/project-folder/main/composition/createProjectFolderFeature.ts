import { registerProjectFolderIpc } from '../adapters/input/registerProjectFolderIpc';
import { ProjectFolderService } from '../application/ProjectFolderService';
import { nodeProjectFolderFileSystem } from '../infrastructure/nodeProjectFolderFileSystem';

import type { ProjectFolderFileSystem } from '../application/ProjectFolderService';
import type { IpcMain } from 'electron';

export type ProjectFolderFeatureFacade = Pick<ProjectFolderService, 'getState' | 'create'>;

export function createProjectFolderFeature(
  fileSystem: ProjectFolderFileSystem = nodeProjectFolderFileSystem
): ProjectFolderFeatureFacade {
  return new ProjectFolderService(fileSystem);
}

export function registerProjectFolderFeature(ipcMain: IpcMain): void {
  registerProjectFolderIpc(ipcMain, createProjectFolderFeature());
}
