import type { RecentProjectsCachePort } from '../../../core/application/ports/RecentProjectsCachePort';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class InMemoryRecentProjectsCache<T> implements RecentProjectsCachePort<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();

  async get(key: string): Promise<T | null> {
    const entry = this.#entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      return null;
    }

    return entry.value;
  }

  async getStale(key: string): Promise<T | null> {
    return this.#entries.get(key)?.value ?? null;
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    this.#entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }
}
