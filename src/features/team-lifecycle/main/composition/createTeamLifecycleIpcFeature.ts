import {
  createTeamLifecycleIpcFacade,
  registerTeamLifecycleIpcAdapter,
  removeTeamLifecycleIpcAdapter,
} from '../adapters/input/ipc/createTeamLifecycleIpcFacade';

import type {
  TeamLifecycleAtomicCommandPort,
  TeamLifecycleIpcHandlerPort,
  TeamLifecycleIpcLoggerPort,
  TeamLifecycleIpcRegistrar,
  TeamLifecycleTeamNameValidator,
} from '../../core/application/ports/TeamLifecycleIpcPorts';

export type TeamLifecycleIpcFeature = TeamLifecycleIpcHandlerPort;

export type TeamLifecycleIpcFeatureDependencies = Readonly<{
  commands: TeamLifecycleAtomicCommandPort;
  logger: TeamLifecycleIpcLoggerPort;
  validateTeamName: TeamLifecycleTeamNameValidator;
}>;

export function createTeamLifecycleIpcFeature(
  dependencies: TeamLifecycleIpcFeatureDependencies
): TeamLifecycleIpcFeature {
  return createTeamLifecycleIpcFacade(dependencies);
}

export function registerTeamLifecycleIpc(
  ipcMain: Pick<TeamLifecycleIpcRegistrar, 'handle'>,
  feature: TeamLifecycleIpcFeature
): void {
  registerTeamLifecycleIpcAdapter(ipcMain, feature);
}

export function removeTeamLifecycleIpc(
  ipcMain: Pick<TeamLifecycleIpcRegistrar, 'removeHandler'>
): void {
  removeTeamLifecycleIpcAdapter(ipcMain);
}
