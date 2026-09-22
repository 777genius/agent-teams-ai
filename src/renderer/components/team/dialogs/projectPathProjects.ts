import { api } from '@renderer/api';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';

import type { ProjectPathProject } from './projectPathOptions';
import type { DashboardRecentProjectSource } from '@features/recent-projects/contracts';
import type { Project, RepositoryGroup } from '@shared/types';

export type { ProjectPathProject } from './projectPathOptions';

interface LoadProjectPathProjectsOptions {
  defaultProjectPath?: string | null;
  repositoryGroups?: RepositoryGroup[];
}

function mergeDiscoverySource(
  current: DashboardRecentProjectSource | undefined,
  next: DashboardRecentProjectSource | undefined
): DashboardRecentProjectSource | undefined {
  if (!current) return next;
  if (!next || current === next) return current;
  return 'mixed';
}

function mergeFilesystemState(
  current: ProjectPathProject['filesystemState'],
  next: ProjectPathProject['filesystemState']
): ProjectPathProject['filesystemState'] {
  if (current === 'available' || next === 'available') return 'available';
  return current ?? next;
}

function getPathName(projectPath: string): string {
  return projectPath.split(/[/\\]/).filter(Boolean).pop() ?? projectPath;
}

function upsertProject(
  byNormalizedPath: Map<string, ProjectPathProject>,
  order: string[],
  project: ProjectPathProject
): void {
  if (isEphemeralProjectPath(project.path)) {
    return;
  }

  const normalizedPath = normalizePath(project.path);
  const existing = byNormalizedPath.get(normalizedPath);
  if (!existing) {
    byNormalizedPath.set(normalizedPath, project);
    order.push(normalizedPath);
    return;
  }

  existing.discoverySource = mergeDiscoverySource(
    existing.discoverySource,
    project.discoverySource
  );
  existing.filesystemState = mergeFilesystemState(
    existing.filesystemState,
    project.filesystemState
  );
  if (!existing.mostRecentSession && project.mostRecentSession) {
    existing.mostRecentSession = project.mostRecentSession;
  }
}

function recentProjectToProject(project: {
  id: string;
  name: string;
  primaryPath: string;
  mostRecentActivity: number;
  source: DashboardRecentProjectSource;
  filesystemState?: ProjectPathProject['filesystemState'];
}): ProjectPathProject {
  return {
    id: `recent:${project.id}`,
    path: project.primaryPath,
    name: project.name,
    sessions: [],
    totalSessions: 0,
    createdAt: project.mostRecentActivity,
    mostRecentSession: project.mostRecentActivity,
    discoverySource: project.source,
    filesystemState: project.filesystemState,
  };
}

function repositoryWorktreeToProject(
  worktree: RepositoryGroup['worktrees'][number]
): ProjectPathProject {
  return {
    id: worktree.id,
    path: worktree.path,
    name: worktree.name,
    sessions: [],
    totalSessions: 0,
    createdAt: worktree.createdAt ?? Date.now(),
    filesystemState: worktree.filesystemState,
  };
}

export function syntheticProjectFromPath(projectPath: string): Project {
  return {
    id: projectPath.replace(/[/\\]/g, '-'),
    path: projectPath,
    name: getPathName(projectPath),
    sessions: [],
    totalSessions: 0,
    createdAt: Date.now(),
  };
}

export async function loadProjectPathProjects({
  defaultProjectPath,
  repositoryGroups = [],
}: LoadProjectPathProjectsOptions = {}): Promise<ProjectPathProject[]> {
  const [projectsResult, recentProjectsResult] = await Promise.allSettled([
    api.getProjects(),
    api.getDashboardRecentProjects(),
  ]);

  if (projectsResult.status === 'rejected' && recentProjectsResult.status === 'rejected') {
    throw projectsResult.reason;
  }

  const byNormalizedPath = new Map<string, ProjectPathProject>();
  const order: string[] = [];
  const apiProjects = projectsResult.status === 'fulfilled' ? projectsResult.value : [];
  const recentProjects =
    recentProjectsResult.status === 'fulfilled' ? recentProjectsResult.value.projects : [];

  for (const project of apiProjects) {
    upsertProject(byNormalizedPath, order, {
      ...project,
      discoverySource: 'claude',
    });
  }

  for (const project of recentProjects) {
    upsertProject(byNormalizedPath, order, recentProjectToProject(project));
  }

  for (const repo of repositoryGroups) {
    for (const worktree of repo.worktrees) {
      upsertProject(byNormalizedPath, order, repositoryWorktreeToProject(worktree));
    }
  }

  if (defaultProjectPath && !isEphemeralProjectPath(defaultProjectPath)) {
    upsertProject(byNormalizedPath, order, syntheticProjectFromPath(defaultProjectPath));
  }

  return order.flatMap((path) => {
    const project = byNormalizedPath.get(path);
    return project ? [project] : [];
  });
}
