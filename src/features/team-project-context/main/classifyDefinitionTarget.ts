import type { TeamProjectContextMode } from '@shared/types';

/**
 * How a request that edits a team definition must be handled:
 * - `logical`: the user-visible team of the per-project mode; its definition is the only authority.
 * - `alias`: a native project copy; a projection, never edited directly.
 * - `native`: any other team (legacy/shared); unchanged behavior.
 */
export type DefinitionEditTarget = 'logical' | 'alias' | 'native';

export interface DefinitionTargetPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  isOwnedExecutionAlias(teamName: string): Promise<boolean>;
}

/**
 * The single classification every definition writer uses (desktop IPC, HTTP).
 * It fails closed: unreadable metadata is not proof that a team is an
 * ordinary one, so the error is propagated and the caller refuses the write.
 */
export async function classifyDefinitionTarget(
  ports: DefinitionTargetPorts,
  teamName: string
): Promise<DefinitionEditTarget> {
  if ((await ports.getMode(teamName)) === 'per_project') return 'logical';
  return (await ports.isOwnedExecutionAlias(teamName)) ? 'alias' : 'native';
}
