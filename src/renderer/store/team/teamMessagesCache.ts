import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import { toMessageKey } from '@renderer/utils/teamMessageKey';

export type {
  RefreshTeamMessagesHeadResult,
  TeamMessagesCacheEntry,
} from '@features/team-view-read-model/renderer';

import type { TeamMessagesCacheEntry } from '@features/team-view-read-model/renderer';
import type { InboxMessage } from '@shared/types';

export interface TeamMessagesCacheState {
  teamMessagesByName: Record<string, TeamMessagesCacheEntry>;
}

export interface TeamMessageSelectorCacheSnapshot {
  hasMergedMessagesSelector: boolean;
  memberMessagesSelectorCount: number;
}

export const EMPTY_TEAM_MESSAGES_CACHE_ENTRY: TeamMessagesCacheEntry = {
  canonicalMessages: [],
  optimisticMessages: [],
  feedRevision: null,
  nextCursor: null,
  hasMore: false,
  lastFetchedAt: null,
  loadingHead: false,
  loadingOlder: false,
  headHydrated: false,
};

const mergedMessagesSelectorCache = new Map<
  string,
  {
    canonicalRef: readonly InboxMessage[];
    optimisticRef: readonly InboxMessage[];
    result: InboxMessage[];
  }
>();
const memberMessagesSelectorCache = new Map<
  string,
  {
    messagesRef: readonly InboxMessage[];
    result: InboxMessage[];
  }
>();

export function clearTeamMessageSelectorCaches(): void {
  mergedMessagesSelectorCache.clear();
  memberMessagesSelectorCache.clear();
}

export function clearTeamMessageSelectorCachesForTeam(teamName: string): void {
  mergedMessagesSelectorCache.delete(teamName);

  const teamScopedPrefix = `${teamName}:`;
  for (const key of memberMessagesSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      memberMessagesSelectorCache.delete(key);
    }
  }
}

export function getTeamMessageSelectorCacheSnapshotForTeam(
  teamName: string
): TeamMessageSelectorCacheSnapshot {
  const teamScopedPrefix = `${teamName}:`;
  let memberMessagesSelectorCount = 0;
  for (const key of memberMessagesSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      memberMessagesSelectorCount += 1;
    }
  }

  return {
    hasMergedMessagesSelector: mergedMessagesSelectorCache.has(teamName),
    memberMessagesSelectorCount,
  };
}

export function compareInboxMessagesByTimestamp(a: InboxMessage, b: InboxMessage): number {
  const aTime = Date.parse(a.timestamp);
  const bTime = Date.parse(b.timestamp);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) {
    return aTime - bTime;
  }
  if (aValid !== bValid) {
    return aValid ? -1 : 1;
  }
  const aId = typeof a.messageId === 'string' ? a.messageId : '';
  const bId = typeof b.messageId === 'string' ? b.messageId : '';
  return aId.localeCompare(bId);
}

export function getTeamMessagesCacheEntry(
  state: TeamMessagesCacheState,
  teamName: string
): TeamMessagesCacheEntry {
  return state.teamMessagesByName[teamName] ?? EMPTY_TEAM_MESSAGES_CACHE_ENTRY;
}

export function upsertOptimisticTeamMessage(
  entry: TeamMessagesCacheEntry,
  message: InboxMessage
): TeamMessagesCacheEntry {
  const nextOptimistic = [...entry.optimisticMessages];
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (messageId.length > 0) {
    const existingIndex = nextOptimistic.findIndex(
      (candidate) =>
        typeof candidate.messageId === 'string' && candidate.messageId.trim() === messageId
    );
    if (existingIndex >= 0) {
      nextOptimistic[existingIndex] = {
        ...nextOptimistic[existingIndex],
        ...message,
      };
    } else {
      nextOptimistic.push(message);
    }
  } else {
    nextOptimistic.push(message);
  }
  nextOptimistic.sort(compareInboxMessagesByTimestamp);
  return {
    ...entry,
    optimisticMessages: nextOptimistic,
  };
}

export function areInboxMessageArraysEquivalent(
  left: readonly InboxMessage[],
  right: readonly InboxMessage[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.messageId !== rightItem.messageId ||
      leftItem.timestamp !== rightItem.timestamp ||
      leftItem.from !== rightItem.from ||
      leftItem.to !== rightItem.to ||
      leftItem.text !== rightItem.text ||
      leftItem.summary !== rightItem.summary ||
      leftItem.read !== rightItem.read ||
      leftItem.actionMode !== rightItem.actionMode ||
      leftItem.commentId !== rightItem.commentId ||
      leftItem.relayOfMessageId !== rightItem.relayOfMessageId ||
      leftItem.source !== rightItem.source ||
      leftItem.leadSessionId !== rightItem.leadSessionId ||
      leftItem.messageKind !== rightItem.messageKind ||
      JSON.stringify(leftItem.taskRefs ?? null) !== JSON.stringify(rightItem.taskRefs ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export function pruneOptimisticMessages(
  optimistic: readonly InboxMessage[],
  canonical: readonly InboxMessage[]
): InboxMessage[] {
  if (optimistic.length === 0) {
    return [];
  }

  const canonicalIds = new Set(
    canonical
      .map((message) => (typeof message.messageId === 'string' ? message.messageId.trim() : ''))
      .filter((messageId) => messageId.length > 0)
  );

  return optimistic.filter((message) => {
    const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    return !messageId || !canonicalIds.has(messageId);
  });
}

export function getCanonicalHeadSlice(
  canonicalMessages: readonly InboxMessage[],
  headLength: number
): readonly InboxMessage[] {
  if (headLength <= 0) {
    return [];
  }
  return canonicalMessages.slice(0, headLength);
}

export function extractRetainedCanonicalOlderTail(
  canonicalMessages: readonly InboxMessage[],
  freshHeadMessages: readonly InboxMessage[]
): InboxMessage[] | null {
  if (canonicalMessages.length === 0) {
    return [];
  }
  if (freshHeadMessages.length === 0) {
    return null;
  }

  const freshHeadKeys = new Set(freshHeadMessages.map((message) => toMessageKey(message)));
  let hasMessagesOutsideFreshHead = false;
  for (const message of canonicalMessages) {
    if (!freshHeadKeys.has(toMessageKey(message))) {
      hasMessagesOutsideFreshHead = true;
      break;
    }
  }
  if (!hasMessagesOutsideFreshHead) {
    return [];
  }

  const anchorKey = toMessageKey(freshHeadMessages[freshHeadMessages.length - 1]);
  const anchorIndex = canonicalMessages.findIndex((message) => toMessageKey(message) === anchorKey);
  if (anchorIndex < 0) {
    return null;
  }

  return canonicalMessages
    .slice(anchorIndex + 1)
    .filter((message) => !freshHeadKeys.has(toMessageKey(message)));
}

export function selectTeamMessages(
  state: TeamMessagesCacheState,
  teamName: string | null | undefined
): InboxMessage[] {
  if (!teamName) {
    return [];
  }

  const entry = getTeamMessagesCacheEntry(state, teamName);
  const cached = mergedMessagesSelectorCache.get(teamName);
  if (
    cached?.canonicalRef === entry.canonicalMessages &&
    cached.optimisticRef === entry.optimisticMessages
  ) {
    return cached.result;
  }

  const result = mergeTeamMessages(entry.canonicalMessages, entry.optimisticMessages);
  mergedMessagesSelectorCache.set(teamName, {
    canonicalRef: entry.canonicalMessages,
    optimisticRef: entry.optimisticMessages,
    result,
  });
  return result;
}

export function selectMemberMessagesForTeamMember(
  state: TeamMessagesCacheState,
  teamName: string | null | undefined,
  memberName: string | null | undefined
): InboxMessage[] {
  if (!teamName || !memberName) {
    return [];
  }

  const messages = selectTeamMessages(state, teamName);
  const cacheKey = `${teamName}:${memberName}`;
  const cached = memberMessagesSelectorCache.get(cacheKey);
  if (cached?.messagesRef === messages) {
    return cached.result;
  }

  const result = messages.filter(
    (message) => message.from === memberName || message.to === memberName
  );
  memberMessagesSelectorCache.set(cacheKey, {
    messagesRef: messages,
    result,
  });
  return result;
}
