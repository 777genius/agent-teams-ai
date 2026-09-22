import { useCallback, useMemo, useState } from 'react';

import {
  addExpanded,
  getExpandedOverrides,
  removeExpanded,
} from '@renderer/utils/teamMessageExpandStorage';

export function useTeamMessagesExpanded(teamName: string): {
  expandedSet: Set<string>;
  toggle: (messageKey: string) => void;
} {
  const [version, setVersion] = useState(0);
  const expandedSet = useMemo(() => {
    if (version < 0) return new Set<string>();
    return teamName ? getExpandedOverrides(teamName) : new Set<string>();
  }, [teamName, version]);

  const toggle = useCallback(
    (messageKey: string) => {
      if (!teamName) return;
      const existing = getExpandedOverrides(teamName);
      if (existing.has(messageKey)) {
        removeExpanded(teamName, messageKey);
      } else {
        addExpanded(teamName, messageKey);
      }
      setVersion((v) => v + 1);
    },
    [teamName]
  );

  return { expandedSet, toggle };
}
