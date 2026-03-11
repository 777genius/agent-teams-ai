import { del, get, set } from 'idb-keyval';

import { sanitizePersistedGridLayoutState } from './gridLayoutSchema';

import type { GridLayoutRepository } from './GridLayoutRepository';
import type { PersistedGridLayoutState } from './gridLayoutTypes';

const STORAGE_KEY_PREFIX = 'grid-layout:';

function storageKey(scopeKey: string): string {
  return `${STORAGE_KEY_PREFIX}${scopeKey}`;
}

function readLocalStorage(key: string): PersistedGridLayoutState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return sanitizePersistedGridLayoutState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, state: PersistedGridLayoutState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Ignore quota/storage errors and fall back to memory.
  }
}

function removeLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

export class BrowserGridLayoutRepository implements GridLayoutRepository<PersistedGridLayoutState> {
  private idbUnavailable = false;
  private readonly fallbackStore = new Map<string, PersistedGridLayoutState>();

  async load(scopeKey: string): Promise<PersistedGridLayoutState | null> {
    const key = storageKey(scopeKey);

    if (!this.idbUnavailable) {
      try {
        const stored = await get<unknown>(key);
        const sanitized = sanitizePersistedGridLayoutState(stored);
        if (sanitized) {
          return sanitized;
        }
      } catch {
        this.idbUnavailable = true;
      }
    }

    return this.fallbackStore.get(key) ?? readLocalStorage(key);
  }

  async save(scopeKey: string, state: PersistedGridLayoutState): Promise<void> {
    const key = storageKey(scopeKey);
    const sanitized = sanitizePersistedGridLayoutState(state);
    if (!sanitized) {
      return;
    }

    this.fallbackStore.set(key, sanitized);
    writeLocalStorage(key, sanitized);

    if (!this.idbUnavailable) {
      try {
        await set(key, sanitized);
      } catch {
        this.idbUnavailable = true;
      }
    }
  }

  async clear(scopeKey: string): Promise<void> {
    const key = storageKey(scopeKey);
    this.fallbackStore.delete(key);
    removeLocalStorage(key);

    if (!this.idbUnavailable) {
      try {
        await del(key);
      } catch {
        this.idbUnavailable = true;
      }
    }
  }
}

export const browserGridLayoutRepository = new BrowserGridLayoutRepository();
