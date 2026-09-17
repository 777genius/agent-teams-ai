const STORAGE_PREFIX = 'team-messages-read:';
const BACKFILL_PREFIX = 'team-messages-read-backfill:';

const listeners = new Set<() => void>();
let snapshotVersion = 0;
const snapshotCache = new Map<string, { version: number; set: Set<string> }>();

function notifyReadStore(): void {
  snapshotVersion += 1;
  snapshotCache.clear();
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeTeamMessageReadStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReadSetSnapshot(teamName: string): Set<string> {
  const cached = snapshotCache.get(teamName);
  if (cached && cached.version === snapshotVersion) {
    return cached.set;
  }
  const set = getReadSet(teamName);
  snapshotCache.set(teamName, { version: snapshotVersion, set });
  return set;
}

function storageKey(teamName: string): string {
  return `${STORAGE_PREFIX}${teamName}`;
}

function backfillKey(teamName: string): string {
  return `${BACKFILL_PREFIX}${teamName}`;
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
    notifyReadStore();
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
    notifyReadStore();
  } catch {
    // quota or disabled
  }
}

/**
 * One-time upgrade: seed localStorage from persisted `message.read` flags.
 * Call only after the team feed has hydrated so an empty async load cannot
 * lock the flag before historical rows arrive.
 */
export function seedPersistedReadKeysOnce(teamName: string, keys: readonly string[]): void {
  if (!teamName) return;
  try {
    if (localStorage.getItem(backfillKey(teamName)) === '1') return;
    if (keys.length > 0) {
      const existing = getReadSet(teamName);
      let changed = false;
      for (const key of keys) {
        if (!existing.has(key)) {
          existing.add(key);
          changed = true;
        }
      }
      if (changed) {
        localStorage.setItem(storageKey(teamName), JSON.stringify([...existing]));
        notifyReadStore();
      }
    }
    localStorage.setItem(backfillKey(teamName), '1');
  } catch {
    // quota or disabled
  }
}
