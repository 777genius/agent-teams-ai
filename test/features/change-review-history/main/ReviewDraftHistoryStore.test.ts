/** Durable exact-scope manual editor history integration tests. */
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { createHash } from 'crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewSerializedEditorState } from '@features/change-review-history/contracts';

let teamsBasePath: string;

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => teamsBasePath,
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

function editorState(doc: string, done: string[], undone: string[] = []): ReviewSerializedEditorState {
  return {
    doc,
    selection: { ranges: [{ anchor: doc.length, head: doc.length }], main: 0 },
    history: { done, undone },
  };
}

function storedPath(teamName: string, scopeKey: string, scopeToken: string): string {
  const hash = createHash('sha256').update(scopeToken).digest('hex');
  return path.join(
    teamsBasePath,
    teamName,
    'review-decisions',
    'draft-history',
    'v1',
    encodeURIComponent(scopeKey),
    `${hash}.json`
  );
}

describe('ReviewDraftHistoryStore', () => {
  beforeEach(async () => {
    teamsBasePath = await mkdtemp(path.join(tmpdir(), 'review-draft-history-'));
  });

  afterEach(async () => {
    await rm(teamsBasePath, { recursive: true, force: true });
  });

  it('restores exact-scope multi-file history through a new store instance', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const first = new ReviewDraftHistoryStore();
    await first.saveEntry('demo', 'task-123', 'scope-a', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1' as const,
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('ABC', ['B', 'C']),
    });
    await first.saveEntry('demo', 'task-123', 'scope-a', {
      filePath: '/repo/b.ts',
      codec: 'codemirror-history-v1' as const,
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'one',
      editorState: editorState('two', ['replace']),
    });

    const restarted = new ReviewDraftHistoryStore();
    const snapshot = await restarted.load('demo', 'task-123', 'scope-a');
    expect(snapshot?.entries['/repo/a.ts']).toMatchObject({
      revision: 1,
      diskBaseline: 'A',
      editorState: { doc: 'ABC', history: { done: ['B', 'C'], undone: [] } },
    });
    expect(snapshot?.entries['/repo/b.ts']?.editorState.doc).toBe('two');
    await expect(restarted.load('demo', 'task-123', 'scope-b')).resolves.toBeNull();
  });

  it('round-trips an actual CodeMirror history payload through a process restart', async () => {
    const [{ ReviewDraftHistoryStore }, { restoreReviewDraftEditorState, serializeReviewDraftEditorState }] =
      await Promise.all([
        import('@features/change-review-history/main'),
        import('@features/change-review-history/renderer'),
      ]);
    let state = EditorState.create({ doc: 'A', extensions: history({ minDepth: 10_000 }) });
    for (const insert of ['B', 'C', 'D']) {
      state = state.update({
        changes: { from: state.doc.length, insert },
        annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
      }).state;
    }
    const serialized = serializeReviewDraftEditorState(state);

    await new ReviewDraftHistoryStore().saveEntry('demo', 'task-123', 'scope-real', {
      filePath: '/repo/real.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      // A successful Save advances only the disk baseline. The native branch remains so
      // Undo after restart turns this clean buffer into a draft without touching disk.
      diskBaseline: 'ABCD',
      editorState: serialized,
    });
    const snapshot = await new ReviewDraftHistoryStore().load(
      'demo',
      'task-123',
      'scope-real'
    );
    let restored = restoreReviewDraftEditorState(
      snapshot?.entries['/repo/real.ts']?.editorState ?? serialized,
      history({ minDepth: 10_000 })
    );
    expect(restored.doc.toString()).toBe('ABCD');
    expect(snapshot?.entries['/repo/real.ts']?.diskBaseline).toBe('ABCD');
    expect(undoDepth(restored)).toBe(3);
    const target = {
      get state() {
        return restored;
      },
      dispatch(transaction: Transaction) {
        restored = transaction.state;
      },
    } as never;
    expect(undo(target)).toBe(true);
    expect(restored.doc.toString()).toBe('ABC');
    expect(undo(target)).toBe(true);
    expect(restored.doc.toString()).toBe('AB');
    expect(undo(target)).toBe(true);
    expect(restored.doc.toString()).toBe('A');
  });

  it('upgrades a legacy entry with a stable generation before its next write', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const scopeToken = 'scope-legacy';
    const target = storedPath('demo', 'task-123', scopeToken);
    await mkdir(path.dirname(target), { recursive: true });
    const legacyEntry = {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1' as const,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
      updatedAt: '2026-07-18T12:00:00.000Z',
    };
    await writeFile(
      target,
      JSON.stringify({
        version: 1,
        scopeKey: 'task-123',
        scopeTokenHash: createHash('sha256').update(scopeToken).digest('hex'),
        entries: { [legacyEntry.filePath]: legacyEntry },
        updatedAt: legacyEntry.updatedAt,
      }),
      'utf8'
    );

    const store = new ReviewDraftHistoryStore();
    const loaded = await store.load('demo', 'task-123', scopeToken);
    const generation = loaded?.entries[legacyEntry.filePath]?.generation;
    expect(generation).toMatch(/^legacy-[a-f0-9]{64}$/);
    if (!generation) throw new Error('Expected a migrated generation');
    await expect(
      store.saveEntry('demo', 'task-123', scopeToken, {
        filePath: legacyEntry.filePath,
        codec: legacyEntry.codec,
        expectedRevision: 1,
        expectedGeneration: generation,
        revision: 2,
        diskBaseline: 'A',
        editorState: editorState('ABC', ['B', 'C']),
      })
    ).resolves.toMatchObject({ revision: 2, generation: expect.any(String) });
  });

  it('rejects stale writers and revision jumps while accepting response-loss retries', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const store = new ReviewDraftHistoryStore();
    const first = {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1' as const,
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    };
    const savedFirst = await store.saveEntry('demo', 'task-123', 'scope-a', first);
    await expect(store.saveEntry('demo', 'task-123', 'scope-a', first)).resolves.toMatchObject({
      filePath: first.filePath,
      revision: first.revision,
      diskBaseline: first.diskBaseline,
      editorState: first.editorState,
    });
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-a', {
        ...first,
        editorState: editorState('different', ['different']),
      })
    ).rejects.toThrow('Review draft history changed; refusing stale state overwrite');
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-a', {
        ...first,
        revision: 2,
        editorState: editorState('ABC', ['B', 'C']),
      })
    ).rejects.toThrow('Review draft history changed; refusing stale state overwrite');

    const second = {
      ...first,
      expectedRevision: 1,
      expectedGeneration: savedFirst.generation,
      revision: 2,
      editorState: editorState('ABC', ['B', 'C']),
    };
    const savedSecond = await store.saveEntry('demo', 'task-123', 'scope-a', second);
    expect(savedSecond).toMatchObject({
      filePath: second.filePath,
      revision: second.revision,
      diskBaseline: second.diskBaseline,
      editorState: second.editorState,
    });
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-a', {
        ...first,
        revision: 1,
        expectedRevision: 2,
        expectedGeneration: savedSecond.generation,
      })
    ).rejects.toThrow('Invalid review draft history entry');
    await expect(store.load('demo', 'task-123', 'scope-a')).resolves.toMatchObject({
      entries: { '/repo/a.ts': { editorState: { doc: 'ABC' }, revision: 2 } },
    });
  });

  it('rejects an ABA clear after the same file is cleared and recreated at revision one', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const store = new ReviewDraftHistoryStore();
    const original = await store.saveEntry('demo', 'task-123', 'scope-a', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await store.clearEntry('demo', 'task-123', 'scope-a', '/repo/a.ts', 1, original.generation);
    const recreated = await store.saveEntry('demo', 'task-123', 'scope-a', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AC', ['C']),
    });
    expect(recreated.generation).not.toBe(original.generation);

    await expect(
      store.clearEntry('demo', 'task-123', 'scope-a', '/repo/a.ts', 1, original.generation)
    ).rejects.toThrow('Review draft history changed; refusing stale state overwrite');
    await expect(store.load('demo', 'task-123', 'scope-a')).resolves.toMatchObject({
      entries: { '/repo/a.ts': { generation: recreated.generation, editorState: { doc: 'AC' } } },
    });
  });

  it('clears only the requested file and exact scope', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const store = new ReviewDraftHistoryStore();
    let scopeAGeneration = '';
    for (const scopeToken of ['scope-a', 'scope-b']) {
      const saved = await store.saveEntry('demo', 'task-123', scopeToken, {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1' as const,
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('AB', ['B']),
      });
      if (scopeToken === 'scope-a') scopeAGeneration = saved.generation;
    }
    await store.saveEntry('demo', 'task-123', 'scope-a', {
      filePath: '/repo/b.ts',
      codec: 'codemirror-history-v1' as const,
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'B',
      editorState: editorState('BC', ['C']),
    });

    await expect(
      store.clearEntry('demo', 'task-123', 'scope-a', '/repo/a.ts', 0, null)
    ).rejects.toThrow('Review draft history changed; refusing stale state overwrite');
    expect((await store.load('demo', 'task-123', 'scope-a'))?.entries['/repo/a.ts']).toBeTruthy();

    await store.clearEntry('demo', 'task-123', 'scope-a', '/repo/a.ts', 1, scopeAGeneration);
    expect(Object.keys((await store.load('demo', 'task-123', 'scope-a'))?.entries ?? {})).toEqual([
      '/repo/b.ts',
    ]);
    expect((await store.load('demo', 'task-123', 'scope-b'))?.entries['/repo/a.ts']).toBeTruthy();

    await store.clearScope('demo', 'task-123', 'scope-a');
    await expect(store.load('demo', 'task-123', 'scope-a')).resolves.toBeNull();
    expect((await store.load('demo', 'task-123', 'scope-b'))?.entries['/repo/a.ts']).toBeTruthy();
  });

  it('fails closed for corrupt, symlinked, and hardlinked snapshots', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const store = new ReviewDraftHistoryStore();
    const target = storedPath('demo', 'task-123', 'scope-a');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '{broken', 'utf8');
    await expect(store.load('demo', 'task-123', 'scope-a')).rejects.toThrow(
      'Corrupted review draft history file'
    );
    await expect(readFile(target, 'utf8')).resolves.toBe('{broken');

    await rm(target);
    const outside = path.join(teamsBasePath, 'outside.json');
    await writeFile(outside, '{}', 'utf8');
    await symlink(outside, target);
    await expect(store.load('demo', 'task-123', 'scope-a')).rejects.toThrow(
      'Unsafe review draft history symlink'
    );

    await rm(target);
    await link(outside, target);
    await expect(store.load('demo', 'task-123', 'scope-a')).rejects.toThrow(
      'Unsafe or oversized review draft history file'
    );
  });

  it('discards only an unreadable scope and preserves a readable replacement', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const store = new ReviewDraftHistoryStore();
    const target = storedPath('demo', 'task-123', 'scope-a');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '{broken', 'utf8');
    await expect(
      store.clearUnreadableScope('demo', 'task-123', 'scope-a')
    ).resolves.toBeUndefined();
    await expect(store.load('demo', 'task-123', 'scope-a')).resolves.toBeNull();

    await writeFile(target, '{broken-again', 'utf8');
    await expect(store.load('demo', 'task-123', 'scope-a')).rejects.toThrow(
      'Corrupted review draft history file'
    );
    await store.clearScope('demo', 'task-123', 'scope-a');
    const replacement = await store.saveEntry('demo', 'task-123', 'scope-a', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'new',
      editorState: editorState('newer', ['newer']),
    });

    await expect(
      store.clearUnreadableScope('demo', 'task-123', 'scope-a')
    ).rejects.toThrow(
      'Saved manual edit history became readable; refusing destructive recovery discard'
    );
    await expect(store.load('demo', 'task-123', 'scope-a')).resolves.toMatchObject({
      entries: { '/repo/a.ts': { generation: replacement.generation, editorState: { doc: 'newer' } } },
    });
  });

  it('rejects path-like identities and malformed editor states before writing', async () => {
    const { ReviewDraftHistoryStore } = await import(
      '@features/change-review-history/main'
    );
    const store = new ReviewDraftHistoryStore();
    await expect(store.load('../outside', 'task-123', 'scope-a')).rejects.toThrow(
      'Invalid review draft history team name'
    );
    await expect(store.load('demo', '..', 'scope-a')).rejects.toThrow(
      'Invalid review draft history scope key'
    );
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-a', {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1' as const,
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: { doc: 'AB' } as never,
      })
    ).rejects.toThrow('Invalid review draft history entry');
  });
});
