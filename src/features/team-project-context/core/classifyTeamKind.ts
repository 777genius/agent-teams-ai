import type { TeamKind, TeamProjectContextMode } from '../contracts';

export interface TeamKindPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  isOwnedExecutionAlias(teamName: string): Promise<boolean>;
}

/**
 * The single classification of a team name. It fails closed: unreadable
 * metadata is not proof that a team is an ordinary one, so the error is
 * propagated and the caller refuses the request.
 */
export async function classifyTeamKind(ports: TeamKindPorts, teamName: string): Promise<TeamKind> {
  if ((await ports.getMode(teamName)) === 'per_project') return 'logical';
  return (await ports.isOwnedExecutionAlias(teamName)) ? 'alias' : 'native';
}

/** The one way to build the ports: callers hold the mode reader and the alias lookup separately. */
export function createTeamKindPorts(
  mode: Pick<TeamKindPorts, 'getMode'>,
  aliases: Pick<TeamKindPorts, 'isOwnedExecutionAlias'>
): TeamKindPorts {
  return {
    getMode: (teamName) => mode.getMode(teamName),
    isOwnedExecutionAlias: (teamName) => aliases.isOwnedExecutionAlias(teamName),
  };
}
