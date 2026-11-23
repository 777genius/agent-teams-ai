import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { captureContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import {
  getReadSetSnapshot,
  getTeamMessageReadStorageKey,
  markBulkRead as markBulkReadStorage,
  markRead as markReadStorage,
  seedPersistedReadKeysOnce,
  subscribeTeamMessageReadStore,
} from '@renderer/utils/teamMessageReadStorage';

import { useTeamMessageReadContextScope } from './useTeamMessageReadContextScope';

import type { InboxMessage } from '@shared/types';

const EMPTY_READ_SET = new Set<string>();
const EMPTY_MESSAGES: readonly InboxMessage[] = [];

export function useTeamMessagesRead(
  teamName: string,
  messages: readonly InboxMessage[] = EMPTY_MESSAGES,
  hydrationComplete = false,
  contextId = 'local',
  kind: 'direct' | 'group' = 'direct'
): {
  readSet: Set<string>;
  markRead: (messageKey: string) => void;
  markAllRead: (messageKeys: string[]) => void;
} {
  const { scope, epoch } = useTeamMessageReadContextScope(contextId);
  const storageTeam = scope ? getTeamMessageReadStorageKey(teamName, scope, kind) : null;
  const subscribe = useCallback((onStoreChange: () => void) => {
    return subscribeTeamMessageReadStore(onStoreChange);
  }, []);
  const getSnapshot = useCallback(
    () => (teamName && storageTeam ? getReadSetSnapshot(storageTeam) : EMPTY_READ_SET),
    [storageTeam, teamName]
  );
  const readSet = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!teamName || !storageTeam || messages.length === 0 || captureContextScopedRequestEpoch() !== epoch) return;
    seedPersistedReadKeysOnce(
      storageTeam,
      messages.filter((message) => message.read === true).map(toMessageKey),
      { finalize: hydrationComplete }
    );
  }, [epoch, hydrationComplete, messages, storageTeam, teamName]);

  const markRead = useCallback(
    (messageKey: string) => {
      if (!teamName || !storageTeam || captureContextScopedRequestEpoch() !== epoch) return;
      const existing = new Set(getReadSetSnapshot(storageTeam));
      if (existing.has(messageKey)) return;
      existing.add(messageKey);
      markReadStorage(storageTeam, messageKey, existing);
    },
    [epoch, storageTeam, teamName]
  );

  const markAllRead = useCallback(
    (messageKeys: string[]) => {
      if (!teamName || !storageTeam || messageKeys.length === 0 || captureContextScopedRequestEpoch() !== epoch) return;
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
    [epoch, storageTeam, teamName]
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
