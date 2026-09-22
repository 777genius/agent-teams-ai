import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock idb-keyval before importing draftStorage
const store = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? undefined)),
  set: vi.fn((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    store.delete(key);
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve([...store.keys()])),
}));

import { draftStorage } from '@renderer/services/draftStorage';

describe('draftStorage', () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveDraft / loadDraft', () => {
    it('should save and load a draft', async () => {
      await draftStorage.saveDraft('test:field', 'hello world');
      const result = await draftStorage.loadDraft('test:field');
      expect(result).toBe('hello world');
    });

    it('should return null for non-existent draft', async () => {
      const result = await draftStorage.loadDraft('nonexistent');
      expect(result).toBeNull();
    });

    it('should overwrite existing draft', async () => {
      await draftStorage.saveDraft('test:field', 'first');
      await draftStorage.saveDraft('test:field', 'second');
      const result = await draftStorage.loadDraft('test:field');
      expect(result).toBe('second');
    });
  });

  describe('deleteDraft', () => {
    it('should delete a draft', async () => {
      await draftStorage.saveDraft('test:field', 'to delete');
      await draftStorage.deleteDraft('test:field');
      const result = await draftStorage.loadDraft('test:field');
      expect(result).toBeNull();
    });

    it('should not throw when deleting non-existent draft', async () => {
      await expect(draftStorage.deleteDraft('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('TTL expiry', () => {
    it('should return null for expired drafts', async () => {
      // Save a draft, then manually set old timestamp
      await draftStorage.saveDraft('test:field', 'old data');

      // Modify stored data to have old timestamp (>24h ago)
      const key = 'draft:test:field';
      const stored = store.get(key) as { value: string; timestamp: number };
      store.set(key, { ...stored, timestamp: Date.now() - 25 * 60 * 60 * 1000 });

      const result = await draftStorage.loadDraft('test:field');
      expect(result).toBeNull();
    });

    it('should return value for non-expired drafts', async () => {
      await draftStorage.saveDraft('test:field', 'fresh data');

      // Modify timestamp to be 23h ago (within TTL)
      const key = 'draft:test:field';
      const stored = store.get(key) as { value: string; timestamp: number };
      store.set(key, { ...stored, timestamp: Date.now() - 23 * 60 * 60 * 1000 });

      const result = await draftStorage.loadDraft('test:field');
      expect(result).toBe('fresh data');
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired drafts', async () => {
      await draftStorage.saveDraft('test:a', 'value a');
      await draftStorage.saveDraft('test:b', 'value b');

      // Make 'a' expired
      const keyA = 'draft:test:a';
      const storedA = store.get(keyA) as { value: string; timestamp: number };
      store.set(keyA, { ...storedA, timestamp: Date.now() - 25 * 60 * 60 * 1000 });

      await draftStorage.cleanupExpired();

      expect(await draftStorage.loadDraft('test:a')).toBeNull();
      expect(await draftStorage.loadDraft('test:b')).toBe('value b');
    });

    it('should not affect non-draft keys', async () => {
      store.set('other-key', { data: 'something' });
      await draftStorage.saveDraft('test:field', 'draft value');

      await draftStorage.cleanupExpired();

      expect(store.has('other-key')).toBe(true);
      expect(await draftStorage.loadDraft('test:field')).toBe('draft value');
    });
  });
});
