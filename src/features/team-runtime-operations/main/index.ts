import {
  registerTeamRuntimeOperationsIpc as registerRuntimeOperationsIpc,
  removeTeamRuntimeOperationsIpc as removeRuntimeOperationsIpc,
} from './adapters/input/ipc/registerTeamRuntimeOperationsIpc';

import type { TeamRuntimeOperationsFeature } from './composition/createTeamRuntimeOperationsFeature';

export interface TeamRuntimeOperationsIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export function registerTeamRuntimeOperationsIpc(
  ipcMain: TeamRuntimeOperationsIpcRegistrar,
  feature: TeamRuntimeOperationsFeature
): void {
  registerRuntimeOperationsIpc(
    ipcMain as unknown as Parameters<typeof registerRuntimeOperationsIpc>[0],
    feature
  );
}

export function removeTeamRuntimeOperationsIpc(ipcMain: TeamRuntimeOperationsIpcRegistrar): void {
  removeRuntimeOperationsIpc(
    ipcMain as unknown as Parameters<typeof removeRuntimeOperationsIpc>[0]
  );
}

export { createTeamRuntimeLifecycleHostPort } from './composition/createTeamRuntimeLifecycleHostPort';
export {
  createTeamRuntimeOperationsFeature,
  type TeamRuntimeOperationsFeature,
} from './composition/createTeamRuntimeOperationsFeature';
export type { TeamRuntimeOperationsHostPorts } from './composition/TeamRuntimeOperationsHostPorts';
