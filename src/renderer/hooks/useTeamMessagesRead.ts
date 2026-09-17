import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { toMessageKey } from '@renderer/utils/teamMessageKey';
import {
  getReadSetSnapshot,
  markBulkRead as markBulkReadStorage,
  markRead as markReadStorage,
  seedPersistedReadKeysOnce,
  subscribeTeamMessageReadStore,
} from '@renderer/utils/teamMessageReadStorage';

import type { InboxMessage } from '@shared/types';

const EMPTY_READ_SET = new Set<string>();
const EMPTY_MESSAGES: readonly InboxMessage[] = [];

export function useTeamMessagesRead(
  teamName: string,
  messages: readonly InboxMessage[] = EMPTY_MESSAGES
): {
  readSet: Set<string>;
  markRead: (messageKey: string) => void;
  markAllRead: (messageKeys: string[]) => void;
} {
  const subscribe = useCallback((onStoreChange: () => void) => {
    return subscribeTeamMessageReadStore(onStoreChange);
  }, []);
  const getSnapshot = useCallback(
    () => (teamName ? getReadSetSnapshot(teamName) : EMPTY_READ_SET),
    [teamName]
  );
  const readSet = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!teamName || messages.length === 0) return;
    seedPersistedReadKeysOnce(
      teamName,
      messages.filter((message) => message.read === true).map(toMessageKey)
    );
  }, [messages, teamName]);

  const markRead = useCallback(
    (messageKey: string) => {
      if (!teamName) return;
      const existing = new Set(getReadSetSnapshot(teamName));
      if (existing.has(messageKey)) return;
      existing.add(messageKey);
      markReadStorage(teamName, messageKey, existing);
    },
    [teamName]
  );

  const markAllRead = useCallback(
    (messageKeys: string[]) => {
      if (!teamName || messageKeys.length === 0) return;
      const existing = new Set(getReadSetSnapshot(teamName));
      let changed = false;
      for (const key of messageKeys) {
        if (!existing.has(key)) {
          existing.add(key);
          changed = true;
        }
      }
      if (!changed) return;
      markBulkReadStorage(teamName, existing);
    },
    [teamName]
  );

  return useMemo(
    () => ({
      readSet: teamName ? readSet : EMPTY_READ_SET,
      markRead,
      markAllRead,
    }),
    [markAllRead, markRead, readSet, teamName]
  );
}
