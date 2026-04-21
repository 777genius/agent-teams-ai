import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let teamsBasePath: string;

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => teamsBasePath,
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

    await expect(
      store.load('demo', 'task-123', 'task:123:req:legacy:src:one')
    ).resolves.toEqual({
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

    const payload = JSON.parse(await readFile(path.join(scopeDir, entries[0]!), 'utf8')) as {
      version?: number;
      scopeKey?: string;
      scopeToken?: string;
    };
    expect(payload.version).toBe(2);
    expect(payload.scopeKey).toBe('task-123');
    expect(payload.scopeToken).toBe('task:123:req:a:src:one');
  });
});

async function fsEntries(dirPath: string): Promise<string[]> {
  try {
    return await (await import('fs/promises')).readdir(dirPath);
  } catch {
    return [];
  }
}
