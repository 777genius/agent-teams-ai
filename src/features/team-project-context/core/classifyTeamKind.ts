import type { TeamProjectContextMode } from '../contracts';

/**
 * What a team name is, for every caller that must treat the kinds differently
 * (definition edits, schedules, launch):
 * - `logical`: the user-visible team of the per-project mode; its definition is the only authority.
 * - `alias`: a native project copy; a projection, never edited or launched directly.
 * - `native`: any other team (legacy/shared); unchanged behavior.
 */
export type TeamKind = 'logical' | 'alias' | 'native';

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
