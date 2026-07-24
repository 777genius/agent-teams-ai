import {
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_LAUNCH,
  TEAM_LAUNCH_FAILURE_DIAGNOSTICS,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROVISIONING_STATUS,
  TEAM_VALIDATE_CLI_ARGS,
} from '../../../../contracts';

import { createTeamProvisioningIpcHandlers } from './createTeamProvisioningIpcHandlers';

import type { TeamProvisioningFeature } from '../../../composition/createTeamProvisioningFeature';
import type { IpcMain } from 'electron';

export function registerTeamProvisioningIpc(
  ipcMain: IpcMain,
  feature: TeamProvisioningFeature
): void {
  const handlers = createTeamProvisioningIpcHandlers(feature);
  ipcMain.handle(TEAM_CREATE, handlers.create.bind(handlers));
  ipcMain.handle(TEAM_LAUNCH, handlers.launch.bind(handlers));
  ipcMain.handle(TEAM_VALIDATE_CLI_ARGS, handlers.validateCliArgs.bind(handlers));
  ipcMain.handle(TEAM_PREPARE_PROVISIONING, handlers.prepare.bind(handlers));
  ipcMain.handle(TEAM_PROVISIONING_STATUS, handlers.status.bind(handlers));
  ipcMain.handle(TEAM_LAUNCH_FAILURE_DIAGNOSTICS, handlers.launchDiagnostics.bind(handlers));
  ipcMain.handle(TEAM_CANCEL_PROVISIONING, handlers.cancel.bind(handlers));
}

export function removeTeamProvisioningIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_CREATE);
  ipcMain.removeHandler(TEAM_LAUNCH);
  ipcMain.removeHandler(TEAM_VALIDATE_CLI_ARGS);
  ipcMain.removeHandler(TEAM_PREPARE_PROVISIONING);
  ipcMain.removeHandler(TEAM_PROVISIONING_STATUS);
  ipcMain.removeHandler(TEAM_LAUNCH_FAILURE_DIAGNOSTICS);
  ipcMain.removeHandler(TEAM_CANCEL_PROVISIONING);
}
