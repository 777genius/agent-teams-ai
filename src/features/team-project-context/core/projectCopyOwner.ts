import type { TeamProjectContextMode } from '../contracts';

/** A row of the folded team list (`projectTeamSummaries`): only verified copies are folded. */
export interface ProjectCopyCatalogTeam {
  teamName: string;
  displayName?: string;
  projectContextMode?: TeamProjectContextMode;
  projectHistoryContexts?: readonly { executionTeamName: string; projectPath: string }[];
}

export interface ProjectCopyOwner {
  logicalTeamName: string;
  displayName: string;
  projectPath: string;
  /** The project folder, with its parent when another project of the team has the same name. */
  projectLabel: string;
  /**
   * The owner keeps a separate history per project, so the copy is the team itself
   * in one project. A shared team that only retained copies from before is not.
   */
  perProject: boolean;
}

function segmentsOf(projectPath: string): string[] {
  return projectPath.split(/[\\/]/).filter(Boolean);
}

function folderLabel(projectPath: string, depth: number): string {
  const segments = segmentsOf(projectPath);
  return segments.slice(-depth).join('/') || projectPath;
}

/** The shortest folder label that tells this project apart from the team's other projects. */
function projectLabelOf(projectPath: string, siblings: readonly string[]): string {
  const others = siblings.filter((path) => path !== projectPath);
  const maxDepth = segmentsOf(projectPath).length;
  for (let depth = 1; depth < maxDepth; depth += 1) {
    const label = folderLabel(projectPath, depth);
    if (!others.some((other) => folderLabel(other, depth) === label)) return label;
  }
  return projectPath;
}

/**
 * The team a project copy (`ptc-…`) belongs to, read from the folded team list.
 * Null for any other name, so a caller keeps the name as is. The list only folds
 * copies whose ownership the registry proved; nothing here infers ownership from
 * the shape of a name.
 */
export function findProjectCopyOwner(
  teams: readonly ProjectCopyCatalogTeam[],
  teamName: string
): ProjectCopyOwner | null {
  for (const team of teams) {
    const contexts = team.projectHistoryContexts ?? [];
    const context = contexts.find((candidate) => candidate.executionTeamName === teamName);
    if (context && team.teamName !== teamName) {
      return {
        logicalTeamName: team.teamName,
        displayName: team.displayName?.trim() || team.teamName,
        projectPath: context.projectPath,
        projectLabel: projectLabelOf(
          context.projectPath,
          contexts.map((candidate) => candidate.projectPath)
        ),
        perProject: team.projectContextMode === 'per_project',
      };
    }
  }
  return null;
}

/** How a project copy is shown to a person: the team and its project, never the copy name. */
export function formatProjectCopyLabel(owner: ProjectCopyOwner): string {
  return `${owner.displayName} · ${owner.projectLabel}`;
}
