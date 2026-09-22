import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock idb-keyval before importing composerDraftStorage
const store = new Map<string, unknown>();

interface MockIdbRequest {
  result: unknown;
  error: null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function createMockGetRequest(result: unknown): MockIdbRequest {
  const request: MockIdbRequest = {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
  };

  queueMicrotask(() => {
    request.onsuccess?.();
  });

  return request;
}

async function useMockObjectStore<T>(
  _txMode: IDBTransactionMode,
  callback: (objectStore: IDBObjectStore) => T | PromiseLike<T>
): Promise<T> {
  const objectStore = {
    transaction: {},
    get: (key: string) => createMockGetRequest(store.get(key) ?? undefined),
    delete: (key: string) => {
      store.delete(key);
    },
  };

  return callback(objectStore as unknown as IDBObjectStore);
}

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => useMockObjectStore),
  promisifyRequest: vi.fn(() => Promise.resolve(undefined)),
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

import {
  composerDraftStorage,
  type ComposerDraftSnapshot,
} from '@renderer/services/composerDraftStorage';

function makeSnapshot(
  teamName: string,
  overrides?: Partial<ComposerDraftSnapshot>
): ComposerDraftSnapshot {
  return {
    version: 1,
    teamName,
    text: 'hello',
    chips: [],
    attachments: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('composerDraftStorage', () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveSnapshot / loadSnapshot', () => {
    it('should save and load a snapshot', async () => {
      const snap = makeSnapshot('team-a');
      await composerDraftStorage.saveSnapshot('team-a', snap);
      const result = await composerDraftStorage.loadSnapshot('team-a');
      expect(result).toEqual(snap);
    });

    it('should return null for non-existent snapshot', async () => {
      const result = await composerDraftStorage.loadSnapshot('nonexistent');
      expect(result).toBeNull();
    });

    it('should overwrite existing snapshot', async () => {
      const snap1 = makeSnapshot('team-a', { text: 'first' });
      const snap2 = makeSnapshot('team-a', { text: 'second' });
      await composerDraftStorage.saveSnapshot('team-a', snap1);
      await composerDraftStorage.saveSnapshot('team-a', snap2);
      const result = await composerDraftStorage.loadSnapshot('team-a');
      expect(result?.text).toBe('second');
    });

    it('should NOT have TTL — drafts persist indefinitely', async () => {
      const snap = makeSnapshot('team-a', {
        updatedAt: Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
      });
      await composerDraftStorage.saveSnapshot('team-a', snap);
      const result = await composerDraftStorage.loadSnapshot('team-a');
      expect(result).toEqual(snap);
    });
  });

  describe('deleteSnapshot', () => {
    it('should delete a snapshot', async () => {
      const snap = makeSnapshot('team-a');
      await composerDraftStorage.saveSnapshot('team-a', snap);
      await composerDraftStorage.deleteSnapshot('team-a');
      const result = await composerDraftStorage.loadSnapshot('team-a');
      expect(result).toBeNull();
    });

    it('should not throw when deleting non-existent snapshot', async () => {
      await expect(composerDraftStorage.deleteSnapshot('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('deleteSnapshotIfMatches', () => {
    it('should delete a snapshot when the predicate matches', async () => {
      await composerDraftStorage.saveSnapshot(
        'team-a',
        makeSnapshot('team-a', { pendingSendId: 'send-1' })
      );

      await composerDraftStorage.deleteSnapshotIfMatches(
        'team-a',
        (snapshot) => snapshot?.pendingSendId === 'send-1'
      );

      expect(await composerDraftStorage.loadSnapshot('team-a')).toBeNull();
    });

    it('should keep a snapshot when the predicate does not match', async () => {
      const snap = makeSnapshot('team-a', { pendingSendId: 'newer-send' });
      await composerDraftStorage.saveSnapshot('team-a', snap);

      await composerDraftStorage.deleteSnapshotIfMatches(
        'team-a',
        (snapshot) => snapshot?.pendingSendId === 'older-send'
      );

      expect(await composerDraftStorage.loadSnapshot('team-a')).toEqual(snap);
    });
  });

  describe('team isolation', () => {
    it('should isolate drafts by teamName', async () => {
      const snapA = makeSnapshot('team-a', { text: 'from team A' });
      const snapB = makeSnapshot('team-b', { text: 'from team B' });
      await composerDraftStorage.saveSnapshot('team-a', snapA);
      await composerDraftStorage.saveSnapshot('team-b', snapB);

      const resultA = await composerDraftStorage.loadSnapshot('team-a');
      const resultB = await composerDraftStorage.loadSnapshot('team-b');
      expect(resultA?.text).toBe('from team A');
      expect(resultB?.text).toBe('from team B');
    });

    it('deleting one team draft should not affect another', async () => {
      await composerDraftStorage.saveSnapshot('team-a', makeSnapshot('team-a'));
      await composerDraftStorage.saveSnapshot('team-b', makeSnapshot('team-b'));
      await composerDraftStorage.deleteSnapshot('team-a');

      expect(await composerDraftStorage.loadSnapshot('team-a')).toBeNull();
      expect(await composerDraftStorage.loadSnapshot('team-b')).not.toBeNull();
    });
  });

  describe('legacy migration', () => {
    it('should migrate text from old draft:compose:<teamName> key', async () => {
      // Simulate old storage format
      store.set('draft:compose:my-team', { value: 'old text', timestamp: Date.now() });

      const result = await composerDraftStorage.migrateLegacy('my-team');
      expect(result).not.toBeNull();
      expect(result!.text).toBe('old text');
      expect(result!.teamName).toBe('my-team');

      // Legacy keys should be deleted
      expect(store.has('draft:compose:my-team')).toBe(false);

      // New snapshot key should exist
      const loaded = await composerDraftStorage.loadSnapshot('my-team');
      expect(loaded?.text).toBe('old text');
    });

    it('should migrate chips from old draft:compose:<teamName>:chips key', async () => {
      const chips = [
        {
          id: 'c1',
          filePath: '/test/file.ts',
          fileName: 'file.ts',
          fromLine: 1,
          toLine: 10,
          codeText: 'code',
          language: 'typescript',
        },
      ];
      store.set('draft:compose:my-team:chips', {
        value: JSON.stringify(chips),
        timestamp: Date.now(),
      });

      const result = await composerDraftStorage.migrateLegacy('my-team');
      expect(result).not.toBeNull();
      expect(result!.chips).toHaveLength(1);
      expect(result!.chips[0].id).toBe('c1');

      // Legacy key should be cleaned up
      expect(store.has('draft:compose:my-team:chips')).toBe(false);
    });

    it('should migrate attachments from old draft:compose:<teamName>:attachments key', async () => {
      const attachments = [
        {
          id: 'a1',
          filename: 'test.png',
          mimeType: 'image/png',
          size: 1024,
          data: 'base64data',
        },
      ];
      store.set('draft:compose:my-team:attachments', {
        value: JSON.stringify(attachments),
        timestamp: Date.now(),
      });

      const result = await composerDraftStorage.migrateLegacy('my-team');
      expect(result).not.toBeNull();
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].id).toBe('a1');
    });

    it('should return null when no legacy data exists', async () => {
      const result = await composerDraftStorage.migrateLegacy('nonexistent');
      expect(result).toBeNull();
    });

    it('should combine all three legacy sources into one snapshot', async () => {
      store.set('draft:compose:my-team', { value: 'combined text', timestamp: Date.now() });
      store.set('draft:compose:my-team:chips', {
        value: JSON.stringify([
          {
            id: 'c1',
            filePath: '/f.ts',
            fileName: 'f.ts',
            fromLine: 1,
            toLine: 2,
            codeText: 'x',
            language: 'ts',
          },
        ]),
        timestamp: Date.now(),
      });
      store.set('draft:compose:my-team:attachments', {
        value: JSON.stringify([
          { id: 'a1', filename: 'img.png', mimeType: 'image/png', size: 512, data: 'b64' },
        ]),
        timestamp: Date.now(),
      });

      const result = await composerDraftStorage.migrateLegacy('my-team');
      expect(result).not.toBeNull();
      expect(result!.text).toBe('combined text');
      expect(result!.chips).toHaveLength(1);
      expect(result!.attachments).toHaveLength(1);

      // All legacy keys cleaned up
      expect(store.has('draft:compose:my-team')).toBe(false);
      expect(store.has('draft:compose:my-team:chips')).toBe(false);
      expect(store.has('draft:compose:my-team:attachments')).toBe(false);
    });

    it('should clean up empty legacy keys without creating a snapshot', async () => {
      store.set('draft:compose:my-team', { value: '', timestamp: Date.now() });

      const result = await composerDraftStorage.migrateLegacy('my-team');
      expect(result).toBeNull();
      expect(store.has('draft:compose:my-team')).toBe(false);
    });
  });

  describe('emptySnapshot', () => {
    it('should create an empty snapshot for given teamName', () => {
      const snap = composerDraftStorage.emptySnapshot('test-team');
      expect(snap.teamName).toBe('test-team');
      expect(snap.text).toBe('');
      expect(snap.chips).toEqual([]);
      expect(snap.attachments).toEqual([]);
      expect(snap.version).toBe(1);
    });
  });

  describe('invalid data handling', () => {
    it('should return null and discard invalid snapshot data', async () => {
      store.set('composer:bad-team', { garbage: true });
      const result = await composerDraftStorage.loadSnapshot('bad-team');
      expect(result).toBeNull();
      // Invalid data should be deleted
      expect(store.has('composer:bad-team')).toBe(false);
    });

    it('should discard snapshot missing required fields', async () => {
      store.set('composer:partial', { version: 1, teamName: 'partial', text: 'hi' });
      const result = await composerDraftStorage.loadSnapshot('partial');
      expect(result).toBeNull();
      expect(store.has('composer:partial')).toBe(false);
    });
  });

  describe('clear-on-send flow', () => {
    it('should delete snapshot and return null on next load', async () => {
      const snap = makeSnapshot('team-send', { text: 'about to send' });
      await composerDraftStorage.saveSnapshot('team-send', snap);

      // Simulate clear-on-send
      await composerDraftStorage.deleteSnapshot('team-send');
      const afterClear = await composerDraftStorage.loadSnapshot('team-send');
      expect(afterClear).toBeNull();
    });

    it('should allow saving a new draft after clear', async () => {
      const snap1 = makeSnapshot('team-send', { text: 'first message' });
      await composerDraftStorage.saveSnapshot('team-send', snap1);
      await composerDraftStorage.deleteSnapshot('team-send');

      // New draft after clear
      const snap2 = makeSnapshot('team-send', { text: 'second draft' });
      await composerDraftStorage.saveSnapshot('team-send', snap2);
      const result = await composerDraftStorage.loadSnapshot('team-send');
      expect(result?.text).toBe('second draft');
    });
  });

  describe('concurrent / rapid saves', () => {
    it('should resolve to the last written snapshot', async () => {
      const snaps = Array.from({ length: 5 }, (_, i) =>
        makeSnapshot('team-rapid', { text: `iteration-${i}` })
      );

      // Fire all saves concurrently
      await Promise.all(snaps.map((s) => composerDraftStorage.saveSnapshot('team-rapid', s)));

      const result = await composerDraftStorage.loadSnapshot('team-rapid');
      // Last save wins — the mock store is synchronous, so the last set() call wins
      expect(result?.text).toBe('iteration-4');
    });

    it('should handle interleaved save and delete', async () => {
      await composerDraftStorage.saveSnapshot('team-x', makeSnapshot('team-x', { text: 'v1' }));
      // Delete then immediately save again
      await composerDraftStorage.deleteSnapshot('team-x');
      await composerDraftStorage.saveSnapshot('team-x', makeSnapshot('team-x', { text: 'v2' }));

      const result = await composerDraftStorage.loadSnapshot('team-x');
      expect(result?.text).toBe('v2');
    });
  });

  describe('full data roundtrip', () => {
    it('should preserve text, chips, and attachments together', async () => {
      const snap = makeSnapshot('team-full', {
        text: 'Hello @alice',
        chips: [
          {
            id: 'chip-1',
            filePath: '/src/index.ts',
            fileName: 'index.ts',
            fromLine: 1,
            toLine: 10,
            codeText: 'const x = 1;',
            language: 'typescript',
          },
        ],
        attachments: [
          {
            id: 'att-1',
            filename: 'screenshot.png',
            mimeType: 'image/png',
            size: 2048,
            data: 'iVBORw0KGgo=',
          },
        ],
      });
      await composerDraftStorage.saveSnapshot('team-full', snap);
      const result = await composerDraftStorage.loadSnapshot('team-full');

      expect(result).not.toBeNull();
      expect(result!.text).toBe('Hello @alice');
      expect(result!.chips).toHaveLength(1);
      expect(result!.chips[0].filePath).toBe('/src/index.ts');
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].filename).toBe('screenshot.png');
      expect(result!.attachments[0].size).toBe(2048);
    });
  });

  describe('recovery after restart', () => {
    it('should load draft saved in a previous session (simulated)', async () => {
      // Simulate saving in "session 1"
      const snap = makeSnapshot('team-persist', {
        text: 'Unsent message from last session',
        updatedAt: Date.now() - 3600_000, // 1 hour ago
      });
      await composerDraftStorage.saveSnapshot('team-persist', snap);

      // Simulate "session 2" — load the same key
      const result = await composerDraftStorage.loadSnapshot('team-persist');
      expect(result).not.toBeNull();
      expect(result!.text).toBe('Unsent message from last session');
    });

    it('should recover draft saved 30 days ago (no TTL)', async () => {
      const snap = makeSnapshot('team-old', {
        text: 'Ancient draft',
        updatedAt: Date.now() - 30 * 24 * 3600_000,
      });
      await composerDraftStorage.saveSnapshot('team-old', snap);
      const result = await composerDraftStorage.loadSnapshot('team-old');
      expect(result).not.toBeNull();
      expect(result!.text).toBe('Ancient draft');
    });
  });
});

describe('composerDraftStorage — IDB failure fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fall back to in-memory store when IDB set throws', async () => {
    // Make idb set throw to trigger fallback
    const { set: idbSet } = await import('idb-keyval');
    const mockSet = vi.mocked(idbSet);
    mockSet.mockRejectedValueOnce(new Error('QuotaExceeded'));

    // Re-import to get a fresh module with idbUnavailable = false
    const { composerDraftStorage: freshStorage } = await import(
      '@renderer/services/composerDraftStorage'
    );

    const snap: ComposerDraftSnapshot = {
      version: 1,
      teamName: 'fallback-team',
      text: 'saved to memory',
      chips: [],
      attachments: [],
      updatedAt: Date.now(),
    };

    // First save triggers the error → fallback kicks in
    await freshStorage.saveSnapshot('fallback-team', snap);

    // Subsequent load uses in-memory fallback
    const result = await freshStorage.loadSnapshot('fallback-team');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('saved to memory');
  });

  it('should allow delete from in-memory fallback', async () => {
    const { set: idbSet } = await import('idb-keyval');
    const mockSet = vi.mocked(idbSet);
    mockSet.mockRejectedValueOnce(new Error('IDB broken'));

    const { composerDraftStorage: freshStorage } = await import(
      '@renderer/services/composerDraftStorage'
    );

    const snap: ComposerDraftSnapshot = {
      version: 1,
      teamName: 'del-team',
      text: 'to delete',
      chips: [],
      attachments: [],
      updatedAt: Date.now(),
    };

    await freshStorage.saveSnapshot('del-team', snap);
    await freshStorage.deleteSnapshot('del-team');

    const result = await freshStorage.loadSnapshot('del-team');
    expect(result).toBeNull();
  });
});
