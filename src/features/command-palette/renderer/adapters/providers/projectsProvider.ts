import type { CommandProvider } from '../../../core/domain/models/CommandProvider';
import type { RepositoryGroup } from '@renderer/types/data';

function getProjectPath(repo: RepositoryGroup): string {
  return (
    repo.worktrees.find((worktree) => worktree.isMainWorktree)?.path ??
    repo.worktrees[0]?.path ??
    ''
  );
}

function formatLastActivity(value: number | string | null | undefined): string | undefined {
  if (!value) {
    return 'No recent activity';
  }
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return `Last active ${new Date(timestamp).toLocaleString()}`;
}

export function createProjectsProvider(
  repositoryGroups: readonly RepositoryGroup[]
): CommandProvider {
  return {
    id: 'projects',
    match: () =>
      repositoryGroups.map((repo, index) => ({
        id: `project:${repo.id}`,
        providerId: 'projects',
        category: 'project',
        icon: 'project',
        title: repo.name,
        subtitle: getProjectPath(repo),
        detail: formatLastActivity(repo.mostRecentSession),
        badge: `${repo.totalSessions} session${repo.totalSessions === 1 ? '' : 's'}`,
        keywords: repo.worktrees.flatMap((worktree) => [
          worktree.name,
          worktree.path,
          worktree.gitBranch ?? '',
        ]),
        priority: 80 - index / 100,
        dedupeKey: `project:${repo.id}`,
        intent: {
          type: 'project.select',
          repositoryId: repo.id,
        },
      })),
  };
}
