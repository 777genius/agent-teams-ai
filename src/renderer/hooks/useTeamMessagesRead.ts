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
  messages: readonly InboxMessage[] = EMPTY_MESSAGES,
  hydrationComplete = false,
  storageScope?: string
): {
  readSet: Set<string>;
  markRead: (messageKey: string) => void;
  markAllRead: (messageKeys: string[]) => void;
} {
  const storageTeam = storageScope === undefined ? teamName : JSON.stringify(['group', storageScope, teamName]);
  const subscribe = useCallback((onStoreChange: () => void) => {
    return subscribeTeamMessageReadStore(onStoreChange);
  }, []);
  const getSnapshot = useCallback(
    () => (teamName ? getReadSetSnapshot(storageTeam) : EMPTY_READ_SET),
    [storageTeam, teamName]
  );
  const readSet = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!teamName || messages.length === 0) return;
    seedPersistedReadKeysOnce(
      storageTeam,
      messages.filter((message) => message.read === true).map(toMessageKey),
      { finalize: hydrationComplete }
    );
  }, [hydrationComplete, messages, storageTeam, teamName]);

  const markRead = useCallback(
    (messageKey: string) => {
      if (!teamName) return;
      const existing = new Set(getReadSetSnapshot(storageTeam));
      if (existing.has(messageKey)) return;
      existing.add(messageKey);
      markReadStorage(storageTeam, messageKey, existing);
    },
    [storageTeam, teamName]
  );

  const markAllRead = useCallback(
    (messageKeys: string[]) => {
      if (!teamName || messageKeys.length === 0) return;
      const existing = new Set(getReadSetSnapshot(storageTeam));
      let changed = false;
      for (const key of messageKeys) {
        if (!existing.has(key)) {
          existing.add(key);
          changed = true;
        }
      }
      if (!changed) return;
      markBulkReadStorage(storageTeam, existing);
    },
    [storageTeam, teamName]
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
