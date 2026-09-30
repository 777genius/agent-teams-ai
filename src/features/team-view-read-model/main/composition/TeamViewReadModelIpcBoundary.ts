import {
  registerTeamViewReadModelIpc as registerViewReadModelIpc,
  removeTeamViewReadModelIpc as removeViewReadModelIpc,
} from '../adapters/input/ipc/registerTeamViewReadModelIpc';

import type { TeamViewReadResult } from '../../core/application/ports/TeamViewReadModelPorts';
import type { MessagesPage, TeamGetDataOptions, TeamMemberActivityMeta } from '@shared/types';

export interface TeamViewReadModelFeature {
  getTeamView: {
    execute(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewReadResult>;
  };
  getMessagesPage: {
    execute(input: {
      teamName: string;
      cursor?: string | null;
      limit: number;
    }): Promise<MessagesPage>;
  };
  getMemberActivityMeta: {
    execute(teamName: string): Promise<TeamMemberActivityMeta>;
  };
  logger: {
    error(message: string): void;
  };
}

export interface TeamViewReadModelIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

// eslint-disable-next-line sonarjs/redundant-type-aliases -- Named IPC boundary contract intentionally remains Electron-free.
export type TeamViewReadModelIpcEvent = unknown;

export function registerTeamViewReadModelIpc(
  ipcMain: TeamViewReadModelIpcRegistrar,
  feature: TeamViewReadModelFeature
): void {
  registerViewReadModelIpc(ipcMain, feature);
}

export function removeTeamViewReadModelIpc(ipcMain: TeamViewReadModelIpcRegistrar): void {
  removeViewReadModelIpc(ipcMain);
}
