import { listOwnedContexts } from './ownedHistory';
import { readTeamProjectContextMode } from './projectContextMode';

import type { TeamModeMetaReader } from './projectContextMode';
import type {
  PersistedTeamWorkContext,
  TeamProjectContextRegistry,
} from './TeamProjectContextRegistry';
import type { TeamProjectContextMode } from '@shared/types';

/**
 * What a team name means at an application boundary that takes names literally
 * (HTTP, MCP, directory views). The kind is decided by the team's history mode,
 * never by whether it happens to own a contexts index:
 * - `logical`: the user-visible team of the per-project mode. It has no process of
 *   its own; its runtime, tasks and chats live in its project contexts.
 * - `physical`: an ordinary team (legacy/shared); the name is the physical team and
 *   the process. A shared team that kept a project-contexts index from an earlier
 *   per-project period lists those `retained` contexts too: they may still run.
 *   `projectContextUnresolved` marks a team whose metadata is unreadable and that
 *   has no contexts index, so it can only be treated by its exact name.
 *
 * A project copy (`ptc-…` alias) is `physical` here: its name is the process, and
 * the callers that need its logical team look it up themselves. This is not
 * `TeamKind` (`classifyTeamKind`), which tells an owned copy (`alias`) from an
 * ordinary team (`native`) for edits, schedules and launch: the two answer
 * different questions, which is why they use different words.
 */
export type ResolvedTeamTarget =
  | {
      kind: 'physical';
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
    return { kind: 'physical', team: teamName, retained: [], projectContextUnresolved: true };
  }
  const contexts = await guarded(teamName, () => ports.listContexts(teamName, mode));
  if (mode === 'per_project') return { kind: 'logical', logical: teamName, contexts };
  return { kind: 'physical', team: teamName, retained: contexts };
}

/**
 * The project contexts a team has to be asked about, next to its own name: a
 * shared team with retained contexts runs under its own name, and even a logical
 * team is checked (and stopped when it somehow has a process), as the in-app Stop
 * does. `null` for a team without contexts.
 */
export interface ContextGroup {
  team: string;
  contexts: readonly PersistedTeamWorkContext[];
}

export function contextGroupOf(target: ResolvedTeamTarget): ContextGroup | null {
  if (target.kind === 'logical') return { team: target.logical, contexts: target.contexts };
  if (target.retained.length === 0) return null;
  return { team: target.team, contexts: target.retained };
}

type TargetRegistry = Pick<
  TeamProjectContextRegistry,
  'list' | 'listRetained' | 'hasRetainedIndex'
>;

/** The ports every production caller uses; tests inject fakes or a temp-dir registry. */
export function createTeamTargetPorts(
  meta: TeamModeMetaReader,
  registry: TargetRegistry
): TeamTargetPorts {
  return {
    getMode: (teamName) => readTeamProjectContextMode(meta, teamName),
    listContexts: (logicalTeamName, mode) => listOwnedContexts(registry, logicalTeamName, mode),
    hasContextsIndex: (teamName) => registry.hasRetainedIndex(teamName),
  };
}
