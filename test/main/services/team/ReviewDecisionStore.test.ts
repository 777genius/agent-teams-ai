import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
