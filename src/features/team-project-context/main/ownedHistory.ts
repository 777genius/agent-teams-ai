import type { PersistedTeamWorkContext, TeamProjectContextRegistry } from './TeamProjectContextRegistry';
import type { TeamProjectContextMode } from '@shared/types';

/**
 * The project contexts a team owns, by the mode it was created with: a
 * per-project team always has an index (it may be empty); a shared team has
 * one only when it retained history from before. Both read through the
 * registry, which verifies ownership of every ready context.
 */
export function listOwnedContexts(
  registry: Pick<TeamProjectContextRegistry, 'list' | 'listRetained'>,
  teamName: string,
  mode: TeamProjectContextMode
): Promise<readonly PersistedTeamWorkContext[]> {
  return mode === 'per_project' ? registry.list(teamName) : registry.listRetained(teamName);
}

/**
 * Whether the name carries project history at all. A shared team without a
 * contexts index is a plain native team and nothing about it is project-scoped.
 */
export async function ownsProjectHistory(
  registry: Pick<TeamProjectContextRegistry, 'hasRetainedIndex'>,
  teamName: string,
  mode: TeamProjectContextMode
): Promise<boolean> {
  return mode === 'per_project' || registry.hasRetainedIndex(teamName);
}
