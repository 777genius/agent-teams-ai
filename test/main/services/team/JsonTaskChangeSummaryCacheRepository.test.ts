import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as fs from 'fs/promises';

import { JsonTaskChangeSummaryCacheRepository } from '../../../../src/main/services/team/cache/JsonTaskChangeSummaryCacheRepository';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { PersistedTaskChangeSummaryEntry } from '../../../../src/main/services/team/cache/taskChangeSummaryCacheTypes';

function buildEntry(overrides?: Partial<PersistedTaskChangeSummaryEntry>): PersistedTaskChangeSummaryEntry {
  return {
    version: 1,
    teamName: 'team-a',
    taskId: '1',
    stateBucket: 'completed',
    taskSignature: '{"owner":"alice"}',
    sourceFingerprint: 'source-fingerprint',
    projectFingerprint: 'project-fingerprint',
    writtenAt: '2026-03-01T10:00:00.000Z',
    expiresAt: '2099-03-01T10:00:00.000Z',
    extractorConfidence: 'high',
    summary: {
      teamName: 'team-a',
      taskId: '1',
      files: [
        {
          filePath: '/repo/src/file.ts',
          relativePath: 'src/file.ts',
          snippets: [
            {
              toolUseId: 'tool-1',
              filePath: '/repo/src/file.ts',
              toolName: 'Write',
              type: 'write-new',
              oldString: '',
              newString: 'x',
              replaceAll: false,
              timestamp: '2026-03-01T10:00:00.000Z',
              isError: false,
            },
          ],
          linesAdded: 1,
          linesRemoved: 0,
          isNewFile: true,
        },
      ],
      totalFiles: 1,
      totalLinesAdded: 1,
      totalLinesRemoved: 0,
      confidence: 'high',
      computedAt: '2026-03-01T10:00:00.000Z',
      scope: {
        taskId: '1',
        memberName: 'alice',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: ['/repo/src/file.ts'],
        confidence: { tier: 1, label: 'high', reason: 'test' },
      },
      warnings: [],
    },
    ...overrides,
  };
}

describe('JsonTaskChangeSummaryCacheRepository', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('saves and loads normalized per-task entries', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-summary-repo-'));
    setClaudeBasePathOverride(tmpDir);
    const repo = new JsonTaskChangeSummaryCacheRepository();

    await repo.save(buildEntry());
    const loaded = await repo.load('team-a', '1');

    expect(loaded?.summary.files[0]?.snippets).toEqual([]);
    expect(
      await fs.readFile(
        path.join(tmpDir, 'task-change-summaries', encodeURIComponent('team-a'), '1.json'),
        'utf8'
      )
    ).toContain('"teamName": "team-a"');
  });

  it('treats expired entries as cache misses', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-summary-repo-'));
    setClaudeBasePathOverride(tmpDir);
    const repo = new JsonTaskChangeSummaryCacheRepository();

    await repo.save(buildEntry({ expiresAt: '2000-03-01T10:00:00.000Z' }));

    expect(await repo.load('team-a', '1')).toBeNull();
  });

  it('ignores malformed entries and deletes them best-effort', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-summary-repo-'));
    setClaudeBasePathOverride(tmpDir);
    const repo = new JsonTaskChangeSummaryCacheRepository();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filePath = path.join(tmpDir, 'task-change-summaries', encodeURIComponent('team-a'), '1.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{bad-json', 'utf8');

    expect(await repo.load('team-a', '1')).toBeNull();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let older generations overwrite newer ones', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-summary-repo-'));
    setClaudeBasePathOverride(tmpDir);
    const repo = new JsonTaskChangeSummaryCacheRepository();

    const newer = await repo.save(buildEntry({ taskSignature: 'newer' }), { generation: 2 });
    const older = await repo.save(buildEntry({ taskSignature: 'older' }), { generation: 1 });
    const loaded = await repo.load('team-a', '1');

    expect(newer.written).toBe(true);
    expect(older.written).toBe(false);
    expect(loaded?.taskSignature).toBe('newer');
  });
});
