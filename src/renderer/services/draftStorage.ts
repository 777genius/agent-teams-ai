import { del, get, keys, set } from 'idb-keyval';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DRAFT_KEY_PREFIX = 'draft:';

interface StoredDraft {
  value: string;
  timestamp: number;
}

async function saveDraft(key: string, value: string): Promise<void> {
  try {
    const stored: StoredDraft = {
      value,
      timestamp: Date.now(),
    };
    await set(`${DRAFT_KEY_PREFIX}${key}`, stored);
  } catch (error) {
    console.error(`[draftStorage] Failed to save draft for ${key}:`, error);
  }
}

async function loadDraft(key: string): Promise<string | null> {
  try {
    const stored = await get<StoredDraft>(`${DRAFT_KEY_PREFIX}${key}`);
    if (!stored) {
      return null;
    }

    const age = Date.now() - stored.timestamp;
    if (age > DRAFT_TTL_MS) {
      void deleteDraft(key);
      return null;
    }

    return stored.value;
  } catch (error) {
    console.error(`[draftStorage] Failed to load draft for ${key}:`, error);
    return null;
  }
}

async function deleteDraft(key: string): Promise<void> {
  try {
    await del(`${DRAFT_KEY_PREFIX}${key}`);
  } catch (error) {
    console.error(`[draftStorage] Failed to delete draft for ${key}:`, error);
  }
}

async function cleanupExpired(): Promise<void> {
  try {
    const allKeys = await keys();
    const draftKeys = allKeys.filter(
      (k): k is IDBValidKey & string => typeof k === 'string' && k.startsWith(DRAFT_KEY_PREFIX)
    );

    const now = Date.now();

    for (const fullKey of draftKeys) {
      try {
        const stored = await get<StoredDraft>(fullKey);
        if (stored && now - stored.timestamp > DRAFT_TTL_MS) {
          await del(fullKey);
        }
      } catch (error) {
        console.error(`[draftStorage] Failed to check/delete key ${fullKey}:`, error);
      }
    }
  } catch (error) {
    console.error('[draftStorage] Failed to cleanup expired drafts:', error);
  }
}

export const draftStorage = {
  saveDraft,
  loadDraft,
  deleteDraft,
  cleanupExpired,
};
