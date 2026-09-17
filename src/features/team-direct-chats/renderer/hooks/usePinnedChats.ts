import { useCallback, useSyncExternalStore } from 'react';

import { conversationScopeKey } from '../../core/domain/conversationScope';
import {
  movePinnedChatKey,
  prunePinnedChatKeys,
  togglePinnedChatKey,
} from '../../core/domain/pinnedChatOrder';
import {
  getPinnedChatKeysSnapshot,
  savePinnedChatKeys,
  subscribePinnedChats,
} from '../storage/pinnedChatsStorage';

import type { ConversationScope } from '../../core/domain/conversationScope';

const EMPTY_KEYS: readonly string[] = Object.freeze([]);

export function usePinnedChats(teamName: string): {
  pinnedKeys: readonly string[];
  togglePin: (key: string, availableScopes?: readonly ConversationScope[]) => void;
  reorderPinned: (fromKey: string, toKey: string) => void;
} {
  const pinnedKeys = useSyncExternalStore(
    subscribePinnedChats,
    () => getPinnedChatKeysSnapshot(teamName),
    () => EMPTY_KEYS
  );

  const togglePin = useCallback(
    (key: string, availableScopes?: readonly ConversationScope[]) => {
      const current = getPinnedChatKeysSnapshot(teamName);
      const pruned = availableScopes
        ? prunePinnedChatKeys(
            current,
            new Set(availableScopes.map((scope) => conversationScopeKey(scope)))
          )
        : [...current];
      savePinnedChatKeys(teamName, togglePinnedChatKey(pruned, key));
    },
    [teamName]
  );

  const reorderPinned = useCallback(
    (fromKey: string, toKey: string) => {
      savePinnedChatKeys(
        teamName,
        movePinnedChatKey(getPinnedChatKeysSnapshot(teamName), fromKey, toKey)
      );
    },
    [teamName]
  );

  return { pinnedKeys, togglePin, reorderPinned };
}
