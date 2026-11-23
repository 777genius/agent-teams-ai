const STORAGE_PREFIX = 'team-messages-read:';
const BACKFILL_PREFIX = 'team-messages-read-backfill:';

/** Keep the default local workspace's existing keys; never reuse them in other roots. */
export function getTeamMessageReadContextScope(
  contextId: string,
  localRoot?: { defaultPath: string; resolvedPath: string }
): string {
  if (contextId !== 'local') return contextId;
  if (!localRoot?.resolvedPath || !localRoot.defaultPath) {
    throw new Error('Local message read root is unavailable');
  }
  return localRoot.resolvedPath === localRoot.defaultPath
    ? contextId
    : JSON.stringify(['local-root', localRoot.resolvedPath]);
}

export function getTeamMessageReadStorageKey(
  teamName: string,
  contextScope: string,
  kind: 'direct' | 'group' = 'direct'
): string {
  // Existing unscoped data has no provenance. Do not copy it to a remote
  // context or custom local root, even when teams and message IDs match.
  if (kind === 'direct' && contextScope === 'local') return teamName;
  return JSON.stringify([kind, contextScope, teamName]);
}

const listeners = new Set<() => void>();

/** Cross-window read updates must notify Messenger and Attention consistently. */
function onReadStorageEvent(event: StorageEvent): void {
  if (event.key === null || event.key.startsWith(STORAGE_PREFIX) ||
      event.key.startsWith(BACKFILL_PREFIX)) {
    notifyReadStore();
  }
}
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
  if (listeners.size === 0) {
    // Another window may have updated localStorage while nobody subscribed.
    snapshotVersion += 1;
    snapshotCache.clear();
    if (typeof window !== 'undefined') window.addEventListener('storage', onReadStorageEvent);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onReadStorageEvent);
    }
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
 * Upgrade path: seed localStorage from persisted `message.read` flags.
 * Do not finalize until the caller has the full migration range (`finalize: true`).
 * Partial heads and per-member subsets must keep merging without locking the marker.
 */
export function seedPersistedReadKeysOnce(
  teamName: string,
  keys: readonly string[],
  options?: { readonly finalize?: boolean }
): void {
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
    if (options?.finalize === true) {
      localStorage.setItem(backfillKey(teamName), '1');
    }
  } catch {
    // quota or disabled
  }
}
