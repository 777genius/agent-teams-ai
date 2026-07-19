import { createHash } from 'crypto';
import * as fs from 'fs';
import {
  access,
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

let teamsBasePath: string;

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => teamsBasePath,
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('ReviewDecisionStore', () => {
  beforeEach(async () => {
    teamsBasePath = await mkdtemp(path.join(tmpdir(), 'review-decision-store-'));
  });

  afterEach(async () => {
    await rm(teamsBasePath, { recursive: true, force: true });
  });

  it('stores exact-scope decision variants without last-write-wins overwrite', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();

    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:a:src:one',
      hunkDecisions: { 'file-a:0': 'rejected' },
      fileDecisions: { 'file-a': 'rejected' },
    });
    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:b:src:two',
      hunkDecisions: { 'file-b:0': 'accepted' },
      fileDecisions: { 'file-b': 'accepted' },
    });

    await expect(store.load('demo', 'task-123', 'task:123:req:a:src:one')).resolves.toEqual({
      hunkDecisions: { 'file-a:0': 'rejected' },
      fileDecisions: { 'file-a': 'rejected' },
      hunkContextHashesByFile: undefined,
      reviewActionHistory: [],
      reviewRedoHistory: [],
      revision: 1,
    });
    await expect(store.load('demo', 'task-123', 'task:123:req:b:src:two')).resolves.toEqual({
      hunkDecisions: { 'file-b:0': 'accepted' },
      fileDecisions: { 'file-b': 'accepted' },
      hunkContextHashesByFile: undefined,
      reviewActionHistory: [],
      reviewRedoHistory: [],
      revision: 1,
    });
  });

  it('rejects when durable decision persistence fails instead of reporting success', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    await writeFile(path.join(teamsBasePath, 'blocked-team'), 'not-a-directory', 'utf8');

    await expect(
      store.save('blocked-team', 'task-123', {
        scopeToken: 'task:123:req:a:src:one',
        hunkDecisions: { 'file-a:0': 'rejected' },
        fileDecisions: { 'file-a': 'rejected' },
      })
    ).rejects.toBeTruthy();
  });

  it('rejects path-like scope identities before touching the filesystem', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();

    await expect(
      store.save('../outside', 'task-123', {
        scopeToken: 'token',
        hunkDecisions: {},
        fileDecisions: {},
      })
    ).rejects.toThrow('Invalid review decision team name');
    await expect(store.clear('demo', '..')).rejects.toThrow('Invalid review decision scope key');
  });

  it('surfaces a corrupt persisted payload instead of treating it as empty decisions', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const legacyDir = path.join(teamsBasePath, 'demo', 'review-decisions');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, 'task-123.json'), '{not-json', 'utf8');

    await expect(store.load('demo', 'task-123')).rejects.toBeTruthy();
    await expect(readFile(path.join(legacyDir, 'task-123.json'), 'utf8')).resolves.toBe(
      '{not-json'
    );
  });

  it('can explicitly discard a corrupt legacy snapshot for recovery', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const legacyPath = path.join(teamsBasePath, 'demo', 'review-decisions', 'task-123.json');
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, '{not-json', 'utf8');

    await expect(store.clear('demo', 'task-123', 'scope-token')).resolves.toBeUndefined();
    await expect(readFile(legacyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('discards only unreadable exact decisions and preserves a readable replacement', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:recovery-race:src:one';
    const exactPath = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'v2',
      'task-123',
      `${createHash('sha256').update(scopeToken).digest('hex')}.json`
    );
    await mkdir(path.dirname(exactPath), { recursive: true });
    await writeFile(exactPath, '{not-json', 'utf8');
    await expect(
      store.clearUnreadableExactScope('demo', 'task-123', scopeToken)
    ).resolves.toBeUndefined();
    await expect(readFile(exactPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(exactPath, '{not-json-again', 'utf8');
    await expect(store.load('demo', 'task-123', scopeToken)).rejects.toBeTruthy();
    await store.clear('demo', 'task-123', scopeToken);
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { 'new-file:0': 'accepted' },
      fileDecisions: {},
    });

    await expect(
      store.clearUnreadableExactScope('demo', 'task-123', scopeToken)
    ).rejects.toThrow(
      'Saved review decisions became readable; refusing destructive recovery discard'
    );
    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      hunkDecisions: { 'new-file:0': 'accepted' },
      revision: 1,
    });
  });

  it('rejects malformed decision values before persisting them', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();

    await expect(
      store.save('demo', 'task-123', {
        scopeToken: 'token',
        hunkDecisions: { '/repo/file.ts:0': 'surprise' as never },
        fileDecisions: {},
      })
    ).rejects.toThrow('Invalid review decisions payload');
  });

  it('clears only the exact v2 scope file and leaves sibling variants intact', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();

    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:a:src:one',
      hunkDecisions: { 'file-a:0': 'rejected' },
      fileDecisions: { 'file-a': 'rejected' },
    });
    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:b:src:two',
      hunkDecisions: { 'file-b:0': 'accepted' },
      fileDecisions: { 'file-b': 'accepted' },
    });

    await store.clear('demo', 'task-123', 'task:123:req:a:src:one');

    await expect(store.load('demo', 'task-123', 'task:123:req:a:src:one')).resolves.toBeNull();
    await expect(store.load('demo', 'task-123', 'task:123:req:b:src:two')).resolves.toEqual({
      hunkDecisions: { 'file-b:0': 'accepted' },
      fileDecisions: { 'file-b': 'accepted' },
      hunkContextHashesByFile: undefined,
      reviewActionHistory: [],
      reviewRedoHistory: [],
      revision: 1,
    });
  });

  it('still dual-reads legacy coarse files for matching scope tokens', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const legacyDir = path.join(teamsBasePath, 'demo', 'review-decisions');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, 'task-123.json'),
      JSON.stringify({
        scopeToken: 'task:123:req:legacy:src:one',
        hunkDecisions: { 'file-a:0': 'rejected' },
        fileDecisions: { 'file-a': 'rejected' },
        updatedAt: '2026-04-21T10:00:00.000Z',
      }),
      'utf8'
    );

    await expect(store.load('demo', 'task-123', 'task:123:req:legacy:src:one')).resolves.toEqual({
      hunkDecisions: { 'file-a:0': 'rejected' },
      fileDecisions: { 'file-a': 'rejected' },
      hunkContextHashesByFile: undefined,
      reviewActionHistory: [],
      reviewRedoHistory: [],
      revision: 0,
    });
  });

  it('writes revisioned content-addressed v6 payloads under the scoped directory', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();

    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:a:src:one',
      hunkDecisions: {},
      fileDecisions: {},
    });

    const scopeDir = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'v2',
      encodeURIComponent('task-123')
    );
    const entries = await fsEntries(scopeDir);
    expect(entries).toHaveLength(1);

    const payload: unknown = JSON.parse(await readFile(path.join(scopeDir, entries[0]!), 'utf8'));
    expect(payload).toMatchObject({
      version: 6,
      scopeKey: 'task-123',
      scopeToken: 'task:123:req:a:src:one',
      revision: 1,
      textBlobs: {},
      fileSummaryBlobs: {},
    });
  });

  it('never prunes the just-written scope when retained files have equal mtimes', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeKey = 'task-prune-current';
    const scopeToken = 'task:prune:req:current';
    await store.save('demo', scopeKey, {
      scopeToken,
      hunkDecisions: { 'current:0': 'accepted' },
      fileDecisions: {},
    });
    const currentPath = exactScopeFilePath('demo', scopeKey, scopeToken);
    const scopeDir = path.dirname(currentPath);
    const oldPaths = Array.from({ length: 16 }, (_, index) =>
      path.join(scopeDir, `${createHash('sha256').update(`old-${index}`).digest('hex')}.json`)
    );
    await Promise.all(oldPaths.map((filePath) => writeFile(filePath, '{}', 'utf8')));
    const sameMtime = new Date('2026-01-01T00:00:00.000Z');
    await Promise.all([...oldPaths, currentPath].map((filePath) => utimes(filePath, sameMtime, sameMtime)));

    await (
      store as unknown as {
        pruneScopeDir(teamName: string, key: string, protectedPath: string): Promise<void>;
      }
    ).pruneScopeDir('demo', scopeKey, currentPath);

    await expect(access(currentPath)).resolves.toBeUndefined();
    await expect(readdir(scopeDir)).resolves.toHaveLength(16);
  });

  it('protects a scope snapshot while its mutation journal is pending', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeKey = 'task-prune-pending';
    const currentToken = 'task:prune:req:current-pending';
    const pendingToken = 'task:prune:req:wal-pending';
    await store.save('demo', scopeKey, {
      scopeToken: currentToken,
      hunkDecisions: { 'current:0': 'accepted' },
      fileDecisions: {},
    });
    const currentPath = exactScopeFilePath('demo', scopeKey, currentToken);
    const pendingPath = exactScopeFilePath('demo', scopeKey, pendingToken);
    const scopeDir = path.dirname(currentPath);
    const otherPaths = Array.from({ length: 15 }, (_, index) =>
      path.join(scopeDir, `${createHash('sha256').update(`other-${index}`).digest('hex')}.json`)
    );
    await Promise.all(
      [pendingPath, ...otherPaths].map((filePath) => writeFile(filePath, '{}', 'utf8'))
    );
    const pendingHash = createHash('sha256').update(pendingToken).digest('hex');
    await mkdir(
      path.join(
        teamsBasePath,
        'demo',
        'review-decisions',
        'mutation-journal',
        scopeKey,
        pendingHash
      ),
      { recursive: true }
    );
    const sameMtime = new Date('2026-01-01T00:00:00.000Z');
    await Promise.all(
      [currentPath, pendingPath, ...otherPaths].map((filePath) =>
        utimes(filePath, sameMtime, sameMtime)
      )
    );

    await (
      store as unknown as {
        pruneScopeDir(teamName: string, key: string, protectedPath: string): Promise<void>;
      }
    ).pruneScopeDir('demo', scopeKey, currentPath);

    await expect(access(currentPath)).resolves.toBeUndefined();
    await expect(access(pendingPath)).resolves.toBeUndefined();
    await expect(readdir(scopeDir)).resolves.toHaveLength(16);
  });

  it('rejects stale CAS writes and makes a committed mutation retry idempotent', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:cas:src:one';
    const target = {
      scopeToken,
      hunkDecisions: { 'file:0': 'rejected' as const },
      fileDecisions: {},
      expectedRevision: 0,
      mutationId: 'mutation-1',
    };

    await expect(store.save('demo', 'task-123', target)).resolves.toBe(1);
    await expect(store.save('demo', 'task-123', target)).resolves.toBe(1);
    await expect(
      store.save('demo', 'task-123', {
        ...target,
        mutationId: 'mutation-2',
      })
    ).rejects.toThrow('Review decisions changed; refusing stale state overwrite');
    await expect(
      store.save('demo', 'task-123', {
        ...target,
        hunkDecisions: { 'file:0': 'accepted' },
      })
    ).rejects.toThrow('Review decisions changed; refusing stale state overwrite');
  });

  it('durably preserves and explicitly resolves a divergent decision branch', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const scopeToken = 'task:123:req:durable-conflict:src:one';
    const first = new ReviewDecisionStore();
    await first.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { 'file:0': 'accepted' },
      fileDecisions: {},
      expectedRevision: 0,
    });
    await expect(
      first.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { 'file:0': 'rejected' },
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).rejects.toThrow('Review decisions changed; refusing stale state overwrite');

    const restarted = new ReviewDecisionStore();
    const [candidate] = await restarted.loadConflictCandidates(
      'demo',
      'task-123',
      scopeToken
    );
    expect(candidate).toMatchObject({
      expectedRevision: 0,
      observedCurrentRevision: 1,
      state: { hunkDecisions: { 'file:0': 'rejected' } },
    });
    if (process.platform !== 'win32') {
      const candidateStats = await stat(
        path.join(
          teamsBasePath,
          'demo',
          'review-decisions',
          'conflicts',
          'v1',
          'task-123',
          createHash('sha256').update(scopeToken).digest('hex'),
          candidate!.id + '.json'
        )
      );
      expect(candidateStats.mode & 0o777).toBe(0o600);
    }

    await expect(
      restarted.resolveConflictCandidate(
        'demo',
        'task-123',
        scopeToken,
        candidate!.id,
        'recover-candidate',
        1
      )
    ).resolves.toBe(2);
    await expect(restarted.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      revision: 2,
      hunkDecisions: { 'file:0': 'rejected' },
    });
    const [canonicalBackup] = await restarted.loadConflictCandidates(
      'demo',
      'task-123',
      scopeToken
    );
    expect(canonicalBackup).toMatchObject({
      observedCurrentRevision: 2,
      state: { hunkDecisions: { 'file:0': 'accepted' } },
    });
    await expect(
      restarted.resolveConflictCandidate(
        'demo',
        'task-123',
        scopeToken,
        canonicalBackup!.id,
        'recover-candidate',
        2
      )
    ).resolves.toBe(3);
    await expect(restarted.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      revision: 3,
      hunkDecisions: { 'file:0': 'accepted' },
    });
  });

  it('keeps authoritative decisions when a conflict candidate is dismissed', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:dismiss-conflict:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { 'file:0': 'accepted' },
      fileDecisions: {},
      expectedRevision: 0,
    });
    await expect(
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { 'file:0': 'rejected' },
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).rejects.toThrow();
    const [candidate] = await store.loadConflictCandidates('demo', 'task-123', scopeToken);

    await expect(
      store.resolveConflictCandidate(
        'demo',
        'task-123',
        scopeToken,
        candidate!.id,
        'keep-current',
        1
      )
    ).resolves.toBe(1);
    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      revision: 1,
      hunkDecisions: { 'file:0': 'accepted' },
    });
  });

  it('retains a recovery branch when its observed canonical revision becomes stale', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:stale-resolution:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { 'file:0': 'accepted' },
      fileDecisions: {},
      expectedRevision: 0,
    });
    await expect(
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { 'file:0': 'rejected' },
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).rejects.toThrow();
    const [candidate] = await store.loadConflictCandidates('demo', 'task-123', scopeToken);
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { 'file:0': 'accepted' },
      fileDecisions: { file: 'accepted' },
      expectedRevision: 1,
    });

    await expect(
      store.resolveConflictCandidate(
        'demo',
        'task-123',
        scopeToken,
        candidate!.id,
        'recover-candidate',
        1
      )
    ).rejects.toThrow('Saved review state changed again');
    await expect(
      store.loadConflictCandidates('demo', 'task-123', scopeToken)
    ).resolves.toMatchObject([{ id: candidate!.id, observedCurrentRevision: 2 }]);
  });

  it('never prunes an unresolved decision branch when the recovery quota is full', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:conflict-quota:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { canonical: 'accepted' },
      fileDecisions: {},
      expectedRevision: 0,
    });
    for (let index = 0; index < 8; index++) {
      await expect(
        store.save('demo', 'task-123', {
          scopeToken,
          hunkDecisions: { ['branch-' + index]: 'rejected' },
          fileDecisions: {},
          expectedRevision: 0,
        })
      ).rejects.toThrow('Review decisions changed');
    }
    const before = await store.loadConflictCandidates('demo', 'task-123', scopeToken);
    expect(before).toHaveLength(8);
    await expect(
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { 'branch-overflow': 'rejected' },
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).rejects.toThrow('Too many unresolved review recovery copies');
    await expect(
      store.loadConflictCandidates('demo', 'task-123', scopeToken)
    ).resolves.toEqual(before);
  });

  it('refuses a symlinked recovery directory without touching external files', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:symlink-conflict:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { canonical: 'accepted' },
      fileDecisions: {},
      expectedRevision: 0,
    });
    const external = path.join(teamsBasePath, 'external-candidate-target');
    const sentinelName = 'a'.repeat(64) + '.json';
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, sentinelName), 'sentinel', 'utf8');
    const conflictParent = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
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
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { local: 'rejected' },
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).rejects.toThrow('Unsafe persistence directory');
    await expect(readFile(path.join(external, sentinelName), 'utf8')).resolves.toBe('sentinel');
    await expect(readdir(external)).resolves.toEqual([sentinelName]);
  });

  it('quarantines an unreadable decision candidate without hiding valid recovery branches', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:corrupt-conflict:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { canonical: 'accepted' },
      fileDecisions: {},
      expectedRevision: 0,
    });
    await expect(
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { local: 'rejected' },
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).rejects.toThrow();
    const conflictDir = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'conflicts',
      'v1',
      'task-123',
      createHash('sha256').update(scopeToken).digest('hex')
    );
    await writeFile(path.join(conflictDir, 'c'.repeat(64) + '.json'), '{broken', 'utf8');

    await expect(
      store.loadConflictCandidates('demo', 'task-123', scopeToken)
    ).rejects.toThrow('was quarantined');
    await expect(
      store.loadConflictCandidates('demo', 'task-123', scopeToken)
    ).resolves.toMatchObject([{ state: { hunkDecisions: { local: 'rejected' } } }]);
    await expect(readdir(path.join(conflictDir, 'quarantine'))).resolves.toHaveLength(1);
  });

  it('keeps a valid recovery branch visible after a transient directory read failure', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:transient-conflict:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: { 'file-a:0': 'accepted' },
      fileDecisions: {},
      expectedRevision: 0,
    });
    await expect(
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { 'file-a:0': 'rejected' },
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).rejects.toThrow('refusing stale state overwrite');

    const failure = Object.assign(new Error('temporary recovery read failure'), { code: 'EIO' });
    const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(failure);
    try {
      await expect(
        store.loadConflictCandidates('demo', 'task-123', scopeToken)
      ).rejects.toThrow('temporary recovery read failure');
    } finally {
      readdirSpy.mockRestore();
    }

    await expect(
      store.loadConflictCandidates('demo', 'task-123', scopeToken)
    ).resolves.toHaveLength(1);
  });

  it('makes an exact forward generic retry idempotent after response loss', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:generic-response-loss:src:one';
    const action = {
      id: 'accept-hunk-response-loss',
      createdAt: '2026-07-18T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: 0 },
    };
    const redoEntry = {
      action: { ...action, id: 'redo-hunk-response-loss' },
      decisionSnapshot: {
        hunkDecisions: { 'file:1': 'rejected' as const },
        fileDecisions: {},
      },
    };
    const target = {
      scopeToken,
      hunkDecisions: { 'file:0': 'accepted' as const, 'file:1': 'rejected' as const },
      fileDecisions: { file: 'accepted' as const },
      hunkContextHashesByFile: { file: { 0: 'hash-0', 1: 'hash-1' } },
      reviewActionHistory: [action],
      reviewRedoHistory: [redoEntry],
      expectedRevision: 0,
    };

    await expect(store.save('demo', 'task-123', target)).resolves.toBe(1);
    await expect(
      store.save('demo', 'task-123', {
        ...target,
        hunkDecisions: { 'file:1': 'rejected', 'file:0': 'accepted' },
        hunkContextHashesByFile: { file: { 1: 'hash-1', 0: 'hash-0' } },
      })
    ).resolves.toBe(1);
    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      revision: 1,
      reviewActionHistory: [action],
      reviewRedoHistory: [redoEntry],
    });

    await expect(
      store.save('demo', 'task-123', {
        ...target,
        hunkContextHashesByFile: { file: { 0: 'different', 1: 'hash-1' } },
      })
    ).rejects.toThrow('Review decisions changed; refusing stale state overwrite');
    await expect(
      store.save('demo', 'task-123', { ...target, reviewRedoHistory: [] })
    ).rejects.toThrow('Review decisions changed; refusing stale state overwrite');
    await expect(
      store.save('demo', 'task-123', { ...target, expectedRevision: 2 })
    ).rejects.toThrow('Review decisions changed; refusing stale state overwrite');

    await expect(store.save('demo', 'task-123', { ...target, expectedRevision: 1 })).resolves.toBe(
      2
    );
    await expect(store.save('demo', 'task-123', target)).resolves.toBe(2);
  });

  it('migrates a legacy revision zero snapshot through the first CAS write', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:v3:src:one';
    const scopeDir = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'v2',
      encodeURIComponent('task-123')
    );
    await mkdir(scopeDir, { recursive: true });
    const { createHash } = await import('crypto');
    const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
    await writeFile(
      path.join(scopeDir, `${scopeHash}.json`),
      JSON.stringify({
        version: 3,
        scopeKey: 'task-123',
        scopeToken,
        hunkDecisions: { 'file:0': 'accepted' },
        fileDecisions: {},
        reviewActionHistory: [],
        updatedAt: '2026-07-17T00:00:00.000Z',
      }),
      'utf8'
    );

    await expect(
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: {},
        fileDecisions: {},
        expectedRevision: 0,
      })
    ).resolves.toBe(1);
    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      hunkDecisions: {},
      revision: 1,
    });
  });

  it('merges one journaled file decision without clobbering sibling review state', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:a:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: {
        'stable-file:0': 'accepted',
        '/repo/renamed.ts:0': 'accepted',
        'change-key:0': 'accepted',
      },
      fileDecisions: {
        'stable-file': 'accepted',
        '/repo/renamed.ts': 'accepted',
        'change-key': 'accepted',
      },
      hunkContextHashesByFile: {
        'stable-file': { 0: 'stable-hash' },
        '/repo/renamed.ts': { 0: 'legacy-hash' },
      },
      reviewActionHistory: [
        {
          id: 'existing-action',
          createdAt: '2026-07-17T12:00:00.000Z',
          kind: 'hunk',
          action: { filePath: '/repo/stable.ts', originalIndex: 0 },
        },
      ],
    });

    await store.mergeFileDecisionPatch('demo', 'task-123', scopeToken, {
      filePath: '/repo/renamed.ts',
      reviewKey: 'change-key',
      fileDecision: 'pending',
      hunkDecisions: { 0: 'rejected', 1: 'pending' },
      hunkContextHashes: { 0: 'new-hash', 1: 'pending-hash' },
    });

    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toEqual({
      hunkDecisions: {
        'stable-file:0': 'accepted',
        'change-key:0': 'rejected',
      },
      fileDecisions: { 'stable-file': 'accepted' },
      hunkContextHashesByFile: {
        'stable-file': { 0: 'stable-hash' },
        'change-key': { 0: 'new-hash', 1: 'pending-hash' },
      },
      reviewActionHistory: [
        {
          id: 'existing-action',
          createdAt: '2026-07-17T12:00:00.000Z',
          kind: 'hunk',
          action: { filePath: '/repo/stable.ts', originalIndex: 0 },
        },
      ],
      reviewRedoHistory: [],
      revision: 2,
    });
  });

  it('persists more than ten ordered review actions and restores them exactly', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const reviewActionHistory = Array.from({ length: 100 }, (_, index) => ({
      id: `action-${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: index },
    }));

    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:many:src:one',
      hunkDecisions: Object.fromEntries(
        reviewActionHistory.map((_, index) => [`file:${index}`, 'accepted' as const])
      ),
      fileDecisions: {},
      reviewActionHistory,
    });

    const restored = await store.load('demo', 'task-123', 'task:123:req:many:src:one');
    expect(restored?.reviewActionHistory).toEqual(reviewActionHistory);
    expect(restored?.reviewActionHistory).toHaveLength(100);
  });

  it('round-trips exact action descriptors and rejects misleading history labels', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const describedAction = {
      id: 'described-action',
      createdAt: '2026-07-18T12:00:00.000Z',
      kind: 'hunk' as const,
      descriptor: {
        intent: 'reject-hunk' as const,
        filePath: '/repo/file.ts',
        hunkIndex: 3,
      },
      action: { filePath: '/repo/file.ts', originalIndex: 3 },
    };

    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:described:src:one',
      hunkDecisions: { 'file:3': 'rejected' },
      fileDecisions: {},
      reviewActionHistory: [describedAction],
    });
    await expect(
      store.load('demo', 'task-123', 'task:123:req:described:src:one')
    ).resolves.toMatchObject({ reviewActionHistory: [describedAction] });

    await expect(
      store.save('demo', 'task-123', {
        scopeToken: 'task:123:req:misleading:src:one',
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [
          {
            ...describedAction,
            descriptor: { ...describedAction.descriptor, filePath: '/repo/other.ts' },
          },
        ],
      })
    ).rejects.toThrow('Invalid review decisions payload');
  });

  it('deduplicates history contents and garbage-collects unreachable v6 blobs', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:dedup:src:one';
    const file = {
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const makeAction = (id: string, beforeContent: string, afterContent: string) => ({
      id,
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: file.filePath,
          beforeContent,
          afterContent,
          file,
        },
        file,
      },
    });
    const retained = makeAction('retained-action', 'before-a\n', 'after-a\n');
    const duplicateContent = makeAction('duplicate-content-action', 'before-a\n', 'after-a\n');
    const collected = makeAction('collected-action', 'before-b\n', 'after-b\n');

    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [retained, duplicateContent, collected],
    });
    const filePath = exactScopeFilePath('demo', 'task-123', scopeToken);
    const first = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      textBlobs: Record<string, string>;
      fileSummaryBlobs: Record<string, unknown>;
      reviewActionHistory: {
        action: { snapshot: { beforeBlob: string; beforeContent?: string }; fileRef: string };
      }[];
    };
    expect(first.version).toBe(6);
    expect(Object.values(first.textBlobs)).toHaveLength(4);
    expect(Object.values(first.fileSummaryBlobs)).toHaveLength(1);
    expect(first.reviewActionHistory[0]?.action.snapshot.beforeContent).toBeUndefined();
    expect(first.reviewActionHistory[0]?.action.fileRef).toBe(
      first.reviewActionHistory[1]?.action.fileRef
    );
    expect(first.reviewActionHistory[0]?.action.snapshot.beforeBlob).toBe(
      first.reviewActionHistory[1]?.action.snapshot.beforeBlob
    );

    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [retained],
      expectedRevision: 1,
    });
    const compacted = JSON.parse(await readFile(filePath, 'utf8')) as {
      textBlobs: Record<string, string>;
      fileSummaryBlobs: Record<string, unknown>;
    };
    expect(Object.values(compacted.textBlobs).sort()).toEqual(['after-a\n', 'before-a\n']);
    expect(Object.values(compacted.fileSummaryBlobs)).toHaveLength(1);
    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      reviewActionHistory: [retained],
      revision: 2,
    });
  });

  it('fails closed when a v6 content-addressed history blob is corrupted', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:corrupt-blob:src:one';
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [
        {
          id: 'disk-action',
          createdAt: '2026-07-17T12:00:00.000Z',
          kind: 'disk',
          action: {
            snapshot: {
              filePath: '/repo/file.ts',
              beforeContent: 'before\n',
              afterContent: 'after\n',
            },
          },
        },
      ],
    });
    const filePath = exactScopeFilePath('demo', 'task-123', scopeToken);
    const payload = JSON.parse(await readFile(filePath, 'utf8')) as {
      textBlobs: Record<string, string>;
    };
    const [firstRef] = Object.keys(payload.textBlobs);
    payload.textBlobs[firstRef!] = 'tampered\n';
    await writeFile(filePath, JSON.stringify(payload), 'utf8');

    await expect(store.load('demo', 'task-123', scopeToken)).rejects.toThrow(
      'Invalid review decisions payload'
    );
  });

  it('round-trips the durable Redo branch in a v6 snapshot', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const action = {
      id: 'redo-hunk',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: 0 },
    };
    const reviewRedoHistory = [
      {
        action,
        decisionSnapshot: {
          hunkDecisions: { 'file:0': 'accepted' as const },
          fileDecisions: {},
        },
        hunkContextHashesByFile: { file: { 0: 'hash' } },
      },
    ];

    await store.save('demo', 'task-123', {
      scopeToken: 'task:123:req:redo:src:one',
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory,
    });

    await expect(
      store.load('demo', 'task-123', 'task:123:req:redo:src:one')
    ).resolves.toMatchObject({
      reviewActionHistory: [],
      reviewRedoHistory,
      revision: 1,
    });
  });

  it('migrates a v4 snapshot with an empty Redo branch on the next CAS write', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:v4:src:one';
    const scopeDir = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'v2',
      encodeURIComponent('task-123')
    );
    await mkdir(scopeDir, { recursive: true });
    const { createHash } = await import('crypto');
    const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
    await writeFile(
      path.join(scopeDir, `${scopeHash}.json`),
      JSON.stringify({
        version: 4,
        scopeKey: 'task-123',
        scopeToken,
        hunkDecisions: { 'file:0': 'accepted' },
        fileDecisions: {},
        reviewActionHistory: [],
        revision: 7,
        updatedAt: '2026-07-17T00:00:00.000Z',
      }),
      'utf8'
    );

    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      reviewRedoHistory: [],
      revision: 7,
    });
    await expect(
      store.save('demo', 'task-123', {
        scopeToken,
        hunkDecisions: { 'file:0': 'accepted' },
        fileDecisions: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
        expectedRevision: 7,
      })
    ).resolves.toBe(8);
  });

  it('loads an existing v5 full-text history and compacts it on the next CAS write', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:v5:src:one';
    const filePath = exactScopeFilePath('demo', 'task-123', scopeToken);
    const action = {
      id: 'legacy-disk-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: '/repo/file.ts',
          beforeContent: 'before\n',
          afterContent: 'after\n',
        },
      },
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 5,
        scopeKey: 'task-123',
        scopeToken,
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
        revision: 4,
        updatedAt: '2026-07-17T00:00:00.000Z',
      }),
      'utf8'
    );

    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toMatchObject({
      reviewActionHistory: [action],
      revision: 4,
    });
    await store.save('demo', 'task-123', {
      scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [action],
      reviewRedoHistory: [],
      expectedRevision: 4,
    });
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"version": 6');
  });

  it('loads an existing v2 exact-scope payload with an empty action history', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const scopeToken = 'task:123:req:v2:src:one';
    const scopeDir = path.join(
      teamsBasePath,
      'demo',
      'review-decisions',
      'v2',
      encodeURIComponent('task-123')
    );
    await mkdir(scopeDir, { recursive: true });
    const { createHash } = await import('crypto');
    const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
    await writeFile(
      path.join(scopeDir, `${scopeHash}.json`),
      JSON.stringify({
        version: 2,
        scopeKey: 'task-123',
        scopeToken,
        hunkDecisions: { 'file:0': 'rejected' },
        fileDecisions: {},
        updatedAt: '2026-07-17T00:00:00.000Z',
      }),
      'utf8'
    );

    await expect(store.load('demo', 'task-123', scopeToken)).resolves.toEqual({
      hunkDecisions: { 'file:0': 'rejected' },
      fileDecisions: {},
      hunkContextHashesByFile: undefined,
      reviewActionHistory: [],
      reviewRedoHistory: [],
      revision: 0,
    });
  });

  it('rejects malformed or duplicate review action identities before writing', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const store = new ReviewDecisionStore();
    const duplicate = {
      id: 'duplicate',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: 0 },
    };

    await expect(
      store.save('demo', 'task-123', {
        scopeToken: 'task:123:req:invalid:src:one',
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [duplicate, duplicate],
      })
    ).rejects.toThrow('Invalid review decisions payload');
    await expect(
      store.load('demo', 'task-123', 'task:123:req:invalid:src:one')
    ).resolves.toBeNull();

    await expect(
      store.save('demo', 'task-123', {
        scopeToken: 'task:123:req:invalid:src:cross-branch',
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [duplicate],
        reviewRedoHistory: [
          {
            action: duplicate,
            decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
          },
        ],
      })
    ).rejects.toThrow('Invalid review decisions payload');
  });
});

async function fsEntries(dirPath: string): Promise<string[]> {
  try {
    return await (await import('fs/promises')).readdir(dirPath);
  } catch {
    return [];
  }
}

function exactScopeFilePath(teamName: string, scopeKey: string, scopeToken: string): string {
  const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
  return path.join(
    teamsBasePath,
    teamName,
    'review-decisions',
    'v2',
    encodeURIComponent(scopeKey),
    `${scopeHash}.json`
  );
}
