import { useEffect, useRef } from 'react';

import {
  persistTerminalCommandHistory,
  readStoredTerminalCommandHistory,
} from '../adapters/terminalCommandHistoryStorage';

interface CommandHistoryPersistenceState {
  hasPersistedSnapshot: boolean;
  hasRestoredHistory: boolean | null;
  teamName: string;
}

export function useTerminalCommandHistoryPersistence({
  entries,
  teamName,
}: Readonly<{
  entries: readonly string[];
  teamName: string;
}>): void {
  const persistenceRef = useRef<CommandHistoryPersistenceState>({
    hasPersistedSnapshot: false,
    hasRestoredHistory: null,
    teamName,
  });

  useEffect(() => {
    const persistence = persistenceRef.current;
    if (persistence.teamName !== teamName) {
      persistence.teamName = teamName;
      persistence.hasRestoredHistory = null;
      persistence.hasPersistedSnapshot = false;
    }

    if (persistence.hasRestoredHistory === null) {
      persistence.hasRestoredHistory =
        (readStoredTerminalCommandHistory(teamName)?.length ?? 0) > 0;
    }

    if (
      entries.length === 0 &&
      persistence.hasRestoredHistory &&
      !persistence.hasPersistedSnapshot
    ) {
      return;
    }

    persistTerminalCommandHistory(teamName, entries);
    persistence.hasPersistedSnapshot = true;
    if (entries.length > 0) {
      persistence.hasRestoredHistory = false;
    }
  }, [entries, teamName]);
}
