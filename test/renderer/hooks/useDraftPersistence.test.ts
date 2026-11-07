import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { draftStorage } from '@renderer/services/draftStorage';
import { set as idbSet } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock idb-keyval before importing draftStorage
const store = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => vi.fn()),
  promisifyRequest: vi.fn(() => Promise.resolve()),
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

  describe('create-team save/clear ordering', () => {
    it('does not resurrect creation text after an earlier save finishes late', async () => {
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
      vi.mocked(idbSet).mockImplementationOnce(async (key, value) => {
        await saveGate;
        store.set(String(key), value);
      });
      const save = draftStorage.saveDraft('createTeam:prompt', 'unsent prompt');
      const clear = draftStorage.deleteDraft('createTeam:prompt');
      await Promise.resolve();
      releaseSave();
      await Promise.all([save, clear]);
      expect(await draftStorage.loadDraft('createTeam:prompt')).toBeNull();
    });

    it('waits for an in-flight creation save before attempting to restore it', async () => {
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
      vi.mocked(idbSet).mockImplementationOnce(async (key, value) => {
        await saveGate;
        store.set(String(key), value);
      });
      const save = draftStorage.saveDraft('createTeam:description', 'late update');
      const restoring = draftStorage.loadDraft('createTeam:description');
      await Promise.resolve();
      releaseSave();
      await save;
      expect(await restoring).toBe('late update');
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
    it.each(['createTeam:description', 'createTeam:prompt', 'createTeam:prompt:chips'])(
      'retains unfinished creation data past the generic 24-hour TTL (%s)',
      async (key) => {
        await draftStorage.saveDraft(key, 'unfinished team work');
        const fullKey = `draft:${key}`;
        const stored = store.get(fullKey) as { value: string; timestamp: number };
        store.set(fullKey, { ...stored, timestamp: Date.now() - 30 * 86400000 });

        await draftStorage.cleanupExpired();

        expect(await draftStorage.loadDraft(key)).toBe('unfinished team work');
      }
    );

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

    it('preserves legacy composer drafts for explicit recovery', async () => {
      const old = { value: 'legacy composer text', timestamp: Date.now() - 30 * 86400000 };
      store.set('draft:compose:team-a', old);
      store.set('draft:compose:team-a:chips', old);
      store.set('draft:expired-other', old);

      await draftStorage.cleanupExpired();

      expect(store.get('draft:compose:team-a')).toEqual(old);
      expect(store.get('draft:compose:team-a:chips')).toEqual(old);
      expect(store.has('draft:expired-other')).toBe(false);
    });
  });
});

describe('draft hydration ordering', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves fresh input and its pending save when an older draft finishes loading', async () => {
    let finishLoad!: (value: string | null) => void;
    const load = vi.spyOn(draftStorage, 'loadDraft').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        })
    );
    const save = vi.spyOn(draftStorage, 'saveDraft').mockResolvedValue(undefined);
    let draft!: ReturnType<typeof useDraftPersistence>;
    function Input(): ReactElement {
      draft = useDraftPersistence({ key: 'sandbox:prompt-hydration', debounceMs: 10000 });
      return createElement('textarea', { value: draft.value, readOnly: true });
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(createElement(Input));
      });
      await act(async () => {
        draft.setValue('Freshly typed request');
      });
      await act(async () => {
        finishLoad('Older saved request');
      });
      expect(host.querySelector('textarea')?.value).toBe('Freshly typed request');
      await act(async () => {
        root.unmount();
      });
      expect(save).toHaveBeenCalledWith('sandbox:prompt-hydration', 'Freshly typed request', undefined);
    } finally {
      await act(async () => {
        root.unmount();
      });
      load.mockRestore();
      save.mockRestore();
    }
  });
});
