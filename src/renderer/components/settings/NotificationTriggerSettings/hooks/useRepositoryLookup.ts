/**
 * Hook to convert repository IDs to RepositoryDropdownItem[] for display.
 * Used by TriggerCard and AddTriggerForm to show selected repositories.
 */

import { useMemo } from 'react';

import { useStore } from '@renderer/store';

import type { RepositoryDropdownItem } from '@renderer/components/settings/hooks/useSettingsConfig';

/**
 * Converts an array of repository IDs to RepositoryDropdownItem[] for display.
 * Searches repository groups to find matching repositories.
 */
export function useRepositoryLookup(repositoryIds: string[]): RepositoryDropdownItem[] {
  const repositoryGroups = useStore((state) => state.repositoryGroups);

  return useMemo((): RepositoryDropdownItem[] => {
    const items: RepositoryDropdownItem[] = [];

    for (const repositoryId of repositoryIds) {
      // Find repository group by ID
      const group = repositoryGroups.find((g) => g.id === repositoryId);
      if (group) {
        items.push({
          id: group.id,
          name: group.name,
          path: group.worktrees[0]?.path ?? '',
          worktreeCount: group.worktrees.length,
          totalSessions: group.totalSessions,
        });
      } else {
        // If not found, create a placeholder item
        items.push({
          id: repositoryId,
          name: repositoryId,
          path: '',
          worktreeCount: 0,
          totalSessions: 0,
        });
      }
    }

    return items;
  }, [repositoryIds, repositoryGroups]);
}
