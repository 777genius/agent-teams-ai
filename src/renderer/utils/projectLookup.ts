/**
 * Project lookup utilities — resolve project IDs from filesystem paths.
 *
 * The projects list (`projects`) is only populated when the sidebar is in "flat"
 * view mode, whereas `repositoryGroups` is populated in "grouped" mode.
 * This helper checks both sources so team pages can always find the matching
 * encoded project ID regardless of which data set is currently loaded.
 */

import type { Project, RepositoryGroup } from '@renderer/types/data';

/**
 * Resolve an encoded project ID from a filesystem path.
 *
 * Lookup order:
 * 1. `projects[]` — flat project list (populated in flat view mode)
 * 2. `repositoryGroups[].worktrees[]` — worktree entries (populated in grouped view mode)
 *
 * @returns The encoded project directory name (e.g. `-Users-belief-dev-project`) or `null`.
 */
export function resolveProjectIdByPath(
  projectPath: string | undefined | null,
  projects: readonly Pick<Project, 'id' | 'path'>[],
  repositoryGroups: readonly Pick<RepositoryGroup, 'worktrees'>[]
): string | null {
  if (!projectPath) return null;

  const fromProjects = projects.find((p) => p.path === projectPath);
  if (fromProjects) return fromProjects.id;

  for (const group of repositoryGroups) {
    const worktree = group.worktrees.find((w) => w.path === projectPath);
    if (worktree) return worktree.id;
  }

  return null;
}

/**
 * Resolve a filesystem path from an encoded project ID.
 *
 * Inverse of `resolveProjectIdByPath`: given a project ID (e.g. `-home-diego-DEV-monorepo-rCAPI`),
 * returns the decoded path (e.g. `/home/diego/DEV/monorepo/rCAPI`).
 *
 * Checks both `projects[]` and `repositoryGroups[].worktrees[]` so the result
 * is correct regardless of whether the sidebar is in flat or grouped view mode.
 */
export function resolveProjectPathById(
  projectId: string | undefined | null,
  projects: readonly Pick<Project, 'id' | 'path' | 'name'>[],
  repositoryGroups: readonly Pick<RepositoryGroup, 'worktrees'>[]
): { path: string; name: string } | null {
  if (!projectId) return null;

  const fromProjects = projects.find((p) => p.id === projectId);
  if (fromProjects) return { path: fromProjects.path, name: fromProjects.name };

  for (const group of repositoryGroups) {
    const worktree = group.worktrees.find((w) => w.id === projectId);
    if (worktree) return { path: worktree.path, name: worktree.name };
  }

  return null;
}
