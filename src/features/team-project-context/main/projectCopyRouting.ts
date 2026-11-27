import { getErrorMessage } from '@shared/utils/errorHandling';

import { listOwnedContexts } from './ownedHistory';
import { readTeamProjectContextMode, TeamMetadataUnreadableError } from './projectContextMode';

import type { TeamModeMetaReader } from './projectContextMode';
import type {
  OwnedExecutionAlias,
  OwnedExecutionAliasLookup,
  PersistedTeamWorkContext,
  TeamProjectContextRegistry,
} from './TeamProjectContextRegistry';
import type { TeamProjectContextMode } from '@shared/types';

/**
 * What routing a team name to a project copy reads: one set of ports for every consumer
 * (cross-team delivery, the board of the MCP tools). Read-only; nothing here creates a copy.
 */
export interface ProjectCopyPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  /** The context of a team for one project, a pending one included. Never creates one. */
  inspectContext(
    logicalTeamName: string,
    projectPath: string
  ): Promise<PersistedTeamWorkContext | null>;
  /** Which of the names are project copies, and of which team (one scan for all). */
  findCopyOwners(teamNames: readonly string[]): Promise<Map<string, OwnedExecutionAliasLookup>>;
  /** Every context a per-project team owns. */
  listContexts(logicalTeamName: string): Promise<readonly PersistedTeamWorkContext[]>;
  /**
   * Whether a pending copy is being launched (`createProjectLaunchProbe`). Without it a pending
   * copy cannot be told from one whose launch failed, and reads as being launched.
   */
  isLaunching?(executionTeamName: string): boolean;
}

/** A refusal of project-context routing: HTTP answers 409 with `code`, the text says what to do. */
export class ProjectContextRefusalError<Code extends string = string> extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: Code,
    message: string
  ) {
    super(message);
  }
}

export type ProjectCopyRefusal =
  | 'NO_PROJECT_HISTORY'
  | 'PROJECT_LAUNCH_PENDING'
  | 'PROJECT_LAUNCH_INCOMPLETE'
  | 'UNRESOLVED';

/** Why the history of a team in a project cannot be used now; a consumer adds what to do. */
export class ProjectCopyUnavailableError extends ProjectContextRefusalError<ProjectCopyRefusal> {
  override name = 'ProjectCopyUnavailableError';
}

/**
 * The history mode of a team. Unreadable metadata keeps its own error (and code,
 * `TEAM_METADATA_UNREADABLE`); any other failure is a refusal, not a guess.
 */
export async function projectContextModeOf(
  ports: Pick<ProjectCopyPorts, 'getMode'>,
  teamName: string
): Promise<TeamProjectContextMode> {
  try {
    return await ports.getMode(teamName);
  } catch (error) {
    if (error instanceof TeamMetadataUnreadableError) throw error;
    throw new ProjectCopyUnavailableError(
      'UNRESOLVED',
      `Cannot read how team "${teamName}" keeps its history: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Which of the names are owned project copies (one scan for all). Deliberately fail-closed: a
 * damaged contexts index of any per-project team refuses, because an unproven owner could be the
 * caller's own team. Names not shaped like a copy are never scanned.
 */
export async function findProjectCopyOwners(
  ports: Pick<ProjectCopyPorts, 'findCopyOwners'>,
  teamNames: readonly string[]
): Promise<(teamName: string) => OwnedExecutionAlias | null> {
  let owners: Map<string, OwnedExecutionAliasLookup>;
  try {
    owners = await ports.findCopyOwners(teamNames);
  } catch (error) {
    throw new ProjectCopyUnavailableError(
      'UNRESOLVED',
      `Cannot tell which teams are project copies: ${getErrorMessage(error)}`
    );
  }
  return (teamName) => {
    const lookup = owners.get(teamName);
    if (lookup && 'error' in lookup) {
      throw new ProjectCopyUnavailableError(
        'UNRESOLVED',
        `Cannot tell whether "${teamName}" is a project copy: ${lookup.error.message}`
      );
    }
    return lookup?.alias ?? null;
  };
}

/**
 * The context of a team for one project, read-only (a pending one included). An index that cannot
 * be used (damaged, being deleted, the team in the trash) is `UNRESOLVED`; `unresolved` lets a
 * consumer say what it could not do, the reason is appended.
 */
export async function inspectProjectCopy(
  ports: Pick<ProjectCopyPorts, 'inspectContext'>,
  logicalTeamName: string,
  projectPath: string,
  unresolved = `Cannot find the history of team "${logicalTeamName}" in project ${projectPath}`
): Promise<PersistedTeamWorkContext | null> {
  try {
    return await ports.inspectContext(logicalTeamName, projectPath);
  } catch (error) {
    throw new ProjectCopyUnavailableError('UNRESOLVED', `${unresolved}: ${getErrorMessage(error)}`);
  }
}

/**
 * Whether the context read by `inspectProjectCopy` can be used now: only a ready copy.
 *
 * - No context for the project: `NO_PROJECT_HISTORY`.
 * - A `reserved` context: `PROJECT_LAUNCH_PENDING` while a launch of it runs (`isLaunching`, or
 *   when that cannot be told), else `PROJECT_LAUNCH_INCOMPLETE` (a launch failed or was
 *   interrupted: waiting does not help, launching again in that project does).
 */
export function assertReadyProjectCopy(
  ports: Pick<ProjectCopyPorts, 'isLaunching'>,
  logicalTeamName: string,
  projectPath: string,
  context: PersistedTeamWorkContext | null
): PersistedTeamWorkContext {
  if (!context) {
    throw new ProjectCopyUnavailableError(
      'NO_PROJECT_HISTORY',
      `Team "${logicalTeamName}" has no history in project ${projectPath} yet.`
    );
  }
  if (context.state === 'ready') return context;
  if (!ports.isLaunching || ports.isLaunching(context.executionTeamName)) {
    throw new ProjectCopyUnavailableError(
      'PROJECT_LAUNCH_PENDING',
      `Team "${logicalTeamName}" is being launched in project ${projectPath}.`
    );
  }
  throw new ProjectCopyUnavailableError(
    'PROJECT_LAUNCH_INCOMPLETE',
    `The launch of team "${logicalTeamName}" in project ${projectPath} did not finish.`
  );
}

/**
 * The one rule for the copy that holds the history of a per-project team in a project: only a
 * ready copy, never another project's and never a new one (`inspectProjectCopy`, then
 * `assertReadyProjectCopy`).
 */
export async function resolveReadyProjectCopy(
  ports: Pick<ProjectCopyPorts, 'inspectContext' | 'isLaunching'>,
  logicalTeamName: string,
  projectPath: string
): Promise<PersistedTeamWorkContext> {
  const context = await inspectProjectCopy(ports, logicalTeamName, projectPath);
  return assertReadyProjectCopy(ports, logicalTeamName, projectPath, context);
}

/**
 * Runs `operation` and turns a refusal of `resolveReadyProjectCopy` into the consumer's own
 * error: the same code, the state, then the consumer's next step for that code.
 */
export async function withProjectCopyRefusal<T>(
  operation: () => Promise<T>,
  nextStep: Record<ProjectCopyRefusal, string>,
  refuse: (code: ProjectCopyRefusal, message: string) => Error
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ProjectCopyUnavailableError)) throw error;
    const step = nextStep[error.code];
    throw refuse(error.code, step ? `${error.message} ${step}` : error.message);
  }
}

type CopyRegistry = Pick<
  TeamProjectContextRegistry,
  'inspect' | 'list' | 'listRetained' | 'resolveOwnedExecutionAliases'
>;

/** The ports over any metadata store and registry; tests inject a temp-dir registry. */
export function createProjectCopyPorts(
  meta: TeamModeMetaReader,
  registry: CopyRegistry,
  options: { unreadableMessage: string; isLaunching?: (executionTeamName: string) => boolean }
): ProjectCopyPorts {
  return {
    getMode: (teamName) => readTeamProjectContextMode(meta, teamName, options.unreadableMessage),
    inspectContext: (logicalTeamName, projectPath) =>
      registry.inspect(logicalTeamName, projectPath),
    findCopyOwners: (teamNames) => registry.resolveOwnedExecutionAliases(teamNames),
    listContexts: (logicalTeamName) => listOwnedContexts(registry, logicalTeamName, 'per_project'),
    ...(options.isLaunching ? { isLaunching: options.isLaunching } : {}),
  };
}
