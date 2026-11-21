import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  createProjectCopyPorts,
  findProjectCopyOwners,
  projectContextModeOf,
  ProjectContextRefusalError,
  ProjectCopyUnavailableError,
  resolveReadyProjectCopy,
  withProjectCopyRefusal,
} from './projectCopyRouting';

import type { TeamModeMetaReader } from './projectContextMode';
import type { ProjectCopyPorts, ProjectCopyRefusal } from './projectCopyRouting';
import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';

const UNREADABLE_MESSAGE = 'Team metadata is unreadable; refusing to choose the board of a project';

export type ProjectBoardPorts = ProjectCopyPorts;

export interface ProjectBoardRequest {
  teamName: string;
  /** The project the caller works in; required for a team with a separate history per project. */
  projectPath?: string | null;
}

export interface ProjectBoardTarget {
  /** The physical team whose board (tasks, inboxes, kanban, processes) is used. */
  teamName: string;
  /** Set when the board is a project copy: the team it belongs to and its project. */
  logicalTeamName?: string;
  projectPath?: string;
}

export type ProjectBoardRefusal = ProjectCopyRefusal | 'PROJECT_REQUIRED' | 'PROJECT_MISMATCH';

/** A board that cannot be chosen; the text says what to do instead. */
export class ProjectBoardTargetError extends ProjectContextRefusalError<ProjectBoardRefusal> {
  override name = 'ProjectBoardTargetError';
}

/** What a caller of a board tool does about a copy that cannot be used now. */
const NEXT_STEP: Record<ProjectCopyRefusal, string> = {
  NO_PROJECT_HISTORY:
    'Launch it in that project first (team_launch with this cwd, or in the app), then call again.',
  PROJECT_LAUNCH_PENDING: 'Call again when the launch has finished.',
  PROJECT_LAUNCH_INCOMPLETE:
    'Launch it again in that project (team_launch with this cwd, or in the app), then call again.',
  UNRESOLVED: '',
};

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

/** A name with a project: only a project copy has a project of its own, and it must be that one. */
async function exactNameInProject(
  ports: ProjectBoardPorts,
  teamName: string,
  projectPath: string
): Promise<ProjectBoardTarget> {
  const copy = (await findProjectCopyOwners(ports, [teamName]))(teamName);
  // An ordinary team keeps one history for every project.
  if (!copy) return { teamName };
  const logicalTeamName = copy.logicalTeamName;
  let named: PersistedTeamWorkContext | null;
  try {
    named = await ports.inspectContext(logicalTeamName, projectPath);
  } catch (error) {
    throw new ProjectCopyUnavailableError(
      'UNRESOLVED',
      `Cannot find the history of team "${logicalTeamName}" in project ${projectPath}: ${getErrorMessage(error)}`
    );
  }
  if (named?.executionTeamName !== teamName) {
    throw new ProjectBoardTargetError(
      'PROJECT_MISMATCH',
      `"${teamName}" is the history of team "${logicalTeamName}" in project ` +
        `${copy.context.projectPath}, not in ${projectPath}. Call with teamName "${logicalTeamName}" ` +
        'and this projectPath, or without projectPath.'
    );
  }
  const context = await resolveReadyProjectCopy(ports, logicalTeamName, projectPath);
  return { teamName, logicalTeamName, projectPath: context.projectPath };
}

async function boardTarget(
  ports: ProjectBoardPorts,
  request: ProjectBoardRequest
): Promise<ProjectBoardTarget> {
  const { teamName } = request;
  const projectPath = request.projectPath?.trim() || undefined;
  if ((await projectContextModeOf(ports, teamName)) !== 'per_project') {
    return projectPath ? exactNameInProject(ports, teamName, projectPath) : { teamName };
  }
  if (!projectPath) {
    throw new ProjectBoardTargetError(
      'PROJECT_REQUIRED',
      await projectRequiredMessage(ports, teamName)
    );
  }
  const context = await resolveReadyProjectCopy(ports, teamName, projectPath);
  return {
    teamName: context.executionTeamName,
    logicalTeamName: teamName,
    projectPath: context.projectPath,
  };
}

/**
 * The one rule for which physical team holds the board an MCP board tool works on.
 *
 * - A per-project team has no board of its own. Its board in a project is the ready copy for
 *   that project (`resolveReadyProjectCopy`), never another project's; no copy is created to
 *   provide one. Without a project it refuses (`PROJECT_REQUIRED`, naming the projects).
 * - An ordinary team is its own board for every project.
 * - A project copy named exactly is its own board. With a project it must be the copy of that
 *   project (`PROJECT_MISMATCH` otherwise) and pass the same checks (pending launch, trash).
 *
 * Unreadable metadata (`TeamMetadataUnreadableError`) and an index that cannot be used fail closed.
 */
export function resolveProjectBoardTarget(
  ports: ProjectBoardPorts,
  request: ProjectBoardRequest
): Promise<ProjectBoardTarget> {
  return withProjectCopyRefusal(
    () => boardTarget(ports, request),
    NEXT_STEP,
    (code, message) => new ProjectBoardTargetError(code, message)
  );
}

/**
 * The ports over any metadata store and registry; tests inject a temp-dir registry.
 * `isLaunching` tells a launch in flight from one that failed (see `resolveReadyProjectCopy`).
 */
export function createProjectBoardPorts(
  meta: TeamModeMetaReader,
  registry: Parameters<typeof createProjectCopyPorts>[1],
  isLaunching?: (executionTeamName: string) => boolean
): ProjectBoardPorts {
  return createProjectCopyPorts(meta, registry, {
    unreadableMessage: UNREADABLE_MESSAGE,
    isLaunching,
  });
}
