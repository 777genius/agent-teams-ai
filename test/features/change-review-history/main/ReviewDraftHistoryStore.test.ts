/** Durable exact-scope manual editor history integration tests. */
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { createHash } from 'crypto';
import * as fs from 'fs';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
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

function editorState(
  doc: string,
  done: string[],
  undone: string[] = []
): ReviewSerializedEditorState {
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
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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

  it('does not prune the canonical side of an unresolved older-scope draft conflict', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const scopeKey = 'task-prune-conflict';
    const conflictedToken = 'scope-conflicted';
    const canonical = await store.saveEntry('demo', scopeKey, conflictedToken, {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await expect(
      store.saveEntry('demo', scopeKey, conflictedToken, {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('AC', ['C']),
      })
    ).rejects.toThrow('Review draft history changed');
    await utimes(
      storedPath('demo', scopeKey, conflictedToken),
      new Date('2020-01-01T00:00:00.000Z'),
      new Date('2020-01-01T00:00:00.000Z')
    );

    for (let index = 0; index < 17; index++) {
      await store.saveEntry('demo', scopeKey, `scope-new-${index}`, {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState(`new-${index}`, []),
      });
    }

    await expect(store.load('demo', scopeKey, conflictedToken)).resolves.toMatchObject({
      entries: { '/repo/a.ts': { editorState: { doc: 'AB' } } },
    });
    const [candidate] = await store.loadConflictCandidates('demo', scopeKey, conflictedToken);
    expect(candidate).toBeDefined();
    await store.resolveConflictCandidate(
      'demo',
      scopeKey,
      conflictedToken,
      candidate!.id,
      'keep-current',
      1,
      canonical.generation
    );
    await store.saveEntry('demo', scopeKey, 'scope-new-after-resolution', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('newest', []),
    });

    await expect(store.load('demo', scopeKey, conflictedToken)).resolves.toBeNull();
  });

  it('round-trips an actual CodeMirror history payload through a process restart', async () => {
    const [
      { ReviewDraftHistoryStore },
      { restoreReviewDraftEditorState, serializeReviewDraftEditorState },
    ] = await Promise.all([
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
    const snapshot = await new ReviewDraftHistoryStore().load('demo', 'task-123', 'scope-real');
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
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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

  it('durably preserves and explicitly recovers a divergent editor branch', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const first = new ReviewDraftHistoryStore();
    const saved = await first.saveEntry('demo', 'task-123', 'scope-conflict', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await expect(
      first.saveEntry('demo', 'task-123', 'scope-conflict', {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('AC', ['C']),
      })
    ).rejects.toThrow('Review draft history changed; refusing stale state overwrite');

    const restarted = new ReviewDraftHistoryStore();
    const [candidate] = await restarted.loadConflictCandidates(
      'demo',
      'task-123',
      'scope-conflict'
    );
    expect(candidate).toMatchObject({
      filePath: '/repo/a.ts',
      expectedRevision: 0,
      observedCurrentRevision: 1,
      entry: { editorState: { doc: 'AC' } },
    });
    if (process.platform !== 'win32') {
      const candidateStats = await stat(
        path.join(
          teamsBasePath,
          'demo',
          'review-decisions',
          'draft-history',
          'conflicts',
          'v1',
          'task-123',
          createHash('sha256').update('scope-conflict').digest('hex'),
          candidate!.id + '.json'
        )
      );
      expect(candidateStats.mode & 0o777).toBe(0o600);
    }

    await expect(
      restarted.resolveConflictCandidate(
        'demo',
        'task-123',
        'scope-conflict',
        candidate!.id,
        'recover-candidate',
        1,
        saved.generation
      )
    ).resolves.toMatchObject({ revision: 2, editorState: { doc: 'AC' } });
    await expect(restarted.load('demo', 'task-123', 'scope-conflict')).resolves.toMatchObject({
      entries: { '/repo/a.ts': { revision: 2, editorState: { doc: 'AC' } } },
    });
    const [canonicalBackup] = await restarted.loadConflictCandidates(
      'demo',
      'task-123',
      'scope-conflict'
    );
    expect(canonicalBackup).toMatchObject({
      observedCurrentRevision: 2,
      entry: { editorState: { doc: 'AB' } },
    });
    const recoveredCanonical = await restarted.resolveConflictCandidate(
      'demo',
      'task-123',
      'scope-conflict',
      canonicalBackup!.id,
      'recover-candidate',
      2,
      (await restarted.load('demo', 'task-123', 'scope-conflict'))!.entries['/repo/a.ts']!
        .generation
    );
    expect(recoveredCanonical).toMatchObject({
      revision: 3,
      editorState: { doc: 'AB' },
    });
  });

  it('recovers a prior-snapshot manual edit and preserves the current target branch', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const scopeTokenA = 'scope-prior-draft-a';
    const scopeTokenB = 'scope-prior-draft-b';
    await store.saveEntry('demo', 'task-123', scopeTokenA, {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await expect(
      store.saveEntry('demo', 'task-123', scopeTokenA, {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('AC', ['C']),
      })
    ).rejects.toThrow('Review draft history changed');
    const currentB = await store.saveEntry('demo', 'task-123', scopeTokenB, {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AD', ['D']),
    });

    const [candidate] = await new ReviewDraftHistoryStore().loadConflictCandidates(
      'demo',
      'task-123',
      scopeTokenB
    );
    expect(candidate).toMatchObject({
      origin: 'prior-snapshot',
      observedCurrentRevision: 1,
      observedCurrentGeneration: currentB.generation,
      entry: { editorState: { doc: 'AC' } },
    });
    const newerB = await store.saveEntry('demo', 'task-123', scopeTokenB, {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 1,
      expectedGeneration: currentB.generation,
      revision: 2,
      diskBaseline: 'A',
      editorState: editorState('ADE', ['D', 'E']),
    });
    await expect(
      store.resolveConflictCandidate(
        'demo',
        'task-123',
        scopeTokenB,
        candidate!.id,
        'recover-candidate',
        1,
        currentB.generation
      )
    ).rejects.toThrow('changed again');
    const recovered = await store.resolveConflictCandidate(
      'demo',
      'task-123',
      scopeTokenB,
      candidate!.id,
      'recover-candidate',
      2,
      newerB.generation
    );
    expect(recovered).toMatchObject({ revision: 3, editorState: { doc: 'AC' } });
    await expect(store.load('demo', 'task-123', scopeTokenB)).resolves.toMatchObject({
      entries: { '/repo/a.ts': { revision: 3, editorState: { doc: 'AC' } } },
    });
    await expect(store.loadConflictCandidates('demo', 'task-123', scopeTokenB)).resolves.toEqual([
      expect.objectContaining({
        origin: 'current-snapshot',
        observedCurrentRevision: 3,
        entry: expect.objectContaining({ editorState: expect.objectContaining({ doc: 'ADE' }) }),
      }),
    ]);
  });

  it('preserves an empty manual-edit branch and switches back to it', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const saved = await store.saveEntry('demo', 'task-123', 'scope-empty-branch', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await store.clearEntry(
      'demo',
      'task-123',
      'scope-empty-branch',
      '/repo/a.ts',
      1,
      saved.generation
    );
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-empty-branch', {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 1,
        expectedGeneration: saved.generation,
        revision: 2,
        diskBaseline: 'A',
        editorState: editorState('AC', ['C']),
      })
    ).rejects.toThrow('Review draft history changed; refusing stale state overwrite');

    const [recovery] = await store.loadConflictCandidates('demo', 'task-123', 'scope-empty-branch');
    const recovered = await store.resolveConflictCandidate(
      'demo',
      'task-123',
      'scope-empty-branch',
      recovery!.id,
      'recover-candidate',
      0,
      null
    );
    expect(recovered).toMatchObject({ revision: 1, editorState: { doc: 'AC' } });

    const [emptyBranch] = await store.loadConflictCandidates(
      'demo',
      'task-123',
      'scope-empty-branch'
    );
    expect(emptyBranch).toMatchObject({
      filePath: '/repo/a.ts',
      observedCurrentRevision: 1,
      entry: null,
    });
    await expect(
      store.resolveConflictCandidate(
        'demo',
        'task-123',
        'scope-empty-branch',
        emptyBranch!.id,
        'recover-candidate',
        1,
        recovered!.generation
      )
    ).resolves.toBeNull();
    await expect(store.load('demo', 'task-123', 'scope-empty-branch')).resolves.toBeNull();

    const [recoveredBackup] = await store.loadConflictCandidates(
      'demo',
      'task-123',
      'scope-empty-branch'
    );
    expect(recoveredBackup).toMatchObject({
      observedCurrentRevision: 0,
      entry: { editorState: { doc: 'AC' } },
    });
  });

  it('keeps authoritative editor history when a conflict candidate is dismissed', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const saved = await store.saveEntry('demo', 'task-123', 'scope-dismiss', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-dismiss', {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('AC', ['C']),
      })
    ).rejects.toThrow();
    const [candidate] = await store.loadConflictCandidates('demo', 'task-123', 'scope-dismiss');

    await expect(
      store.resolveConflictCandidate(
        'demo',
        'task-123',
        'scope-dismiss',
        candidate!.id,
        'keep-current',
        1,
        saved.generation
      )
    ).resolves.toMatchObject({ revision: 1, editorState: { doc: 'AB' } });
  });

  it('atomically promotes the newest local descendant into the durable conflict branch', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const saved = await store.saveEntry('demo', 'task-123', 'scope-promote', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-promote', {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('AC', ['C']),
      })
    ).rejects.toThrow();
    const [candidate] = await store.loadConflictCandidates('demo', 'task-123', 'scope-promote');

    const promoted = await store.replaceConflictCandidate(
      'demo',
      'task-123',
      'scope-promote',
      candidate!.entry!,
      {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        revision: 3,
        diskBaseline: 'A',
        editorState: editorState('ACD', ['C', 'D']),
      },
      1,
      saved.generation
    );

    const restarted = new ReviewDraftHistoryStore();
    await expect(
      restarted.loadConflictCandidates('demo', 'task-123', 'scope-promote')
    ).resolves.toMatchObject([
      {
        id: promoted.id,
        observedCurrentRevision: 1,
        entry: { revision: 3, editorState: { doc: 'ACD' } },
      },
    ]);
  });

  it('retains a manual-edit recovery branch when the canonical generation changes again', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const saved = await store.saveEntry('demo', 'task-123', 'scope-stale-resolve', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('AB', ['B']),
    });
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-stale-resolve', {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('AC', ['C']),
      })
    ).rejects.toThrow();
    const [candidate] = await store.loadConflictCandidates(
      'demo',
      'task-123',
      'scope-stale-resolve'
    );
    await store.saveEntry('demo', 'task-123', 'scope-stale-resolve', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 1,
      expectedGeneration: saved.generation,
      revision: 2,
      diskBaseline: 'A',
      editorState: editorState('ABD', ['B', 'D']),
    });

    await expect(
      store.resolveConflictCandidate(
        'demo',
        'task-123',
        'scope-stale-resolve',
        candidate!.id,
        'recover-candidate',
        1,
        saved.generation
      )
    ).rejects.toThrow('Saved manual edit history changed again');
    await expect(
      store.loadConflictCandidates('demo', 'task-123', 'scope-stale-resolve')
    ).resolves.toMatchObject([{ id: candidate!.id, observedCurrentRevision: 2 }]);
  });

  it('never prunes an unresolved manual-edit branch when the recovery quota is full', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const canonical = await store.saveEntry('demo', 'task-123', 'scope-conflict-quota', {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('canonical', []),
    });
    for (let index = 0; index < 32; index++) {
      await expect(
        store.saveEntry('demo', 'task-123', 'scope-conflict-quota', {
          filePath: '/repo/a.ts',
          codec: 'codemirror-history-v1',
          expectedRevision: 0,
          expectedGeneration: null,
          revision: 1,
          diskBaseline: 'A',
          editorState: editorState('branch-' + index, []),
        })
      ).rejects.toThrow('Review draft history changed');
    }
    const before = await store.loadConflictCandidates('demo', 'task-123', 'scope-conflict-quota');
    expect(before).toHaveLength(32);
    await expect(
      store.saveEntry('demo', 'task-123', 'scope-conflict-quota', {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('branch-overflow', []),
      })
    ).rejects.toThrow('Too many unresolved manual-edit recovery copies');
    await expect(
      store.loadConflictCandidates('demo', 'task-123', 'scope-conflict-quota')
    ).resolves.toEqual(before);

    const selected = before[0]!;
    await expect(
      store.resolveConflictCandidate(
        'demo',
        'task-123',
        'scope-conflict-quota',
        selected.id,
        'recover-candidate',
        1,
        canonical.generation
      )
    ).resolves.toMatchObject({
      revision: 2,
      editorState: selected.entry!.editorState,
    });
    const afterSwap = await store.loadConflictCandidates(
      'demo',
      'task-123',
      'scope-conflict-quota'
    );
    expect(afterSwap).toHaveLength(32);
    expect(afterSwap.some((candidate) => candidate.id === selected.id)).toBe(false);
    expect(afterSwap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ editorState: editorState('canonical', []) }),
        }),
      ])
    );
  });

  it('refuses a symlinked manual-edit recovery directory without touching external files', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const scopeToken = 'scope-symlink-conflict';
    await store.saveEntry('demo', 'task-123', scopeToken, {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('canonical', []),
    });
    const external = path.join(teamsBasePath, 'external-draft-candidate-target');
    const sentinelName = 'b'.repeat(64) + '.json';
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, sentinelName), 'sentinel', 'utf8');
    const conflictParent = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'draft-history',
      'conflicts',
      'v1',
      'task-123'
    );
    await mkdir(conflictParent, { recursive: true });
    await symlink(
      external,
      path.join(conflictParent, createHash('sha256').update(scopeToken).digest('hex')),
      'dir'
    );

    await expect(
      store.saveEntry('demo', 'task-123', scopeToken, {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('local', []),
      })
    ).rejects.toThrow('Unsafe persistence directory');
    await expect(readFile(path.join(external, sentinelName), 'utf8')).resolves.toBe('sentinel');
  });

  it('fails closed for a symlinked canonical manual-edit scope', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const external = await mkdtemp(path.join(tmpdir(), 'external-review-drafts-'));
    const sentinelPath = path.join(external, 'sentinel.json');
    try {
      await writeFile(sentinelPath, 'sentinel', 'utf8');
      const scopeParent = path.join(
        teamsBasePath,
        'demo',
        'review-decisions',
        'draft-history',
        'v1'
      );
      await mkdir(scopeParent, { recursive: true });
      await symlink(external, path.join(scopeParent, 'task-123'), 'dir');

      await expect(
        store.saveEntry('demo', 'task-123', 'canonical-draft-symlink', {
          filePath: '/repo/a.ts',
          codec: 'codemirror-history-v1',
          expectedRevision: 0,
          expectedGeneration: null,
          revision: 1,
          diskBaseline: 'A',
          editorState: editorState('local', []),
        })
      ).rejects.toThrow('Unsafe persistence directory');
      await expect(store.clearScope('demo', 'task-123', 'canonical-draft-symlink')).rejects.toThrow(
        'Unsafe persistence directory'
      );
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('sentinel');
      await expect(readdir(external)).resolves.toEqual(['sentinel.json']);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it('quarantines an unreadable draft candidate without hiding valid recovery branches', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const scopeToken = 'scope-corrupt-conflict';
    await store.saveEntry('demo', 'task-123', scopeToken, {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'A',
      editorState: editorState('canonical', []),
    });
    await expect(
      store.saveEntry('demo', 'task-123', scopeToken, {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'A',
        editorState: editorState('local', []),
      })
    ).rejects.toThrow();
    const conflictDir = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'draft-history',
      'conflicts',
      'v1',
      'task-123',
      createHash('sha256').update(scopeToken).digest('hex')
    );
    await writeFile(path.join(conflictDir, 'd'.repeat(64) + '.json'), '{broken', 'utf8');

    await expect(store.loadConflictCandidates('demo', 'task-123', scopeToken)).rejects.toThrow(
      'was quarantined'
    );
    await expect(
      store.loadConflictCandidates('demo', 'task-123', scopeToken)
    ).resolves.toMatchObject([{ entry: { editorState: { doc: 'local' } } }]);
    await expect(readdir(path.join(conflictDir, 'quarantine'))).resolves.toHaveLength(1);
  });

  it('keeps a valid manual-edit branch after a transient directory read failure', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
    const store = new ReviewDraftHistoryStore();
    const scopeToken = 'scope-transient-conflict';
    const saved = await store.saveEntry('demo', 'task-123', scopeToken, {
      filePath: '/repo/a.ts',
      codec: 'codemirror-history-v1',
      expectedRevision: 0,
      expectedGeneration: null,
      revision: 1,
      diskBaseline: 'base',
      editorState: editorState('current', ['current']),
    });
    await expect(
      store.saveEntry('demo', 'task-123', scopeToken, {
        filePath: '/repo/a.ts',
        codec: 'codemirror-history-v1',
        expectedRevision: 0,
        expectedGeneration: null,
        revision: 1,
        diskBaseline: 'base',
        editorState: editorState('recovery', ['recovery']),
      })
    ).rejects.toThrow('refusing stale state overwrite');
    expect(saved.revision).toBe(1);

    const failure = Object.assign(new Error('temporary recovery read failure'), { code: 'EIO' });
    const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(failure);
    try {
      await expect(store.loadConflictCandidates('demo', 'task-123', scopeToken)).rejects.toThrow(
        'temporary recovery read failure'
      );
    } finally {
      readdirSpy.mockRestore();
    }

    await expect(
      store.loadConflictCandidates('demo', 'task-123', scopeToken)
    ).resolves.toHaveLength(1);
  });

  it('rejects an ABA clear after the same file is cleared and recreated at revision one', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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

    await expect(store.clearUnreadableScope('demo', 'task-123', 'scope-a')).rejects.toThrow(
      'Saved manual edit history became readable; refusing destructive recovery discard'
    );
    await expect(store.load('demo', 'task-123', 'scope-a')).resolves.toMatchObject({
      entries: {
        '/repo/a.ts': { generation: replacement.generation, editorState: { doc: 'newer' } },
      },
    });
  });

  it('rejects path-like identities and malformed editor states before writing', async () => {
    const { ReviewDraftHistoryStore } = await import('@features/change-review-history/main');
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
