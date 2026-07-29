import { TeamLifecycleIpcFacade } from './TeamLifecycleIpcFacade';

import type {
  TeamLifecycleAtomicCommandPort,
  TeamLifecycleIpcHandlerPort,
  TeamLifecycleIpcLoggerPort,
  TeamLifecycleIpcRegistrar,
  TeamLifecycleTeamNameValidator,
} from '../../../../core/application/ports/TeamLifecycleIpcPorts';

const TEAM_DELETE_TEAM_CHANNEL = 'team:deleteTeam';
const TEAM_RESTORE_CHANNEL = 'team:restoreTeam';
const TEAM_PERMANENTLY_DELETE_CHANNEL = 'team:permanentlyDeleteTeam';

export function createTeamLifecycleIpcFacade(dependencies: {
  commands: TeamLifecycleAtomicCommandPort;
  logger: TeamLifecycleIpcLoggerPort;
  validateTeamName: TeamLifecycleTeamNameValidator;
}): TeamLifecycleIpcHandlerPort {
  return Object.freeze(new TeamLifecycleIpcFacade(dependencies));
}

export function registerTeamLifecycleIpcAdapter(
  ipcMain: Pick<TeamLifecycleIpcRegistrar, 'handle'>,
  facade: TeamLifecycleIpcHandlerPort
): void {
  ipcMain.handle(TEAM_DELETE_TEAM_CHANNEL, (event, teamName) => facade.deleteTeam(event, teamName));
  ipcMain.handle(TEAM_RESTORE_CHANNEL, (event, teamName) => facade.restoreTeam(event, teamName));
  ipcMain.handle(TEAM_PERMANENTLY_DELETE_CHANNEL, (event, teamName) =>
    facade.permanentlyDeleteTeam(event, teamName)
  );
}

export function removeTeamLifecycleIpcAdapter(
  ipcMain: Pick<TeamLifecycleIpcRegistrar, 'removeHandler'>
): void {
  ipcMain.removeHandler(TEAM_DELETE_TEAM_CHANNEL);
  ipcMain.removeHandler(TEAM_RESTORE_CHANNEL);
  ipcMain.removeHandler(TEAM_PERMANENTLY_DELETE_CHANNEL);
}
