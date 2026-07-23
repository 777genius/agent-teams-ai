import {
  TEAM_CREATE_CONFIG,
  TEAM_DELETE_DRAFT,
  TEAM_GET_SAVED_REQUEST,
  TEAM_UPDATE_CONFIG,
} from '@features/team-configuration/contracts';

import { createTeamConfigurationIpcHandlers } from './createTeamConfigurationIpcHandlers';

import type { TeamConfigurationIpcDependencies } from './TeamConfigurationIpcDependencies';
import type { IpcMain } from 'electron';

export function registerTeamConfigurationIpc(
  ipcMain: IpcMain,
  dependencies: TeamConfigurationIpcDependencies
): void {
  const handlers = createTeamConfigurationIpcHandlers(dependencies);
  ipcMain.handle(TEAM_CREATE_CONFIG, handlers.createConfig);
  ipcMain.handle(TEAM_UPDATE_CONFIG, handlers.updateConfig);
  ipcMain.handle(TEAM_GET_SAVED_REQUEST, handlers.getSavedRequest);
  ipcMain.handle(TEAM_DELETE_DRAFT, handlers.deleteDraft);
}

export function removeTeamConfigurationIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_CREATE_CONFIG);
  ipcMain.removeHandler(TEAM_UPDATE_CONFIG);
  ipcMain.removeHandler(TEAM_GET_SAVED_REQUEST);
  ipcMain.removeHandler(TEAM_DELETE_DRAFT);
}
