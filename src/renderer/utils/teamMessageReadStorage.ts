const STORAGE_PREFIX = 'team-messages-read:';

function storageKey(teamName: string): string {
  return `${STORAGE_PREFIX}${teamName}`;
}

export function getReadSet(teamName: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(teamName));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Mark a message as read and persist. If `fullSet` is provided, that set is written
 * (avoids losing keys when a previous write failed). Otherwise reads from localStorage and adds one key.
 */
export function markRead(teamName: string, messageKey: string, fullSet?: Set<string>): void {
  const toWrite =
    fullSet ??
    (() => {
      const set = getReadSet(teamName);
      if (set.has(messageKey)) return null;
      set.add(messageKey);
      return set;
    })();
  if (!toWrite) return;
  try {
    localStorage.setItem(storageKey(teamName), JSON.stringify([...toWrite]));
  } catch {
    // quota or disabled
  }
}

/**
 * Persist a full set of read keys at once (bulk mark-all-as-read).
 */
export function markBulkRead(teamName: string, fullSet: Set<string>): void {
  try {
    localStorage.setItem(storageKey(teamName), JSON.stringify([...fullSet]));
  } catch {
    // quota or disabled
  }
}
