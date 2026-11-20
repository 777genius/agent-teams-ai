import { TeamProjectContextRuntimeResolver } from './TeamProjectContextRuntimeResolver';

import type {
  PersistedTeamWorkContext,
  TeamProjectContextRegistry,
} from './TeamProjectContextRegistry';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamProjectContextMode } from '@shared/types';

/**
 * What a team name means at an application boundary that takes names literally
 * (HTTP, MCP, scheduler, directory views):
 * - `native`: an ordinary team (legacy/shared); the name is the physical team.
 * - `logical`: the user-visible team of the per-project mode. It has no process of
 *   its own; its runtime, tasks and chats live in its project contexts.
 * - `alias`: one native project copy of a logical team.
 */
export type ResolvedTeamTarget =
  | { kind: 'native'; team: string }
  | { kind: 'logical'; logical: string; contexts: readonly PersistedTeamWorkContext[] }
  | { kind: 'alias'; alias: string; logical: string; context: PersistedTeamWorkContext };

export interface TeamTargetPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  /** Owned project contexts of a logical team; rejects when ownership cannot be proven. */
  listContexts(
    logicalTeamName: string,
    mode: TeamProjectContextMode
  ): Promise<readonly PersistedTeamWorkContext[]>;
  resolveOwnedAlias(
    teamName: string
  ): Promise<{ logicalTeamName: string; context: PersistedTeamWorkContext } | null>;
}

/**
 * The name cannot be classified (unreadable metadata, unproven ownership, an
 * ambiguous alias). Callers must refuse: treating an unknown team as an
 * ordinary one is what makes a stop or a read silently wrong.
 */
export class TeamTargetUnresolvedError extends Error {
  readonly code = 'TEAM_TARGET_UNRESOLVED';
  /** Understood by the HTTP error mapping. */
  readonly statusCode = 409;

  constructor(teamName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot resolve the project contexts of team "${teamName}": ${reason}`);
    this.name = 'TeamTargetUnresolvedError';
  }
}

async function guarded<T>(teamName: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new TeamTargetUnresolvedError(teamName, error);
  }
}

export async function resolveTeamTarget(
  ports: TeamTargetPorts,
  teamName: string
): Promise<ResolvedTeamTarget> {
  const mode = await guarded(teamName, () => ports.getMode(teamName));
  if (mode === 'per_project') {
    const contexts = await guarded(teamName, () => ports.listContexts(teamName, mode));
    return { kind: 'logical', logical: teamName, contexts };
  }
  const alias = await guarded(teamName, () => ports.resolveOwnedAlias(teamName));
  if (alias) {
    return { kind: 'alias', alias: teamName, logical: alias.logicalTeamName, context: alias.context };
  }
  // A shared team with a project-contexts index owns verified contexts too.
  const retained = await guarded(teamName, () => ports.listContexts(teamName, mode));
  if (retained.length > 0) return { kind: 'logical', logical: teamName, contexts: retained };
  return { kind: 'native', team: teamName };
}

interface TeamMetaReader {
  getMeta(teamName: string): Promise<TeamMetaFile | null>;
  metadataFileExists(teamName: string): Promise<boolean>;
}

type TargetRegistry = Pick<
  TeamProjectContextRegistry,
  | 'find'
  | 'reserve'
  | 'confirmReady'
  | 'releaseUnusedReservation'
  | 'list'
  | 'listRetained'
  | 'resolveOwnedExecutionAlias'
>;

/** The ports every production caller uses; tests inject fakes or a temp-dir registry. */
export function createTeamTargetPorts(
  meta: TeamMetaReader,
  registry: TargetRegistry
): TeamTargetPorts {
  const resolver = new TeamProjectContextRuntimeResolver(meta, registry);
  return {
    getMode: (teamName) => resolver.getMode(teamName),
    listContexts: (logicalTeamName, mode) =>
      mode === 'per_project' ? registry.list(logicalTeamName) : registry.listRetained(logicalTeamName),
    resolveOwnedAlias: (teamName) => registry.resolveOwnedExecutionAlias(teamName),
  };
}
