import { del, get, keys, set } from 'idb-keyval';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DRAFT_KEY_PREFIX = 'draft:';

interface StoredDraft {
  value: string;
  timestamp: number;
}

let idbUnavailable = false;
let idbUnavailableLogged = false;
const fallbackStore = new Map<string, StoredDraft>();

function markIdbUnavailable(): void {
  if (!idbUnavailableLogged) {
    idbUnavailableLogged = true;
    console.warn(
      '[draftStorage] IndexedDB unavailable, using in-memory draft storage for this session.'
    );
  }
  idbUnavailable = true;
}

function fallbackSave(key: string, value: string): void {
  const fullKey = `${DRAFT_KEY_PREFIX}${key}`;
  fallbackStore.set(fullKey, { value, timestamp: Date.now() });
}

function fallbackLoad(key: string): string | null {
  const fullKey = `${DRAFT_KEY_PREFIX}${key}`;
  const stored = fallbackStore.get(fullKey);
  if (!stored) return null;
  if (Date.now() - stored.timestamp > DRAFT_TTL_MS) {
    fallbackStore.delete(fullKey);
    return null;
  }
  return stored.value;
}

function fallbackDelete(key: string): void {
  fallbackStore.delete(`${DRAFT_KEY_PREFIX}${key}`);
}

function fallbackCleanupExpired(): void {
  const now = Date.now();
  for (const [fullKey, stored] of fallbackStore.entries()) {
    if (now - stored.timestamp > DRAFT_TTL_MS) fallbackStore.delete(fullKey);
  }
}

async function saveDraft(key: string, value: string): Promise<void> {
  if (idbUnavailable) {
    fallbackSave(key, value);
    return;
  }
  try {
    const stored: StoredDraft = { value, timestamp: Date.now() };
    await set(`${DRAFT_KEY_PREFIX}${key}`, stored);
  } catch {
    markIdbUnavailable();
    fallbackSave(key, value);
  }
}

async function loadDraft(key: string): Promise<string | null> {
  if (idbUnavailable) return fallbackLoad(key);
  try {
    const stored = await get<StoredDraft>(`${DRAFT_KEY_PREFIX}${key}`);
    if (!stored) return null;
    const age = Date.now() - stored.timestamp;
    if (age > DRAFT_TTL_MS) {
      void deleteDraft(key);
      return null;
    }
    return stored.value;
  } catch {
    markIdbUnavailable();
    return fallbackLoad(key);
  }
}

async function deleteDraft(key: string): Promise<void> {
  if (idbUnavailable) {
    fallbackDelete(key);
    return;
  }
  try {
    await del(`${DRAFT_KEY_PREFIX}${key}`);
  } catch {
    markIdbUnavailable();
    fallbackDelete(key);
  }
}

async function cleanupExpired(): Promise<void> {
  if (idbUnavailable) {
    fallbackCleanupExpired();
    return;
  }
  try {
    const allKeys = await keys();
    const draftKeys = allKeys.filter(
      (k): k is IDBValidKey & string => typeof k === 'string' && k.startsWith(DRAFT_KEY_PREFIX)
    );
    const now = Date.now();
    for (const fullKey of draftKeys) {
      try {
        const stored = await get<StoredDraft>(fullKey);
        if (stored && now - stored.timestamp > DRAFT_TTL_MS) await del(fullKey);
      } catch {
        markIdbUnavailable();
        fallbackCleanupExpired();
        return;
      }
    }
  } catch {
    markIdbUnavailable();
    fallbackCleanupExpired();
  }
}

export const draftStorage = {
  saveDraft,
  loadDraft,
  deleteDraft,
  cleanupExpired,
};
