import { normalizePath } from '@renderer/utils/pathNormalize';

import type { Project, RepositoryGroup } from '@renderer/types/data';
import type { TeamSummary } from '@shared/types';

export interface ResolveTeamProjectSelectionInput {
  repositoryGroups: readonly RepositoryGroup[];
  projects: readonly Project[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  selectedProjectId: string | null;
  activeProjectId: string | null;
}

export interface ResolvedTeamProjectSelection {
  projectPath: string | null;
  repositoryId: string | null;
  worktreeId: string | null;
  projectId: string | null;
}

export type TeamProjectSelectionTarget =
  | {
      kind: 'grouped';
      repositoryId: string;
      worktreeId: string;
      projectPath: string;
    }
  | {
      kind: 'flat';
      projectId: string;
      projectPath: string;
    };

function findWorktreeSelection(
  repositoryGroups: readonly RepositoryGroup[],
  worktreeId: string
): { repositoryId: string; worktreeId: string; projectPath: string } | null {
  for (const repositoryGroup of repositoryGroups) {
    const worktree = repositoryGroup.worktrees.find((candidate) => candidate.id === worktreeId);
    if (worktree) {
      return {
        repositoryId: repositoryGroup.id,
        worktreeId: worktree.id,
        projectPath: worktree.path,
      };
    }
  }

  return null;
}

function resolveWorktreeProjectSelection(
  repositoryGroups: readonly RepositoryGroup[],
  worktreeId: string | null
): ResolvedTeamProjectSelection | null {
  if (!worktreeId) return null;
  const worktreeSelection = findWorktreeSelection(repositoryGroups, worktreeId);
  if (!worktreeSelection) return null;
  return {
    projectPath: worktreeSelection.projectPath,
    repositoryId: worktreeSelection.repositoryId,
    worktreeId: worktreeSelection.worktreeId,
    projectId: worktreeSelection.worktreeId,
  };
}

function resolveFlatProjectSelection(
  projects: readonly Project[],
  projectId: string | null
): ResolvedTeamProjectSelection | null {
  if (!projectId) return null;
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return null;
  return {
    projectPath: project.path,
    repositoryId: null,
    worktreeId: null,
    projectId: project.id,
  };
}

export function resolveTeamProjectSelection({
  repositoryGroups,
  projects,
  selectedRepositoryId,
  selectedWorktreeId,
  selectedProjectId,
  activeProjectId,
}: ResolveTeamProjectSelectionInput): ResolvedTeamProjectSelection {
  const selectedWorktreeSelection =
    resolveWorktreeProjectSelection(repositoryGroups, selectedWorktreeId) ??
    resolveWorktreeProjectSelection(repositoryGroups, selectedProjectId);
  if (selectedWorktreeSelection) return selectedWorktreeSelection;

  const selectedFlatProjectSelection = resolveFlatProjectSelection(projects, selectedProjectId);
  if (selectedFlatProjectSelection) return selectedFlatProjectSelection;

  const activeProjectSelection =
    resolveWorktreeProjectSelection(repositoryGroups, activeProjectId) ??
    resolveFlatProjectSelection(projects, activeProjectId);
  if (activeProjectSelection) return activeProjectSelection;

  if (selectedRepositoryId) {
    const repositoryGroup = repositoryGroups.find(
      (candidate) => candidate.id === selectedRepositoryId
    );
    const fallbackWorktree = repositoryGroup?.worktrees[0] ?? null;
    if (fallbackWorktree) {
      return {
        projectPath: fallbackWorktree.path,
        repositoryId: repositoryGroup?.id ?? null,
        worktreeId: fallbackWorktree.id,
        projectId: fallbackWorktree.id,
      };
    }
  }

  return {
    projectPath: null,
    repositoryId: null,
    worktreeId: null,
    projectId: null,
  };
}

export function findTeamProjectSelectionTarget(
  repositoryGroups: readonly RepositoryGroup[],
  projects: readonly Project[],
  projectPath: string
): TeamProjectSelectionTarget | null {
  const normalizedProjectPath = normalizePath(projectPath);

  for (const repositoryGroup of repositoryGroups) {
    const worktree = repositoryGroup.worktrees.find(
      (candidate) => normalizePath(candidate.path) === normalizedProjectPath
    );
    if (worktree) {
      return {
        kind: 'grouped',
        repositoryId: repositoryGroup.id,
        worktreeId: worktree.id,
        projectPath: worktree.path,
      };
    }
  }

  const project = projects.find(
    (candidate) => normalizePath(candidate.path) === normalizedProjectPath
  );
  if (project) {
    return {
      kind: 'flat',
      projectId: project.id,
      projectPath: project.path,
    };
  }

  return null;
}

export function teamMatchesProjectSelection(team: TeamSummary, projectPath: string): boolean {
  const normalizedProjectPath = normalizePath(projectPath);
  if (team.projectPath && normalizePath(team.projectPath) === normalizedProjectPath) {
    return true;
  }

  return (
    team.projectPathHistory?.some(
      (candidate) => normalizePath(candidate) === normalizedProjectPath
    ) ?? false
  );
}
