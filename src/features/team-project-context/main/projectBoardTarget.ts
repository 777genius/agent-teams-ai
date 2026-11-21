import { listOwnedContexts } from './ownedHistory';
import { readTeamProjectContextMode } from './projectContextMode';

import type { TeamModeMetaReader } from './projectContextMode';
import type {
  PersistedTeamWorkContext,
  TeamProjectContextRegistry,
} from './TeamProjectContextRegistry';
import type { TeamProjectContextMode } from '@shared/types';

const UNREADABLE_MESSAGE = 'Team metadata is unreadable; refusing to choose the board of a project';

export interface ProjectBoardPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  /** The context of a team for one project, a pending one included. Never creates one. */
  inspectContext(
    logicalTeamName: string,
    projectPath: string
  ): Promise<PersistedTeamWorkContext | null>;
  /** Every context the team owns; only used to name the projects in a refusal. */
  listContexts(logicalTeamName: string): Promise<readonly PersistedTeamWorkContext[]>;
}

export interface ProjectBoardRequest {
  teamName: string;
  /** The project the caller works in; required for a team with a separate history per project. */
  projectPath?: string | null;
}

export interface ProjectBoardTarget {
  /** The physical team whose board (tasks, inboxes, kanban, processes) is used. */
  teamName: string;
  /** Set when the requested name was a per-project team, resolved to one of its copies. */
  logicalTeamName?: string;
  projectPath?: string;
}

export type ProjectBoardRefusal =
  | 'PROJECT_REQUIRED'
  | 'NO_PROJECT_HISTORY'
  | 'PROJECT_LAUNCH_PENDING'
  | 'UNRESOLVED';

/** A board that cannot be chosen; the text says what to do instead. */
export class ProjectBoardTargetError extends Error {
  /** Understood by the HTTP error mapping. */
  readonly statusCode = 409;

  constructor(
    readonly code: ProjectBoardRefusal,
    message: string
  ) {
    super(message);
    this.name = 'ProjectBoardTargetError';
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function projectRequiredMessage(ports: ProjectBoardPorts, teamName: string): Promise<string> {
  const head =
    `Team "${teamName}" keeps a separate history per project. ` +
    'Pass projectPath with the project folder to work in';
  let projects: string[];
  try {
    projects = (await ports.listContexts(teamName))
      .filter((context) => context.state === 'ready')
      .map((context) => `"${context.projectPath}"`);
  } catch {
    // The list is only a hint; the refusal stands without it.
    return `${head}.`;
  }
  if (projects.length === 0) {
    return `${head}. It has no project with a finished launch yet: launch it in a project first.`;
  }
  return `${head}: ${projects.join(', ')}.`;
}

/**
 * The one rule for which physical team holds the board an MCP board tool works on.
 *
 * - An ordinary team, and a project copy named exactly, is its own board; a project is ignored.
 * - A per-project team has no board of its own. Its board in a project is the ready copy for
 *   that project, never another project's; no copy is created to provide one. Without a project,
 *   a project without history or a launch still pending there, it refuses with what to do.
 *
 * Unreadable metadata (`TeamMetadataUnreadableError`) and an index that cannot be used fail closed.
 */
export async function resolveProjectBoardTarget(
  ports: ProjectBoardPorts,
  { teamName, projectPath }: ProjectBoardRequest
): Promise<ProjectBoardTarget> {
  if ((await ports.getMode(teamName)) !== 'per_project') return { teamName };

  const project = projectPath?.trim();
  if (!project) {
    throw new ProjectBoardTargetError(
      'PROJECT_REQUIRED',
      await projectRequiredMessage(ports, teamName)
    );
  }
  let context: PersistedTeamWorkContext | null;
  try {
    context = await ports.inspectContext(teamName, project);
  } catch (error) {
    throw new ProjectBoardTargetError(
      'UNRESOLVED',
      `Cannot find the history of team "${teamName}" in project ${project}: ${reasonOf(error)}`
    );
  }
  if (!context) {
    throw new ProjectBoardTargetError(
      'NO_PROJECT_HISTORY',
      `Team "${teamName}" has no history in project ${project} yet. ` +
        'Launch it in that project first (team_launch with this cwd, or in the app), then call again.'
    );
  }
  if (context.state !== 'ready') {
    throw new ProjectBoardTargetError(
      'PROJECT_LAUNCH_PENDING',
      `Team "${teamName}" is being launched in project ${project}. ` +
        'Call again when the launch has finished.'
    );
  }
  return {
    teamName: context.executionTeamName,
    logicalTeamName: teamName,
    projectPath: context.projectPath,
  };
}

type BoardRegistry = Pick<TeamProjectContextRegistry, 'inspect' | 'list' | 'listRetained'>;

/** The ports over any metadata store and registry; tests inject a temp-dir registry. */
export function createProjectBoardPorts(
  meta: TeamModeMetaReader,
  registry: BoardRegistry
): ProjectBoardPorts {
  return {
    getMode: (teamName) => readTeamProjectContextMode(meta, teamName, UNREADABLE_MESSAGE),
    inspectContext: (logicalTeamName, projectPath) =>
      registry.inspect(logicalTeamName, projectPath),
    listContexts: (logicalTeamName) => listOwnedContexts(registry, logicalTeamName, 'per_project'),
  };
}
