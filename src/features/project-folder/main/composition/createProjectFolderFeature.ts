import {
  registerProjectFolderIpc,
  removeProjectFolderIpc,
} from '../adapters/input/registerProjectFolderIpc';
import { ProjectFolderService } from '../application/ProjectFolderService';
import { nodeProjectFolderFileSystem } from '../infrastructure/nodeProjectFolderFileSystem';

import type { ProjectFolderFeatureFacade } from '../application/ProjectFolderFeatureFacade';
import type { ProjectFolderFileSystem } from '../application/ProjectFolderService';
import type { IpcMain } from 'electron';

export function createProjectFolderFeature(
  fileSystem: ProjectFolderFileSystem = nodeProjectFolderFileSystem
): ProjectFolderFeatureFacade {
  return new ProjectFolderService(fileSystem);
}

export function registerProjectFolderFeature(ipcMain: IpcMain): void {
  registerProjectFolderIpc(ipcMain, createProjectFolderFeature());
}

export function removeProjectFolderFeature(ipcMain: IpcMain): void {
  removeProjectFolderIpc(ipcMain);
}
