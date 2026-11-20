import { TeamProjectContextRuntimeResolver } from './TeamProjectContextRuntimeResolver';

import type {
  PersistedTeamWorkContext,
  TeamProjectContextRegistry,
} from './TeamProjectContextRegistry';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamProjectContextMode } from '@shared/types';

/**
 * What a team name means at an application boundary that takes names literally
 * (HTTP, MCP, directory views). The kind is decided by the team's history mode,
 * never by whether it happens to own a contexts index:
 * - `logical`: the user-visible team of the per-project mode. It has no process of
 *   its own; its runtime, tasks and chats live in its project contexts.
 * - `native`: an ordinary team (legacy/shared); the name is the physical team and
 *   the process. A shared team that kept a project-contexts index from an earlier
 *   per-project period lists those `retained` contexts too: they may still run.
 *   `projectContextUnresolved` marks a team whose metadata is unreadable and that
 *   has no contexts index, so it can only be treated by its exact name.
 *
 * A project copy (`ptc-…` alias) is an ordinary native team here: its name is
 * physical, and the callers that need its logical team look it up themselves.
 */
export type ResolvedTeamTarget =
  | {
      kind: 'native';
      team: string;
      retained: readonly PersistedTeamWorkContext[];
      projectContextUnresolved?: true;
    }
  | { kind: 'logical'; logical: string; contexts: readonly PersistedTeamWorkContext[] };

export interface TeamTargetPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  /** Owned project contexts of a team; rejects when ownership cannot be proven. */
  listContexts(
    logicalTeamName: string,
    mode: TeamProjectContextMode
  ): Promise<readonly PersistedTeamWorkContext[]>;
  /** Whether the team has a project-contexts index on disk (cheap, no ownership proof). */
  hasContextsIndex(teamName: string): Promise<boolean>;
}

/**
 * The name cannot be classified (unreadable metadata of a team that owns project
 * contexts, or unproven context ownership). Callers must refuse: treating an
 * unknown team as an ordinary one is what makes a stop or a read silently wrong.
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
  let mode: TeamProjectContextMode;
  try {
    mode = await ports.getMode(teamName);
  } catch (error) {
    // Unreadable metadata only matters for a team that owns project contexts.
    // Without a contexts index the exact name is the only team there is, which
    // is what every caller did before project contexts existed.
    if (await guarded(teamName, () => ports.hasContextsIndex(teamName))) {
      throw new TeamTargetUnresolvedError(teamName, error);
    }
    return { kind: 'native', team: teamName, retained: [], projectContextUnresolved: true };
  }
  const contexts = await guarded(teamName, () => ports.listContexts(teamName, mode));
  if (mode === 'per_project') return { kind: 'logical', logical: teamName, contexts };
  return { kind: 'native', team: teamName, retained: contexts };
}

/**
 * The project contexts a team has to be asked about, and whether the team's own
 * name hosts a process too. `null` for a team without contexts.
 */
export interface ContextGroup {
  team: string;
  contexts: readonly PersistedTeamWorkContext[];
  /** A shared team with retained contexts runs under its own name as well. */
  ownRuntime: boolean;
}

export function contextGroupOf(target: ResolvedTeamTarget): ContextGroup | null {
  if (target.kind === 'logical') {
    return { team: target.logical, contexts: target.contexts, ownRuntime: false };
  }
  if (target.retained.length === 0) return null;
  return { team: target.team, contexts: target.retained, ownRuntime: true };
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
  | 'hasRetainedIndex'
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
    hasContextsIndex: (teamName) => registry.hasRetainedIndex(teamName),
  };
}
