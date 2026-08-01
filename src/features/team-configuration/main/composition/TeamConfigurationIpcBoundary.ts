import {
  registerTeamConfigurationIpc as registerConfigurationIpc,
  removeTeamConfigurationIpc as removeConfigurationIpc,
} from '../adapters/input/ipc/registerTeamConfigurationIpc';

import type { TeamConfigurationLoggerPort } from '../../core/application/ports/TeamConfigurationPorts';
import type { TeamConfig, TeamCreateConfigRequest, TeamCreateRequest } from '@shared/types';

export interface TeamConfigurationFeature {
  createConfig: { execute(request: TeamCreateConfigRequest): Promise<void> };
  updateConfig: {
    execute(
      teamName: string,
      updates: { name?: string; description?: string; color?: string }
    ): Promise<TeamConfig>;
  };
  getSavedRequest: { execute(teamName: string): Promise<TeamCreateRequest | null> };
  deleteDraft: { execute(teamName: string): Promise<void> };
  logger: TeamConfigurationLoggerPort;
}

export interface TeamConfigurationIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export function registerTeamConfigurationIpc(
  ipcMain: TeamConfigurationIpcRegistrar,
  feature: TeamConfigurationFeature
): void {
  registerConfigurationIpc(ipcMain, feature);
}

export function removeTeamConfigurationIpc(ipcMain: TeamConfigurationIpcRegistrar): void {
  removeConfigurationIpc(ipcMain);
}
