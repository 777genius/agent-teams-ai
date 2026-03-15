import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as fs from 'fs/promises';

import { ChangeExtractorService } from '../../../../src/main/services/team/ChangeExtractorService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const TEAM_NAME = 'team-a';
const TASK_ID = '1';
const PROJECT_PATH = '/repo';
const SUMMARY_OPTIONS = {
  owner: 'alice',
  status: 'completed',
  stateBucket: 'completed' as const,
  summaryOnly: true,
};

function buildAssistantWriteEntry(toolUseId: string, filePath: string, content: string, timestamp: string) {
  return {
    timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Write',
          input: { file_path: filePath, content },
        },
      ],
    },
  };
}

async function writeJsonl(filePath: string, entries: object[]): Promise<void> {
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

async function writeTaskFile(
  baseDir: string,
  overrides?: Record<string, unknown>
): Promise<string> {
  const taskPath = path.join(baseDir, 'tasks', TEAM_NAME, `${TASK_ID}.json`);
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.writeFile(
    taskPath,
    JSON.stringify(
      {
        id: TASK_ID,
        owner: 'alice',
        status: 'completed',
        createdAt: '2026-03-01T09:55:00.000Z',
        updatedAt: '2026-03-01T10:10:00.000Z',
        workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z', completedAt: '2026-03-01T10:10:00.000Z' }],
        historyEvents: [],
        ...overrides,
      },
      null,
      2
    ),
    'utf8'
  );
  return taskPath;
}

function persistedEntryPath(baseDir: string): string {
  return path.join(baseDir, 'task-change-summaries', encodeURIComponent(TEAM_NAME), `${TASK_ID}.json`);
}

function createService(params: {
  logPaths: string[];
  projectPath?: string;
  findLogFileRefsForTask?: (teamName: string, taskId: string, options?: unknown) => Promise<unknown[]>;
}) {
  const findLogFileRefsForTask =
    params.findLogFileRefsForTask ??
    vi.fn(async () => params.logPaths.map((filePath) => ({ filePath, memberName: 'alice' })));
  return {
    findLogFileRefsForTask,
    service: new ChangeExtractorService(
      {
        findLogFileRefsForTask,
        findMemberLogPaths: vi.fn(async () => []),
      } as any,
      {
        parseBoundaries: vi.fn(async () => ({
          boundaries: [],
          scopes: [],
          isSingleTaskSession: true,
          detectedMechanism: 'none' as const,
        })),
      } as any,
      { getConfig: vi.fn(async () => ({ projectPath: params.projectPath ?? PROJECT_PATH })) } as any
    ),
  };
}

describe('ChangeExtractorService', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('does not reuse detailed task-change cache across different scope inputs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);

    const aliceLogPath = path.join(tmpDir, 'alice.jsonl');
    await writeJsonl(aliceLogPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const findLogFileRefsForTask = vi.fn(async (_teamName: string, _taskId: string, options?: any) =>
      options?.owner === 'alice' ? [{ filePath: aliceLogPath, memberName: 'alice' }] : []
    );
    const service = createService({ logPaths: [aliceLogPath], findLogFileRefsForTask }).service;

    const empty = await service.getTaskChanges(TEAM_NAME, TASK_ID, { owner: 'bob', status: 'completed' });
    const populated = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(empty.files).toHaveLength(0);
    expect(populated.files).toHaveLength(1);
    expect(findLogFileRefsForTask).toHaveBeenCalledTimes(2);
  });

  it('caches terminal summary requests in memory but keeps detailed requests fresh', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);

    const logPath = path.join(tmpDir, 'alice-summary.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const { service, findLogFileRefsForTask } = createService({ logPaths: [logPath] });

    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
      stateBucket: 'completed',
    });
    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
      stateBucket: 'completed',
    });

    expect(findLogFileRefsForTask).toHaveBeenCalledTimes(3);
  });

  it('restores a persisted terminal summary after a simulated restart', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-restart.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const first = createService({ logPaths: [logPath] });
    const initial = await first.service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    const second = createService({ logPaths: [logPath] });
    const restored = await second.service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(initial.files).toHaveLength(1);
    expect(restored.files).toHaveLength(1);
    expect(await fs.readFile(persistedEntryPath(tmpDir), 'utf8')).toContain('"taskId": "1"');
    // The second service restores from persisted cache; findLogFileRefsForTask may be called
    // at most once for background validation (setTimeout(0) in schedulePersistedTaskChangeSummaryValidation)
    expect((second.findLogFileRefsForTask as any).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('forceFresh overwrites the persisted terminal summary snapshot', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-refresh.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const { service } = createService({ logPaths: [logPath] });
    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 2;\n', '2026-03-01T10:00:00.000Z'),
      buildAssistantWriteEntry('tool-2', '/repo/src/extra.ts', 'export const extra = true;\n', '2026-03-01T10:02:00.000Z'),
    ]);

    const refreshed = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      forceFresh: true,
    });
    const after = await createService({ logPaths: [logPath] }).service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );

    expect(refreshed.totalFiles).toBe(2);
    expect(after.totalFiles).toBe(2);
  });

  it('invalidates old terminal summaries when the task moves into review', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-review.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const { service } = createService({ logPaths: [logPath] });
    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    await writeTaskFile(tmpDir, {
      historyEvents: [
        {
          id: 'evt-review',
          type: 'review_requested',
          to: 'review',
          timestamp: '2026-03-01T11:00:00.000Z',
        },
      ],
    });

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
      stateBucket: 'review',
      summaryOnly: true,
    });

    await expect(fs.stat(persistedEntryPath(tmpDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects persisted summaries after project/worktree drift', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-project-drift.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    await createService({ logPaths: [logPath], projectPath: '/repo-a' }).service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );
    const drifted = createService({ logPaths: [logPath], projectPath: '/repo-b' });
    await drifted.service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );

    expect((drifted.findLogFileRefsForTask as any).mock.calls.length).toBeGreaterThan(1);
  });

  it('rejects persisted summaries when the task file is missing on restart', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    const taskPath = await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-missing-task.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    await createService({ logPaths: [logPath] }).service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    await fs.unlink(taskPath);
    await createService({ logPaths: [logPath] }).service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    await expect(fs.stat(persistedEntryPath(tmpDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back safely when the persisted summary file is corrupted', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-corrupt.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    await createService({ logPaths: [logPath] }).service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(persistedEntryPath(tmpDir), '{bad-json', 'utf8');

    const restored = await createService({ logPaths: [logPath] }).service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );

    expect(restored.files).toHaveLength(1);
  });

  it('does not persist low-confidence fallback summaries', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { workIntervals: [], historyEvents: [] });

    const logPath = path.join(tmpDir, 'alice-fallback.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const service = new ChangeExtractorService(
      {
        findLogFileRefsForTask: vi.fn(async () => [{ filePath: logPath, memberName: 'alice' }]),
        findMemberLogPaths: vi.fn(async () => []),
      } as any,
      {
        parseBoundaries: vi.fn(async () => ({
          boundaries: [],
          scopes: [],
          isSingleTaskSession: false,
          detectedMechanism: 'none' as const,
        })),
      } as any,
      { getConfig: vi.fn(async () => ({ projectPath: PROJECT_PATH })) } as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(result.confidence).toBe('fallback');
    await expect(fs.stat(persistedEntryPath(tmpDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('merges fallback changes for the same Windows file across slash variants', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);

    const firstLogPath = path.join(tmpDir, 'first.jsonl');
    const secondLogPath = path.join(tmpDir, 'second.jsonl');
    await writeJsonl(firstLogPath, [
      buildAssistantWriteEntry('tool-1', 'C:\\repo\\src\\same.ts', 'first\n', '2026-03-01T10:00:00.000Z'),
    ]);
    await writeJsonl(secondLogPath, [
      buildAssistantWriteEntry('tool-2', 'C:/repo/src/same.ts', 'second\n', '2026-03-01T10:01:00.000Z'),
    ]);

    const service = createService({
      logPaths: [firstLogPath, secondLogPath],
      projectPath: 'C:\\repo',
    }).service;

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.relativePath).toBe('src/same.ts');
    expect(result.totalLinesAdded).toBe(2);
  });
});
