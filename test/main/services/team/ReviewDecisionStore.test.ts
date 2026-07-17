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
    });
    await expect(store.load('demo', 'task-123', 'task:123:req:b:src:two')).resolves.toEqual({
      hunkDecisions: { 'file-b:0': 'accepted' },
      fileDecisions: { 'file-b': 'accepted' },
      hunkContextHashesByFile: undefined,
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
    });
  });

  it('writes versioned v2 payloads under the scoped directory', async () => {
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
      version: 2,
      scopeKey: 'task-123',
      scopeToken: 'task:123:req:a:src:one',
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
    });
  });
});

async function fsEntries(dirPath: string): Promise<string[]> {
  try {
    return await (await import('fs/promises')).readdir(dirPath);
  } catch {
    return [];
  }
}
