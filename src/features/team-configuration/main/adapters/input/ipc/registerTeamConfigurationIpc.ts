import {
  TEAM_CREATE_CONFIG,
  TEAM_DELETE_DRAFT,
  TEAM_GET_SAVED_REQUEST,
  TEAM_UPDATE_CONFIG,
} from '@features/team-configuration/contracts';

import { createTeamConfigurationIpcHandlers } from './createTeamConfigurationIpcHandlers';

import type {
  TeamConfigurationFeature,
  TeamConfigurationIpcHost,
  TeamConfigurationIpcRegistrar,
} from '../../../composition/TeamConfigurationIpcBoundary';

export function registerTeamConfigurationIpc(
  ipcMain: TeamConfigurationIpcRegistrar,
  dependencies: TeamConfigurationFeature,
  host?: TeamConfigurationIpcHost
): void {
  const handlers = createTeamConfigurationIpcHandlers(dependencies, host);
  ipcMain.handle(TEAM_CREATE_CONFIG, handlers.createConfig);
  ipcMain.handle(TEAM_UPDATE_CONFIG, handlers.updateConfig);
  ipcMain.handle(TEAM_GET_SAVED_REQUEST, handlers.getSavedRequest);
  ipcMain.handle(TEAM_DELETE_DRAFT, handlers.deleteDraft);
}

export function removeTeamConfigurationIpc(ipcMain: TeamConfigurationIpcRegistrar): void {
  ipcMain.removeHandler(TEAM_CREATE_CONFIG);
  ipcMain.removeHandler(TEAM_UPDATE_CONFIG);
  ipcMain.removeHandler(TEAM_GET_SAVED_REQUEST);
  ipcMain.removeHandler(TEAM_DELETE_DRAFT);
}
