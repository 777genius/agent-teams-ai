import { useCallback, useMemo, useState } from 'react';

import {
  getReadSet as getReadSetStorage,
  markBulkRead as markBulkReadStorage,
  markRead as markReadStorage,
} from '@renderer/utils/teamMessageReadStorage';

export function useTeamMessagesRead(teamName: string): {
  readSet: Set<string>;
  markRead: (messageKey: string) => void;
  markAllRead: (messageKeys: string[]) => void;
} {
  const [version, setVersion] = useState(0);
  const readSet = useMemo(() => {
    if (version < 0) return new Set<string>();
    return teamName ? getReadSetStorage(teamName) : new Set<string>();
  }, [teamName, version]);

  const markRead = useCallback(
    (messageKey: string) => {
      if (!teamName) return;
      const existing = getReadSetStorage(teamName);
      if (existing.has(messageKey)) return;
      existing.add(messageKey);
      markReadStorage(teamName, messageKey, existing);
      setVersion((v) => v + 1);
    },
    [teamName]
  );

  const markAllRead = useCallback(
    (messageKeys: string[]) => {
      if (!teamName || messageKeys.length === 0) return;
      const existing = getReadSetStorage(teamName);
      let changed = false;
      for (const key of messageKeys) {
        if (!existing.has(key)) {
          existing.add(key);
          changed = true;
        }
      }
      if (!changed) return;
      markBulkReadStorage(teamName, existing);
      setVersion((v) => v + 1);
    },
    [teamName]
  );

  const effectiveReadSet = !teamName ? new Set<string>() : readSet;
  return { readSet: effectiveReadSet, markRead, markAllRead };
}
