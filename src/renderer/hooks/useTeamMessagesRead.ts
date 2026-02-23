import { useCallback, useMemo, useState } from 'react';

import {
  getReadSet as getReadSetStorage,
  markRead as markReadStorage,
} from '@renderer/utils/teamMessageReadStorage';

export function useTeamMessagesRead(teamName: string): {
  readSet: Set<string>;
  markRead: (messageKey: string) => void;
} {
  const [version, setVersion] = useState(0);
  const readSet = useMemo(
    () => {
      if (version < 0) return new Set<string>();
      return teamName ? getReadSetStorage(teamName) : new Set();
    },
    [teamName, version]
  );

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

  return { readSet, markRead };
}
