import {
  registerTeamRosterMutationIpc as registerRosterMutationIpc,
  removeTeamRosterMutationIpc as removeRosterMutationIpc,
} from '../adapters/input/ipc/registerTeamRosterMutationIpc';

import type { TeamRosterMutationFeature } from './createTeamRosterMutationFeature';

export interface TeamRosterMutationIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export function registerTeamRosterMutationIpc(
  ipcMain: TeamRosterMutationIpcRegistrar,
  feature: TeamRosterMutationFeature
): void {
  registerRosterMutationIpc(ipcMain, feature);
}

export function removeTeamRosterMutationIpc(ipcMain: TeamRosterMutationIpcRegistrar): void {
  removeRosterMutationIpc(ipcMain);
}
