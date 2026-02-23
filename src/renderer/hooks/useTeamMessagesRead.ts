import { useCallback, useEffect, useState } from 'react';

import {
  getReadSet as getReadSetStorage,
  markRead as markReadStorage,
} from '@renderer/utils/teamMessageReadStorage';

export function useTeamMessagesRead(teamName: string): {
  readSet: Set<string>;
  markRead: (messageKey: string) => void;
} {
  const [readSet, setReadSet] = useState<Set<string>>(() =>
    teamName ? getReadSetStorage(teamName) : new Set()
  );

  useEffect(() => {
    if (!teamName) {
      queueMicrotask(() => setReadSet(new Set()));
      return;
    }
    queueMicrotask(() => setReadSet(getReadSetStorage(teamName)));
  }, [teamName]);

  const markRead = useCallback(
    (messageKey: string) => {
      if (!teamName) return;
      setReadSet((prev) => {
        if (prev.has(messageKey)) return prev;
        const next = new Set(prev);
        next.add(messageKey);
        markReadStorage(teamName, messageKey, next);
        return next;
      });
    },
    [teamName]
  );

  return { readSet, markRead };
}
