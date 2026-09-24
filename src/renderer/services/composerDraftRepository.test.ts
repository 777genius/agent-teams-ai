import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  operations: [] as string[],
  abortNext: false,
  failNextGetKey: null as string | null,
  prefixScans: 0,
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => {
    if (database.failNextGetKey === key) {
      database.failNextGetKey = null;
      throw new Error('IndexedDB read failed');
    }
    return database.values.get(key);
  }),
}));

vi.mock('@renderer/services/composerDraftIndexedDb', () => ({
  requestValue: async (request: { result: unknown }) => request.result,
  composerDraftEntriesByPrefix: async (_store: IDBObjectStore, prefix: string) => {
    database.prefixScans += 1;
    return [...database.values.entries()].filter(([key]) => key.startsWith(prefix));
  },
  composerDraftReadwrite: async <T>(callback: (store: IDBObjectStore) => Promise<T>) => {
    const staged = new Map(database.values);
    const store = {
      get: (key: string) => {
        database.operations.push(`get:${key}`);
        return { result: staged.get(key) };
      },
      put: (value: unknown, key: string) => {
        database.operations.push(`put:${key}`);
        staged.set(key, value);
      },
      delete: (key: string) => {
        database.operations.push(`delete:${key}`);
        staged.delete(key);
      },
    } as unknown as IDBObjectStore;
    const result = await callback(store);
    if (database.abortNext) {
      database.abortNext = false;
      throw new Error('transaction aborted');
    }
    database.values = staged;
    return result;
  },
}));

import {
  composerDraftAddressKey,
  composerRecoveryIndexKey,
  composerRecoveryKey,
  composerWorkingIndexKey,
  composerWorkingIndexMigrationKey,
  legacyComposerKeys,
} from '@renderer/utils/composerDraftIdentity';

import { IndexedDbComposerDraftRepository } from './composerDraftRepository';

import type { ComposerDraftAddress, PreparedComposerAttempt } from '@renderer/types/composerDraft';

const alice: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'alice' },
};
const bob: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'bob' },
};

function attempt(id: string): PreparedComposerAttempt {
  return {
    attemptId: id,
    snapshot: {
      content: { text: 'alice send', chips: [], attachments: [], actionMode: 'do' },
      editorContext: { kind: 'plain' },
    },
    preparedRequest: {
      kind: 'local',
      teamName: 'team-a',
      request: { member: 'alice', text: 'alice send' },
    },
    createdAt: 1,
  };
}

describe('IndexedDbComposerDraftRepository', () => {
  beforeEach(() => {
    database.values = new Map();
    database.operations = [];
    database.abortNext = false;
    database.failNextGetKey = null;
    database.prefixScans = 0;
  });

  it('atomically clears matching working and writes recovery plus its index', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-1',
      { text: 'alice send', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    const result = await repository.beginAttempt(alice, 'alice-1', attempt('attempt-1'));
    expect(result).toEqual(
      expect.objectContaining({ kind: 'prepared', workingCleared: true, status: 'durable' })
    );
    expect(
      (database.values.get(composerDraftAddressKey(alice)) as { content: unknown }).content
    ).toBeNull();
    expect(database.values.has(composerRecoveryKey(alice, 'attempt-1'))).toBe(true);
    expect(
      (
        database.values.get(composerRecoveryIndexKey('context-a', 'team-a')) as {
          summaries: { id: string }[];
        }
      ).summaries.map((summary) => summary.id)
    ).toEqual(['attempt-1']);
  });

  it('retains accepted sends until their exact canonical message id is observed', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(alice, '0', 'alice-1', attempt('accepted-1').snapshot.content, {
      kind: 'plain',
    });
    await repository.beginAttempt(alice, 'alice-1', attempt('accepted-1'));
    await repository.settleAttempt(alice, 'accepted-1', {
      kind: 'accepted',
      messageId: 'message-exact',
    });

    expect(await repository.loadRecovery('context-a', 'team-a', 'accepted-1')).toEqual(
      expect.objectContaining({
        reason: 'accepted-awaiting-echo',
        outcome: { kind: 'accepted', messageId: 'message-exact' },
      })
    );
    expect((await repository.listRecoveries('context-a', 'team-a')).recoveries).toEqual([
      expect.objectContaining({ id: 'accepted-1', reason: 'accepted-awaiting-echo' }),
    ]);
    expect(
      await repository.reconcileRecovery('context-a', 'team-a', 'accepted-1', 'message-other')
    ).toBe('mismatch');
    expect(database.values.has(composerRecoveryKey(alice, 'accepted-1'))).toBe(true);

    expect(
      await repository.reconcileRecovery('context-a', 'team-a', 'accepted-1', 'message-exact')
    ).toBe('reconciled');
    expect(database.values.has(composerRecoveryKey(alice, 'accepted-1'))).toBe(false);
    expect((await repository.listRecoveries('context-a', 'team-a')).recoveries).toEqual([]);
  });

  it('retains an unconfirmed send even when an inbox echo has the same message id', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(alice, '0', 'alice-1', attempt('unknown-1').snapshot.content, {
      kind: 'plain',
    });
    await repository.beginAttempt(alice, 'alice-1', attempt('unknown-1'));
    await repository.settleAttempt(alice, 'unknown-1', {
      kind: 'unconfirmed',
      messageId: 'message-later',
    });

    expect(await repository.reconcileRecovery('context-a', 'team-a', 'unknown-1', '   ')).toBe(
      'mismatch'
    );
    expect(
      await repository.reconcileRecovery('context-a', 'team-a', 'unknown-1', 'message-later')
    ).toBe('mismatch');
    expect(await repository.loadRecovery('context-a', 'team-a', 'unknown-1')).toEqual(
      expect.objectContaining({ reason: 'unconfirmed-send' })
    );
    expect(database.values.has(composerRecoveryKey(alice, 'unknown-1'))).toBe(true);
  });

  it('keeps both recovery record and index when exact reconciliation aborts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-1',
      attempt('accepted-abort').snapshot.content,
      {
        kind: 'plain',
      }
    );
    await repository.beginAttempt(alice, 'alice-1', attempt('accepted-abort'));
    await repository.settleAttempt(alice, 'accepted-abort', {
      kind: 'accepted',
      messageId: 'message-abort',
    });
    const before = new Map(database.values);
    database.abortNext = true;

    expect(
      await repository.reconcileRecovery('context-a', 'team-a', 'accepted-abort', 'message-abort')
    ).toBe('blocked');
    expect(database.values).toEqual(before);
  });

  it('retains and reconciles accepted sends in the memory-only overlay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new IndexedDbComposerDraftRepository();
    database.abortNext = true;
    expect(
      await repository.saveWorking(
        alice,
        '0',
        'alice-memory',
        attempt('accepted-memory').snapshot.content,
        { kind: 'plain' }
      )
    ).toEqual(expect.objectContaining({ kind: 'saved', status: 'memory-only' }));
    await repository.beginAttempt(alice, 'alice-memory', attempt('accepted-memory'));
    await repository.settleAttempt(alice, 'accepted-memory', {
      kind: 'accepted',
      messageId: 'message-memory',
    });
    expect(await repository.loadRecovery('context-a', 'team-a', 'accepted-memory')).toEqual(
      expect.objectContaining({ reason: 'accepted-awaiting-echo' })
    );
    expect(
      await repository.reconcileRecovery('context-a', 'team-a', 'accepted-memory', 'message-memory')
    ).toBe('reconciled');
    expect(await repository.loadRecovery('context-a', 'team-a', 'accepted-memory')).toBeNull();
  });

  it('refreshes cached indexes before falling back so a newer durable recovery stays available', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(alice, '0', 'alice-1', attempt('old').snapshot.content, {
      kind: 'plain',
    });
    await repository.beginAttempt(alice, 'alice-1', attempt('old'));
    await repository.settleAttempt(alice, 'old', { kind: 'accepted', messageId: 'old-message' });
    await repository.reconcileRecovery('context-a', 'team-a', 'old', 'old-message');

    await repository.beginAttempt(bob, '0', attempt('newer'));
    database.abortNext = true;
    expect(
      await repository.settleAttempt(bob, 'newer', {
        kind: 'unconfirmed',
        messageId: 'newer-message',
      })
    ).toBe('memory-only');

    expect((await repository.listRecoveries('context-a', 'team-a')).recoveries).toEqual([
      expect.objectContaining({ id: 'newer', reason: 'unconfirmed-send' }),
    ]);
    expect(await repository.loadRecovery('context-a', 'team-a', 'newer')).toEqual(
      expect.objectContaining({ id: 'newer', reason: 'unconfirmed-send' })
    );
  });

  it('retains an unconfirmed recovery with a matching inbox echo in memory-only mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new IndexedDbComposerDraftRepository();
    database.abortNext = true;
    await repository.saveWorking(
      alice,
      '0',
      'unknown-memory-working',
      attempt('unknown-memory').snapshot.content,
      { kind: 'plain' }
    );
    await repository.beginAttempt(alice, 'unknown-memory-working', attempt('unknown-memory'));
    await repository.settleAttempt(alice, 'unknown-memory', {
      kind: 'unconfirmed',
      messageId: 'message-in-inbox',
    });

    expect(
      await repository.reconcileRecovery(
        'context-a',
        'team-a',
        'unknown-memory',
        'message-in-inbox'
      )
    ).toBe('mismatch');
    expect(await repository.loadRecovery('context-a', 'team-a', 'unknown-memory')).toEqual(
      expect.objectContaining({ reason: 'unconfirmed-send' })
    );
  });

  it('autosaving Bob never reads or rewrites Alice recovery body', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    database.values.set(composerRecoveryKey(alice, 'attempt-1'), { opaqueLargePayload: true });
    database.operations = [];
    await repository.saveWorking(
      bob,
      '0',
      'bob-1',
      { text: 'bob text', chips: [], attachments: [], actionMode: 'ask' },
      { kind: 'plain' }
    );
    expect(database.operations).toEqual([
      `get:${composerDraftAddressKey(bob)}`,
      `get:${composerWorkingIndexKey('context-a', 'team-a')}`,
      `put:${composerDraftAddressKey(bob)}`,
      `put:${composerWorkingIndexKey('context-a', 'team-a')}`,
    ]);
  });

  it('preserves a future durable working record across save and begin attempts', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    const key = composerDraftAddressKey(alice);
    const futureRaw = {
      version: 99,
      address: alice,
      workingRevision: 'future-1',
      opaquePayload: { text: 'must survive' },
    };
    database.values.set(key, futureRaw);

    const save = await repository.saveWorking(
      alice,
      'future-1',
      'alice-2',
      { text: 'overwrite', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    const begin = await repository.beginAttempt(alice, 'future-1', attempt('attempt-future'));

    expect(save.kind).toBe('blocked');
    expect(begin.kind).toBe('blocked');
    expect(database.values.get(key)).toBe(futureRaw);
    expect(database.values.has(composerRecoveryKey(alice, 'attempt-future'))).toBe(false);
  });

  it('leaves a future recovery index and its records intact when beginning an attempt', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    const indexKey = composerRecoveryIndexKey('context-a', 'team-a');
    const futureIndex = { version: 3, summaries: [{ opaqueRecovery: 'future-1' }] };
    database.values.set(indexKey, futureIndex);

    const result = await repository.beginAttempt(alice, '0', attempt('attempt-future-index'));

    expect(result.kind).toBe('blocked');
    expect(database.values.get(indexKey)).toBe(futureIndex);
    expect(database.values.has(composerRecoveryKey(alice, 'attempt-future-index'))).toBe(false);
  });

  it('blocks malformed nested v2 working content before hydration', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    const key = composerDraftAddressKey(alice);
    const malformed = {
      version: 2,
      address: alice,
      workingRevision: 'bad-content',
      content: {},
      editorContext: { kind: 'plain' },
      updatedAt: 1,
    };
    database.values.set(key, malformed);

    const loaded = await repository.loadWorking(alice);

    expect(loaded).toEqual(expect.objectContaining({ writeBlocked: true, status: 'durable' }));
    expect(loaded.working.content).toBeNull();
    expect(database.values.get(key)).toBe(malformed);
  });

  it('does not hydrate a recovery with malformed nested v2 content', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.beginAttempt(alice, '0', attempt('malformed-recovery'));
    const key = composerRecoveryKey(alice, 'malformed-recovery');
    const valid = database.values.get(key) as Record<string, unknown>;
    const malformed = { ...valid, snapshot: { content: {}, editorContext: { kind: 'plain' } } };
    database.values.set(key, malformed);

    expect(await repository.loadRecovery('context-a', 'team-a', 'malformed-recovery')).toBeNull();
    expect(database.values.get(key)).toBe(malformed);
    expect((await repository.listRecoveries('context-a', 'team-a')).recoveries).toHaveLength(1);
  });

  it('seeds unopened working draft bodies before a failed write enters memory-only mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-durable',
      { text: 'unopened durable draft', chips: [], attachments: [], actionMode: 'ask' },
      { kind: 'plain' }
    );
    const nextSession = new IndexedDbComposerDraftRepository();
    database.abortNext = true;
    await nextSession.saveWorking(
      bob,
      '0',
      'bob-memory',
      { text: 'trigger fallback', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );

    const loaded = await nextSession.loadWorking(alice);
    expect(loaded.status).toBe('memory-only');
    expect(loaded.working.workingRevision).toBe('alice-durable');
    expect(loaded.working.content?.text).toBe('unopened durable draft');
  });

  it('returns the cached draft when a later IndexedDB read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-cached',
      { text: 'keep cached text', chips: [], attachments: [], actionMode: 'ask' },
      { kind: 'plain' }
    );
    database.failNextGetKey = composerDraftAddressKey(alice);

    const loaded = await repository.loadWorking(alice);

    expect(loaded.status).toBe('memory-only');
    expect(loaded.working.workingRevision).toBe('alice-cached');
    expect(loaded.working.content?.text).toBe('keep cached text');
    expect(
      await repository.saveWorking(
        alice,
        loaded.working.workingRevision,
        'alice-memory-edited',
        { text: 'continued edit', chips: [], attachments: [], actionMode: 'ask' },
        { kind: 'plain' }
      )
    ).toEqual(expect.objectContaining({ kind: 'saved', status: 'memory-only' }));
  });

  it('blocks restore onto a future durable record without consuming the source', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(alice, '0', 'alice-1', attempt('attempt-1').snapshot.content, {
      kind: 'plain',
    });
    await repository.beginAttempt(alice, 'alice-1', attempt('attempt-1'));
    const destinationKey = composerDraftAddressKey(bob);
    const futureRaw = {
      version: 3,
      address: bob,
      workingRevision: 'future-bob',
      opaquePayload: ['preserve', 'exactly'],
    };
    database.values.set(destinationKey, futureRaw);

    const result = await repository.restoreRecovery(
      'context-a',
      'team-a',
      'attempt-1',
      bob,
      'future-bob'
    );

    expect(result.kind).toBe('blocked');
    expect(database.values.get(destinationKey)).toBe(futureRaw);
    expect(database.values.has(composerRecoveryKey(alice, 'attempt-1'))).toBe(true);
  });

  it('does not consume recovery when destination is non-empty', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(alice, '0', 'alice-1', attempt('attempt-1').snapshot.content, {
      kind: 'plain',
    });
    await repository.beginAttempt(alice, 'alice-1', attempt('attempt-1'));
    await repository.saveWorking(
      bob,
      '0',
      'bob-1',
      { text: 'occupied', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    const result = await repository.restoreRecovery(
      'context-a',
      'team-a',
      'attempt-1',
      bob,
      'bob-1'
    );
    expect(result.kind).toBe('conflict');
    expect(database.values.has(composerRecoveryKey(alice, 'attempt-1'))).toBe(true);
  });

  it('leaves prior working, recovery and index intact when restore transaction aborts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(alice, '0', 'alice-1', attempt('attempt-1').snapshot.content, {
      kind: 'plain',
    });
    await repository.beginAttempt(alice, 'alice-1', attempt('attempt-1'));
    const before = new Map(database.values);
    database.abortNext = true;
    const result = await repository.restoreRecovery('context-a', 'team-a', 'attempt-1', bob, '0');
    expect(result).toEqual(expect.objectContaining({ kind: 'blocked', status: 'memory-only' }));
    expect(database.values).toEqual(before);
  });

  it('creates and clears the working summary atomically with the working record', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-1',
      { text: 'draft preview', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    expect(
      (
        database.values.get(composerWorkingIndexKey('context-a', 'team-a')) as {
          summaries: { preview: string }[];
        }
      ).summaries
    ).toEqual([expect.objectContaining({ preview: 'draft preview' })]);

    await repository.saveWorking(alice, 'alice-1', 'alice-2', null, { kind: 'plain' });
    expect(
      (
        database.values.get(composerWorkingIndexKey('context-a', 'team-a')) as {
          summaries: unknown[];
        }
      ).summaries
    ).toEqual([]);
  });

  it('keeps a newer working summary when beginAttempt receives a stale revision', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-newer',
      { text: 'newer draft', chips: [], attachments: [], actionMode: 'ask' },
      { kind: 'plain' }
    );
    const result = await repository.beginAttempt(alice, 'stale', attempt('attempt-stale'));
    expect(result).toEqual(expect.objectContaining({ kind: 'prepared', workingCleared: false }));
    const listed = await repository.listWorkingSummaries('context-a', 'team-a');
    expect(listed.summaries).toEqual([
      expect.objectContaining({ workingRevision: 'alice-newer', preview: 'newer draft' }),
    ]);
  });

  it('reports a stash conflict when another repository saves a newer working revision', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    const concurrentRepository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-old',
      { text: 'older draft', chips: [], attachments: [], actionMode: 'ask' },
      { kind: 'plain' }
    );
    const originalLoadWorking = repository.loadWorking.bind(repository);
    vi.spyOn(repository, 'loadWorking').mockImplementationOnce(async (address) => {
      const loaded = await originalLoadWorking(address);
      await concurrentRepository.saveWorking(
        alice,
        'alice-old',
        'alice-newer',
        { text: 'concurrent draft', chips: [], attachments: [], actionMode: 'ask' },
        { kind: 'plain' }
      );
      return loaded;
    });

    const result = await repository.stashWorking(alice, 'alice-old', 'displaced-old');

    expect(result).toEqual(expect.objectContaining({ kind: 'conflict', status: 'durable' }));
    expect((await concurrentRepository.loadWorking(alice)).working).toEqual(
      expect.objectContaining({
        workingRevision: 'alice-newer',
        content: expect.objectContaining({ text: 'concurrent draft' }),
      })
    );
  });

  it('restores a recovery and moves its summary to the empty destination', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(alice, '0', 'alice-1', attempt('attempt-1').snapshot.content, {
      kind: 'plain',
    });
    await repository.beginAttempt(alice, 'alice-1', attempt('attempt-1'));
    const result = await repository.restoreRecovery('context-a', 'team-a', 'attempt-1', bob, '0', {
      asNewMessage: true,
    });
    expect(result.kind).toBe('restored');
    expect(database.values.has(composerRecoveryKey(alice, 'attempt-1'))).toBe(false);
    const listed = await repository.listWorkingSummaries('context-a', 'team-a');
    expect(listed.summaries).toEqual([
      expect.objectContaining({ address: bob, preview: 'alice send', editorKind: 'plain' }),
    ]);
  });

  it('discards an orphan working record and summary only with the matching revision', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-1',
      { text: 'orphan', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    expect(await repository.discardWorking(alice, 'stale')).toBe('conflict');
    expect(database.values.has(composerDraftAddressKey(alice))).toBe(true);
    expect(await repository.discardWorking(alice, 'alice-1')).toBe('discarded');
    expect(database.values.has(composerDraftAddressKey(alice))).toBe(false);
    expect((await repository.listWorkingSummaries('context-a', 'team-a')).summaries).toEqual([]);
  });

  it('moves an unavailable working draft as a plain message without overwriting destination', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await repository.saveWorking(
      alice,
      '0',
      'alice-1',
      { text: 'move me', chips: [], attachments: [], actionMode: 'ask' },
      {
        kind: 'revision',
        originalMessageId: 'original-1',
        recipient: 'alice',
        requestId: 'request-1',
      }
    );
    const result = await repository.moveWorkingAsNew(alice, 'alice-1', bob, '0');
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'restored',
        working: expect.objectContaining({ address: bob, editorContext: { kind: 'plain' } }),
      })
    );
    expect(database.values.has(composerDraftAddressKey(alice))).toBe(false);
    expect((await repository.listWorkingSummaries('context-a', 'team-a')).summaries).toEqual([
      expect.objectContaining({ address: bob, preview: 'move me', editorKind: 'plain' }),
    ]);
  });

  it('does not overwrite a future working-index schema', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    const key = composerWorkingIndexKey('context-a', 'team-a');
    const future = { version: 8, summaries: [{ opaque: true }] };
    database.values.set(key, future);
    const result = await repository.saveWorking(
      alice,
      '0',
      'alice-1',
      { text: 'blocked', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    expect(result.kind).toBe('blocked');
    expect(database.values.get(key)).toBe(future);
    expect(database.values.has(composerDraftAddressKey(alice))).toBe(false);
  });

  it('cleans only the exact v2 namespace and leaves legacy and other contexts untouched', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    const otherContext = { ...alice, contextId: 'context-b' };
    await repository.saveWorking(
      alice,
      '0',
      'alice-1',
      { text: 'delete', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    await repository.saveWorking(
      otherContext,
      '0',
      'other-1',
      { text: 'keep', chips: [], attachments: [], actionMode: 'do' },
      { kind: 'plain' }
    );
    const legacy = legacyComposerKeys('team-a');
    database.values.set(legacy.unified, { text: 'legacy stays' });
    database.values.set(composerWorkingIndexMigrationKey('context-a', 'team-a'), { version: 1 });

    expect(await repository.discardNamespace('context-a', 'team-a')).toBe('discarded');
    expect(database.values.has(composerDraftAddressKey(alice))).toBe(false);
    expect(database.values.has(composerWorkingIndexKey('context-a', 'team-a'))).toBe(false);
    expect(database.values.has(composerWorkingIndexMigrationKey('context-a', 'team-a'))).toBe(
      false
    );
    expect(database.values.has(composerDraftAddressKey(otherContext))).toBe(true);
    expect(database.values.get(legacy.unified)).toEqual({ text: 'legacy stays' });
  });

  it('emits attempt-state when a known active attempt is released', () => {
    const repository = new IndexedDbComposerDraftRepository();
    const events: string[] = [];
    repository.subscribe((event) => events.push(event.kind));
    repository.setAttemptActive('attempt-1', true);
    repository.setAttemptActive('attempt-1', false, alice);
    expect(events).toEqual(['attempt-state']);
  });

  it('backfills the working index only once per repository namespace', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    database.values.set(composerDraftAddressKey(alice), {
      version: 2,
      address: alice,
      workingRevision: 'alice-legacy-v2',
      content: { text: 'backfilled', chips: [], attachments: [], actionMode: 'do' },
      editorContext: { kind: 'plain' },
      updatedAt: 7,
    });
    expect((await repository.listWorkingSummaries('context-a', 'team-a')).summaries).toHaveLength(
      1
    );
    expect((await repository.listWorkingSummaries('context-a', 'team-a')).summaries).toHaveLength(
      1
    );
    expect(database.prefixScans).toBe(1);
    expect(database.values.get(composerWorkingIndexMigrationKey('context-a', 'team-a'))).toEqual({
      version: 1,
    });
  });
});
