import { conversationScopeKey } from './conversationScope';

import type { ConversationScope } from './conversationScope';

export interface SortableChatListItem {
  scope: ConversationScope;
  attentionCount: number;
  latestActivityTimestamp: string | null;
}

function activityTimestampMs(item: SortableChatListItem): number {
  const parsed = Date.parse(item.latestActivityTimestamp ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortChatListItems<T extends SortableChatListItem>(
  items: readonly T[],
  sortByActivity: boolean
): T[] {
  if (!sortByActivity) {
    return [...items];
  }

  const pinned = items.filter((item) => item.scope.kind === 'team-feed');
  const rest = items.filter((item) => item.scope.kind !== 'team-feed');
  const originalIndex = new Map(
    rest.map((item, index) => [conversationScopeKey(item.scope), index] as const)
  );

  rest.sort((left, right) => {
    const attentionDelta = Number(right.attentionCount > 0) - Number(left.attentionCount > 0);
    if (attentionDelta !== 0) {
      return attentionDelta;
    }
    const timeDelta = activityTimestampMs(right) - activityTimestampMs(left);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return (
      (originalIndex.get(conversationScopeKey(left.scope)) ?? 0) -
      (originalIndex.get(conversationScopeKey(right.scope)) ?? 0)
    );
  });

  return [...pinned, ...rest];
}
