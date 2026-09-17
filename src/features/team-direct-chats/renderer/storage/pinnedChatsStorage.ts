import { normalizePinnedChatKeys } from '../../core/domain/pinnedChatOrder';

const STORAGE_PREFIX = 'team-chats-pinned:';
const EMPTY_KEYS: readonly string[] = Object.freeze([]);
const listeners = new Set<() => void>();
let snapshotVersion = 0;
const snapshotCache = new Map<string, { version: number; keys: readonly string[] }>();

function storageKey(teamName: string): string {
  return `${STORAGE_PREFIX}${teamName}`;
}

function notifyPinnedChats(): void {
  snapshotVersion += 1;
  snapshotCache.clear();
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePinnedChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function loadPinnedChatKeys(teamName: string): string[] {
  if (!teamName) {
    return [];
  }
  try {
    const raw = localStorage.getItem(storageKey(teamName));
    if (!raw) {
      return [];
    }
    return normalizePinnedChatKeys(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function getPinnedChatKeysSnapshot(teamName: string): readonly string[] {
  if (!teamName) {
    return EMPTY_KEYS;
  }
  const cached = snapshotCache.get(teamName);
  if (cached && cached.version === snapshotVersion) {
    return cached.keys;
  }
  const loaded = loadPinnedChatKeys(teamName);
  const keys = loaded.length === 0 ? EMPTY_KEYS : Object.freeze(loaded);
  snapshotCache.set(teamName, { version: snapshotVersion, keys });
  return keys;
}

export function savePinnedChatKeys(teamName: string, keys: readonly string[]): void {
  if (!teamName) {
    return;
  }
  try {
    const normalized = normalizePinnedChatKeys(keys);
    localStorage.setItem(storageKey(teamName), JSON.stringify(normalized));
    notifyPinnedChats();
  } catch {
    // quota or disabled
  }
}
