import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as fs from 'fs/promises';

import { ChangeExtractorService } from '../../../../src/main/services/team/ChangeExtractorService';
import { buildTaskChangePresenceDescriptor } from '../../../../src/main/services/team/taskChangePresenceUtils';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTaskChangeResult(
  taskId = TASK_ID,
  overrides: Partial<{
    teamName: string;
    taskId: string;
    filePath: string;
    confidence: 'high' | 'medium' | 'low' | 'fallback';
    content: string;
    warning: string;
    scope: Partial<{
      memberName: string;
      startTimestamp: string;
      endTimestamp: string;
      toolUseIds: string[];
      filePaths: string[];
      confidence: {
        tier: 1 | 2 | 3 | 4;
        label: 'high' | 'medium' | 'low' | 'fallback';
        reason: string;
      };
    }>;
  }> = {}
) {
  const teamName = overrides.teamName ?? TEAM_NAME;
  const targetTaskId = overrides.taskId ?? taskId;
  const filePath = overrides.filePath ?? '/repo/src/file.ts';
  const content = overrides.content ?? 'export const value = 1;\n';
  const confidence = overrides.confidence ?? 'high';
  const confidenceTierByLabel = {
    high: 1,
    medium: 2,
    low: 3,
    fallback: 4,
  } as const;
  const files =
    content.length > 0
      ? [
          {
            filePath,
            relativePath: 'src/file.ts',
            snippets: [],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
          },
        ]
      : [];

  return {
    teamName,
    taskId: targetTaskId,
    files,
    totalFiles: files.length,
    totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
    totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
    confidence,
    computedAt: '2026-03-01T12:00:00.000Z',
    scope: {
      taskId: targetTaskId,
      memberName: overrides.scope?.memberName ?? 'alice',
      startLine: 0,
      endLine: 0,
      startTimestamp: overrides.scope?.startTimestamp ?? '',
      endTimestamp: overrides.scope?.endTimestamp ?? '',
      toolUseIds: overrides.scope?.toolUseIds ?? [],
      filePaths: overrides.scope?.filePaths ?? files.map((file) => file.filePath),
      confidence:
        overrides.scope?.confidence ?? {
          tier: confidenceTierByLabel[confidence],
          label: confidence,
          reason: 'test fixture',
        },
    },
    warnings: overrides.warning ? [overrides.warning] : [],
  };
}

function createService(params: {
  logPaths: string[];
  projectPath?: string;
  findLogFileRefsForTask?: (teamName: string, taskId: string, options?: unknown) => Promise<unknown[]>;
  taskChangePresenceRepository?: { upsertEntry: ReturnType<typeof vi.fn> };
  teamLogSourceTracker?: {
    ensureTracking: ReturnType<
      typeof vi.fn<() => Promise<{ projectFingerprint: string | null; logSourceGeneration: string | null }>>
    >;
  };
  taskChangeWorkerClient?: {
    isAvailable: ReturnType<typeof vi.fn<() => boolean>>;
    computeTaskChanges: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  };
}) {
  const findLogFileRefsForTask =
    params.findLogFileRefsForTask ??
    vi.fn(async () => params.logPaths.map((filePath) => ({ filePath, memberName: 'alice' })));
  const taskChangeWorkerClient =
    params.taskChangeWorkerClient ??
    ({
      isAvailable: vi.fn(() => false),
      computeTaskChanges: vi.fn(async () => {
        throw new Error('worker disabled in test');
      }),
    } as const);
  const service = new ChangeExtractorService(
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
    { getConfig: vi.fn(async () => ({ projectPath: params.projectPath ?? PROJECT_PATH })) } as any,
    undefined,
    taskChangeWorkerClient as any
  );

  if (params.taskChangePresenceRepository && params.teamLogSourceTracker) {
    service.setTaskChangePresenceServices(
      params.taskChangePresenceRepository as any,
      params.teamLogSourceTracker as any
    );
  }

  return {
    findLogFileRefsForTask,
    service,
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
      { getConfig: vi.fn(async () => ({ projectPath: PROJECT_PATH })) } as any,
      undefined,
      {
        isAvailable: vi.fn(() => false),
        computeTaskChanges: vi.fn(async () => {
          throw new Error('worker disabled in test');
        }),
      } as any
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

  it('prefers worker task-change results when the worker is available', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const workerResult = makeTaskChangeResult();
    const computeTaskChanges = vi.fn(async () => workerResult);
    const { service, findLogFileRefsForTask } = createService({
      logPaths: [],
      taskChangeWorkerClient: {
        isAvailable: vi.fn(() => true),
        computeTaskChanges,
      },
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(result).toEqual(workerResult);
    expect(computeTaskChanges).toHaveBeenCalledTimes(1);
    expect(findLogFileRefsForTask).not.toHaveBeenCalled();
  });

  it('falls back inline when task-change worker is unavailable', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-inline-unavailable.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const computeTaskChanges = vi.fn();
    const { service, findLogFileRefsForTask } = createService({
      logPaths: [logPath],
      taskChangeWorkerClient: {
        isAvailable: vi.fn(() => false),
        computeTaskChanges,
      },
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(result.files).toHaveLength(1);
    expect(findLogFileRefsForTask).toHaveBeenCalled();
    expect(computeTaskChanges).not.toHaveBeenCalled();
  });

  it('falls back inline when task-change worker throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-inline-worker-error.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const computeTaskChanges = vi.fn(async () => {
      throw new Error('worker failed');
    });
    const { service, findLogFileRefsForTask } = createService({
      logPaths: [logPath],
      taskChangeWorkerClient: {
        isAvailable: vi.fn(() => true),
        computeTaskChanges,
      },
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(result.files).toHaveLength(1);
    expect(computeTaskChanges).toHaveBeenCalledTimes(1);
    expect(findLogFileRefsForTask).toHaveBeenCalled();
  });

  it('keeps summary cache in main and skips worker on repeat terminal summary requests', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-worker-summary-cache.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const computeTaskChanges = vi.fn(async () => makeTaskChangeResult());
    const { service } = createService({
      logPaths: [logPath],
      taskChangeWorkerClient: {
        isAvailable: vi.fn(() => true),
        computeTaskChanges,
      },
    });

    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(computeTaskChanges).toHaveBeenCalledTimes(1);
  });

  it('restores persisted summaries without invoking worker compute', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-worker-persisted.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry('tool-1', '/repo/src/file.ts', 'export const value = 1;\n', '2026-03-01T10:00:00.000Z'),
    ]);

    const firstWorker = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () => makeTaskChangeResult()),
    };
    await createService({
      logPaths: [logPath],
      taskChangeWorkerClient: firstWorker,
    }).service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    const secondWorker = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () => makeTaskChangeResult(TASK_ID, { content: 'stale\n' })),
    };
    const restored = await createService({
      logPaths: [logPath],
      taskChangeWorkerClient: secondWorker,
    }).service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(restored.files).toHaveLength(1);
    expect(secondWorker.computeTaskChanges).not.toHaveBeenCalled();
  });

  it('does not let stale worker results populate summary cache after invalidation', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const first = deferred<ReturnType<typeof makeTaskChangeResult>>();
    const firstStarted = deferred<void>();
    const worker = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi
        .fn()
        .mockImplementationOnce(() => {
          firstStarted.resolve();
          return first.promise;
        })
        .mockImplementationOnce(async () =>
          makeTaskChangeResult(TASK_ID, { filePath: '/repo/src/newer.ts' })
        ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangeWorkerClient: worker,
    });

    const stalePromise = service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    await firstStarted.promise;
    await service.invalidateTaskChangeSummaries(TEAM_NAME, [TASK_ID], { deletePersisted: true });
    const freshPromise = service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    // Flush microtasks so freshPromise advances past its internal awaits
    // and reaches the worker mock before we resolve the stale deferred.
    // Without this, CI timing can cause the stale resolution to race with
    // the fresh worker call, making the test flaky.
    await vi.advanceTimersByTimeAsync?.(0).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    first.resolve(makeTaskChangeResult());
    const stale = await stalePromise;
    const fresh = await freshPromise;

    expect(stale.files[0]?.filePath).toBe('/repo/src/file.ts');
    expect(fresh.files[0]?.filePath).toBe('/repo/src/newer.ts');
    expect(worker.computeTaskChanges).toHaveBeenCalledTimes(2);
  });

  it('writes has_changes presence entries after successful task diff computation', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-presence.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    const upsertEntry = vi.fn(async () => undefined);
    const ensureTracking = vi.fn(async () => ({
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () => makeTaskChangeResult()),
    };
    const { service } = createService({
      logPaths: [logPath],
      taskChangePresenceRepository: { upsertEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(upsertEntry).toHaveBeenCalledWith(
      TEAM_NAME,
      expect.objectContaining({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      }),
      expect.objectContaining({
        taskId: TASK_ID,
        presence: 'has_changes',
        taskSignature: buildTaskChangePresenceDescriptor({
          createdAt: '2026-03-01T09:55:00.000Z',
          owner: 'alice',
          status: 'completed',
          intervals: [
            {
              startedAt: '2026-03-01T10:00:00.000Z',
              completedAt: '2026-03-01T10:10:00.000Z',
            },
          ],
          reviewState: 'none',
          historyEvents: [],
        }).taskSignature,
      })
    );
  });

  it('writes needs_attention presence entries for warning-only task diff results', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const upsertEntry = vi.fn(async () => undefined);
    const ensureTracking = vi.fn(async () => ({
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, {
          content: '',
          confidence: 'fallback',
          warning: 'Ledger skipped attribution because multiple task scopes were active.',
        })
      ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toEqual([
      'Ledger skipped attribution because multiple task scopes were active.',
    ]);
    expect(upsertEntry).toHaveBeenCalledWith(
      TEAM_NAME,
      expect.objectContaining({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      }),
      expect.objectContaining({
        taskId: TASK_ID,
        presence: 'needs_attention',
      })
    );
  });

  it('does not write warning-only presence for active interval summaries with no observed file edits yet', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const upsertEntry = vi.fn(async () => undefined);
    const ensureTracking = vi.fn(async () => ({
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, {
          content: '',
          confidence: 'medium',
          warning: 'No file edits found within persisted workIntervals.',
          scope: {
            memberName: 'echo',
            startTimestamp: '2026-03-01T12:00:00.000Z',
            endTimestamp: '',
            toolUseIds: [],
            filePaths: [],
            confidence: {
              tier: 2,
              label: 'medium',
              reason: 'Scoped by persisted task workIntervals (timestamp-based)',
            },
          },
        })
      ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toEqual(['No file edits found within persisted workIntervals.']);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it('does not write no_changes presence entries for uncertain empty task diff results', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const upsertEntry = vi.fn(async () => undefined);
    const ensureTracking = vi.fn(async () => ({
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () => makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(result.files).toHaveLength(0);
    expect(result.confidence === 'high' || result.confidence === 'medium').toBe(false);
    expect(upsertEntry).not.toHaveBeenCalled();
  });
});
