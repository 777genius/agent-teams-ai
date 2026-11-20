/** A row of the folded team list (`projectTeamSummaries`): only verified copies are folded. */
export interface ProjectCopyCatalogTeam {
  teamName: string;
  displayName?: string;
  projectHistoryContexts?: readonly { executionTeamName: string; projectPath: string }[];
}

export interface ProjectCopyOwner {
  logicalTeamName: string;
  displayName: string;
  projectPath: string;
}

/**
 * The per-project team a project copy (`ptc-…`) belongs to, read from the
 * folded team list. Null for any other name, so a caller keeps the name as is.
 * The list only folds copies whose ownership the registry proved; nothing here
 * infers ownership from the shape of a name.
 */
export function findProjectCopyOwner(
  teams: readonly ProjectCopyCatalogTeam[],
  teamName: string
): ProjectCopyOwner | null {
  for (const team of teams) {
    const context = team.projectHistoryContexts?.find(
      (candidate) => candidate.executionTeamName === teamName
    );
    if (context && team.teamName !== teamName) {
      return {
        logicalTeamName: team.teamName,
        displayName: team.displayName?.trim() || team.teamName,
        projectPath: context.projectPath,
      };
    }
  }
  return null;
}

function projectFolderName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

/** How a project copy is shown to a person: the team and the project folder, never the copy name. */
export function formatProjectCopyLabel(owner: ProjectCopyOwner): string {
  return `${owner.displayName} · ${projectFolderName(owner.projectPath)}`;
}
