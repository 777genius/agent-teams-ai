import type { RepositoryGroup } from '@renderer/types/data';

interface ResolveEffectiveSelectedRepositoryIdInput {
  repositoryGroups: readonly RepositoryGroup[];
  selectedRepositoryId: string | null;
  effectiveSelectedWorktreeId: string | null;
}

export function resolveEffectiveSelectedRepositoryId({
  repositoryGroups,
  selectedRepositoryId,
  effectiveSelectedWorktreeId,
}: ResolveEffectiveSelectedRepositoryIdInput): string | null {
  const worktreeOwnerRepositoryId =
    effectiveSelectedWorktreeId == null
      ? null
      : (repositoryGroups.find((repo) =>
          repo.worktrees.some((worktree) => worktree.id === effectiveSelectedWorktreeId)
        )?.id ?? null);

  if (worktreeOwnerRepositoryId) {
    return worktreeOwnerRepositoryId;
  }

  if (
    selectedRepositoryId &&
    repositoryGroups.some((repositoryGroup) => repositoryGroup.id === selectedRepositoryId)
  ) {
    return selectedRepositoryId;
  }

  return null;
}
