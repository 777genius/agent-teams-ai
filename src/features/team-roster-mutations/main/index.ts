import {
  registerTeamRosterMutationIpc as registerRosterMutationIpc,
  removeTeamRosterMutationIpc as removeRosterMutationIpc,
} from './adapters/input/ipc/registerTeamRosterMutationIpc';

import type { TeamRosterMutationFeature } from './composition/createTeamRosterMutationFeature';

export interface TeamRosterMutationIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export function registerTeamRosterMutationIpc(
  ipcMain: TeamRosterMutationIpcRegistrar,
  feature: TeamRosterMutationFeature
): void {
  registerRosterMutationIpc(
    ipcMain as unknown as Parameters<typeof registerRosterMutationIpc>[0],
    feature
  );
}

export function removeTeamRosterMutationIpc(ipcMain: TeamRosterMutationIpcRegistrar): void {
  removeRosterMutationIpc(ipcMain as unknown as Parameters<typeof removeRosterMutationIpc>[0]);
}

export {
  createTeamRosterMutationFeature,
  type TeamRosterMutationFeature,
} from './composition/createTeamRosterMutationFeature';
export {
  createTeamRosterPersistenceRepository,
  type TeamRosterPersistenceRepositoryPort,
} from './composition/createTeamRosterPersistenceRepository';
