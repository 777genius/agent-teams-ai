import {
  registerTeamRuntimeOperationsIpc as registerRuntimeOperationsIpc,
  removeTeamRuntimeOperationsIpc as removeRuntimeOperationsIpc,
} from '../adapters/input/ipc/registerTeamRuntimeOperationsIpc';

import type { TeamRuntimeOperationsFeature } from './createTeamRuntimeOperationsFeature';

export interface TeamRuntimeOperationsIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export type TeamRuntimeOperationsIpcEvent = unknown;

export function registerTeamRuntimeOperationsIpc(
  ipcMain: TeamRuntimeOperationsIpcRegistrar,
  feature: TeamRuntimeOperationsFeature
): void {
  registerRuntimeOperationsIpc(ipcMain, feature);
}

export function removeTeamRuntimeOperationsIpc(ipcMain: TeamRuntimeOperationsIpcRegistrar): void {
  removeRuntimeOperationsIpc(ipcMain);
}
