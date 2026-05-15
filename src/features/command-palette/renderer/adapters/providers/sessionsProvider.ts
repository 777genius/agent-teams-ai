import type { CommandSearchNavigationTarget } from '../../../core/domain/models/CommandItem';
import type { CommandProvider } from '../../../core/domain/models/CommandProvider';
import type { RepositoryGroup, SearchResult } from '@renderer/types/data';

interface SearchSessionsResult {
  results: SearchResult[];
  totalMatches: number;
  isPartial?: boolean;
}

export interface SessionsProviderSearchApi {
  searchSessions(projectId: string, query: string, limit: number): Promise<SearchSessionsResult>;
  searchAllProjects(query: string, limit: number): Promise<SearchSessionsResult>;
}

function findProjectName(
  repositoryGroups: readonly RepositoryGroup[],
  projectId: string
): string | undefined {
  return repositoryGroups.find((repo) =>
    repo.worktrees.some((worktree) => worktree.id === projectId)
  )?.name;
}

function buildSearchTarget(query: string, result: SearchResult): CommandSearchNavigationTarget {
  return {
    query,
    messageTimestamp: result.timestamp,
    matchedText: result.matchedText,
    targetGroupId: result.groupId,
    targetMatchIndexInItem: result.matchIndexInItem,
    targetMatchStartOffset: result.matchStartOffset,
    targetMessageUuid: result.messageUuid,
  };
}

export function createSessionsProvider({
  searchApi,
  repositoryGroups,
}: {
  searchApi: SessionsProviderSearchApi;
  repositoryGroups: readonly RepositoryGroup[];
}): CommandProvider {
  return {
    id: 'sessions',
    match: () => [],
    async matchAsync(query, context) {
      const trimmed = query.trim();
      if (trimmed.length < 2) {
        return [];
      }
      if (!context.globalSearchEnabled && !context.selectedProjectId) {
        return [];
      }

      const searchResult = context.globalSearchEnabled
        ? await searchApi.searchAllProjects(trimmed, 50)
        : await searchApi.searchSessions(context.selectedProjectId!, trimmed, 50);

      return searchResult.results.map((result, index) => {
        const projectName = context.globalSearchEnabled
          ? findProjectName(repositoryGroups, result.projectId)
          : undefined;
        return {
          id: `session:${result.projectId}:${result.sessionId}:${result.timestamp}:${index}`,
          providerId: 'sessions',
          category: 'session',
          icon: 'session',
          title: result.sessionTitle || 'Conversation',
          subtitle: result.context,
          detail: new Date(result.timestamp).toLocaleString(),
          badge: projectName ?? (result.messageType === 'user' ? 'User' : 'Assistant'),
          keywords: [result.matchedText, result.sessionTitle, projectName ?? ''],
          priority: 55 - index / 100,
          intent: {
            type: 'session.open',
            projectId: result.projectId,
            sessionId: result.sessionId,
            search: buildSearchTarget(trimmed, result),
          },
        };
      });
    },
  };
}
