import { normalizePathForMatching } from '@renderer/utils/pathNormalize';

import type { TeamProjectContextView } from '@features/team-project-context/contracts';
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

export interface ResolveCreateTeamDefaultProjectPathInput {
  initialProjectPath: string | null | undefined;
  selectedProjectPath: string | null | undefined;
  priorityProjectPath: string | null | undefined;
}

export function resolveTeamsProjectNavigationPath(
  intent: { projectId: string; projectPath: string } | null | undefined,
  selectedProjectId: string | null
): string | null {
  if (!intent || intent.projectId !== selectedProjectId) {
    return null;
  }
  return intent.projectPath.trim() || null;
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
  if (selectedProjectId && selectedProjectId !== selectedWorktreeId) {
    const selectedFlatProjectSelection = resolveFlatProjectSelection(projects, selectedProjectId);
    if (selectedFlatProjectSelection) return selectedFlatProjectSelection;
  }

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

/**
 * A previously shared team retains its last native project path. Once switched
 * to per-project mode, launching from the team list must use the selected
 * project rather than silently returning to that old shared checkout.
 */
export function resolveTeamLaunchDefaultProjectPath(
  mode: TeamSummary['projectContextMode'],
  selectedProjectPath: string,
  savedProjectPath: string | null | undefined
): string {
  return mode === 'per_project' ? selectedProjectPath : (savedProjectPath ?? selectedProjectPath);
}

/**
 * Only a backend-verified runtime for the selected project may supply relaunch permissions.
 * null makes missing, stale, or unowned contexts fall back to manual approval.
 */
export function resolveTeamListProjectPermissionAlias(
  logicalTeamName: string,
  selectedProjectPath: string,
  context: TeamProjectContextView
): string | null {
  if (
    context.mode !== 'per_project' ||
    context.state !== 'ready' ||
    context.executionTeamName === logicalTeamName ||
    normalizePathForMatching(context.projectPath) !== normalizePathForMatching(selectedProjectPath)
  ) {
    return null;
  }
  return context.executionTeamName;
}

/**
 * A verified physical task link may navigate to the logical team only when
 * openTeamTab can select that project's flat or grouped worktree. Otherwise
 * keep the verified physical identity for read-only historical navigation.
 */
export function resolveVerifiedProjectTaskNavigation(
  physicalTeamName: string,
  redirect: Extract<TeamProjectContextView, { state: 'redirect' }>,
  repositoryGroups: readonly RepositoryGroup[],
  projects: readonly Project[]
): { teamName: string; projectPath?: string } {
  return findTeamProjectSelectionTarget(repositoryGroups, projects, redirect.projectPath)
    ? { teamName: redirect.logicalTeamName, projectPath: redirect.projectPath }
    : { teamName: physicalTeamName };
}

export function resolveCreateTeamDefaultProjectPath({
  initialProjectPath,
  selectedProjectPath,
  priorityProjectPath,
}: ResolveCreateTeamDefaultProjectPathInput): string | null {
  return initialProjectPath ?? selectedProjectPath ?? priorityProjectPath ?? null;
}

export function findTeamProjectSelectionTarget(
  repositoryGroups: readonly RepositoryGroup[],
  projects: readonly Project[],
  projectPath: string
): TeamProjectSelectionTarget | null {
  const normalizedProjectPath = normalizePathForMatching(projectPath);

  for (const repositoryGroup of repositoryGroups) {
    const worktree = repositoryGroup.worktrees.find(
      (candidate) => normalizePathForMatching(candidate.path) === normalizedProjectPath
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
    (candidate) => normalizePathForMatching(candidate.path) === normalizedProjectPath
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
  const normalizedProjectPath = normalizePathForMatching(projectPath);
  if (team.projectPath && normalizePathForMatching(team.projectPath) === normalizedProjectPath) {
    return true;
  }

  return (
    team.projectPathHistory?.some(
      (candidate) => normalizePathForMatching(candidate) === normalizedProjectPath
    ) ?? false
  );
}
