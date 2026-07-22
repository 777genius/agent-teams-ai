import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangeExtractorService } from '../../../../src/main/services/team/ChangeExtractorService';
import { OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
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

function buildAssistantWriteEntry(
  toolUseId: string,
  filePath: string,
  content: string,
  timestamp: string
) {
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
  await fs.writeFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  );
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
        workIntervals: [
          { startedAt: '2026-03-01T10:00:00.000Z', completedAt: '2026-03-01T10:10:00.000Z' },
        ],
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

async function writeOpenCodeDeliveryLedger(
  baseDir: string,
  overrides?: Partial<{
    memberName: string;
    laneId: string;
    runtimeSessionId: string;
    inboxMessageId: string;
    deliveredUserMessageId: string;
    observedAssistantMessageId: string | null;
    taskId: string;
    displayId: string;
    teamName: string;
    taskRefs: { taskId: string; displayId: string; teamName: string }[];
  }>
): Promise<string> {
  const memberName = overrides?.memberName ?? 'bob';
  const laneId = overrides?.laneId ?? `secondary:opencode:${memberName}`;
  const filePath = path.join(
    baseDir,
    'teams',
    overrides?.teamName ?? TEAM_NAME,
    '.opencode-runtime',
    'lanes',
    encodeURIComponent(laneId),
    'opencode-prompt-delivery-ledger.json'
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        data: [
          {
            teamName: overrides?.teamName ?? TEAM_NAME,
            memberName,
            laneId,
            runtimeSessionId: overrides?.runtimeSessionId ?? 'session-1',
            inboxMessageId: overrides?.inboxMessageId ?? 'user-1',
            deliveredUserMessageId: overrides?.deliveredUserMessageId ?? 'user-1',
            observedAssistantMessageId: overrides?.observedAssistantMessageId ?? null,
            prePromptCursor: null,
            postPromptCursor: null,
            taskRefs: overrides?.taskRefs ?? [
              {
                taskId: overrides?.taskId ?? TASK_ID,
                displayId: overrides?.displayId ?? 'abc12345',
                teamName: overrides?.teamName ?? TEAM_NAME,
              },
            ],
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
  return filePath;
}

async function writeOpenCodeLedgerBundle(
  projectDir: string,
  projectPath: string,
  taskId: string = TASK_ID
): Promise<void> {
  const bundleDir = path.join(projectDir, '.board-task-changes', 'bundles');
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, `${encodeURIComponent(taskId)}.json`),
    JSON.stringify({
      schemaVersion: 1,
      source: 'task-change-ledger',
      taskId,
      generatedAt: '2026-03-01T10:00:00.000Z',
      eventCount: 1,
      files: [
        {
          filePath: path.join(projectPath, 'src/opencode.ts'),
          relativePath: 'src/opencode.ts',
          eventIds: ['event-1'],
          linesAdded: 1,
          linesRemoved: 0,
          isNewFile: true,
          latestAfterHash: null,
        },
      ],
      totalLinesAdded: 1,
      totalLinesRemoved: 0,
      totalFiles: 1,
      confidence: 'high',
      warnings: [],
      events: [
        {
          schemaVersion: 1,
          eventId: 'event-1',
          taskId,
          taskRef: taskId,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 0,
          sessionId: 'opencode-session-1',
          memberName: 'bob',
          toolUseId: 'part-1',
          source: 'opencode_toolpart_write',
          operation: 'create',
          confidence: 'exact',
          workspaceRoot: projectPath,
          filePath: path.join(projectPath, 'src/opencode.ts'),
          relativePath: 'src/opencode.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          oldString: '',
          newString: 'export const source = "opencode";\n',
          linesAdded: 1,
          linesRemoved: 0,
        },
      ],
    }),
    'utf8'
  );
}

async function writeWarningOnlyLedgerNotice(
  projectDir: string,
  overrides?: Partial<{
    taskId: string;
    memberName: string;
    message: string;
  }>
): Promise<void> {
  const taskId = overrides?.taskId ?? TASK_ID;
  const noticeDir = path.join(projectDir, '.board-task-changes', 'notices');
  await fs.mkdir(noticeDir, { recursive: true });
  await fs.writeFile(
    path.join(noticeDir, `${encodeURIComponent(taskId)}.jsonl`),
    `${JSON.stringify({
      schemaVersion: 1,
      noticeId: 'notice-1',
      taskId,
      taskRef: taskId,
      taskRefKind: 'canonical',
      phase: 'work',
      executionSeq: 0,
      sessionId: 'session-1',
      memberName: overrides?.memberName ?? 'alice',
      toolUseId: 'tool-1',
      timestamp: '2026-03-01T10:05:00.000Z',
      severity: 'warning',
      code: 'multi-scope-skipped',
      message:
        overrides?.message ??
        'Task change ledger skipped attribution because multiple task scopes were active.',
    })}\n`,
    'utf8'
  );
}

async function writeOpenCodeLedgerEventJournal(
  projectDir: string,
  projectPath: string,
  taskId: string = TASK_ID
): Promise<void> {
  const eventDir = path.join(projectDir, '.board-task-changes', 'events');
  await fs.mkdir(eventDir, { recursive: true });
  await fs.writeFile(
    path.join(eventDir, `${encodeURIComponent(taskId)}.jsonl`),
    `${JSON.stringify({
      schemaVersion: 1,
      eventId: 'event-1',
      taskId,
      taskRef: taskId,
      taskRefKind: 'canonical',
      phase: 'work',
      executionSeq: 0,
      sessionId: 'opencode-session-1',
      memberName: 'bob',
      toolUseId: 'part-1',
      source: 'opencode_toolpart_write',
      operation: 'create',
      confidence: 'exact',
      workspaceRoot: projectPath,
      filePath: path.join(projectPath, 'src/opencode.ts'),
      relativePath: 'src/opencode.ts',
      timestamp: '2026-03-01T10:00:00.000Z',
      toolStatus: 'succeeded',
      before: null,
      after: null,
      oldString: '',
      newString: 'export const source = "opencode";\n',
      linesAdded: 1,
      linesRemoved: 0,
    })}\n`,
    'utf8'
  );
}

function persistedEntryPath(baseDir: string): string {
  return path.join(
    baseDir,
    'task-change-summaries',
    encodeURIComponent(TEAM_NAME),
    `${TASK_ID}.json`
  );
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
      confidence: overrides.scope?.confidence ?? {
        tier: confidenceTierByLabel[confidence],
        label: confidence,
        reason: 'test fixture',
      },
    },
    warnings: overrides.warning ? [overrides.warning] : [],
  };
}

function pendingTaskChangeResult(): Promise<ReturnType<typeof makeTaskChangeResult>> {
  return new Promise<ReturnType<typeof makeTaskChangeResult>>(() => {
    // Keep pending to exercise summary timeout handling.
  });
}

function createService(params: {
  logPaths: string[];
  projectPath?: string;
  findLogFileRefsForTask?: (
    teamName: string,
    taskId: string,
    options?: unknown
  ) => Promise<unknown[]>;
  taskChangePresenceRepository?: {
    upsertEntry: ReturnType<typeof vi.fn>;
    deleteEntry?: ReturnType<typeof vi.fn>;
  };
  teamLogSourceTracker?: {
    ensureTracking: ReturnType<
      typeof vi.fn<
        () => Promise<{ projectFingerprint: string | null; logSourceGeneration: string | null }>
      >
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

  it('loads team task change summaries with capped requests and per-task errors', async () => {
    const { service } = createService({ logPaths: [] });
    const getTaskChanges = vi
      .spyOn(service, 'getTaskChanges')
      .mockImplementation(async (_teamName, taskId, options) => {
        expect(options?.summaryOnly).toBe(true);
        if (taskId === 'task-2') {
          throw new Error('broken summary');
        }
        return makeTaskChangeResult(taskId, { taskId });
      });

    const response = await service.getTeamTaskChangeSummaries(
      TEAM_NAME,
      Array.from({ length: 205 }, (_, index) => ({
        taskId: `task-${index}`,
        options: { ...SUMMARY_OPTIONS, summaryOnly: false },
      }))
    );

    expect(response.teamName).toBe(TEAM_NAME);
    expect(response.truncated).toBe(true);
    expect(response.items).toHaveLength(200);
    expect(getTaskChanges).toHaveBeenCalledTimes(200);
    expect(response.items[0].changeSet?.taskId).toBe('task-0');
    expect(response.items[2]).toMatchObject({
      taskId: 'task-2',
      changeSet: null,
      error: 'broken summary',
    });
  });

  it('times out slow team task change summaries without blocking faster items', async () => {
    vi.useFakeTimers();
    try {
      const { service } = createService({ logPaths: [] });
      const getTaskChanges = vi
        .spyOn(service, 'getTaskChanges')
        .mockImplementation((_teamName, taskId) => {
          if (taskId === 'slow-task') {
            return pendingTaskChangeResult();
          }
          return Promise.resolve(makeTaskChangeResult(taskId, { taskId }));
        });

      const responsePromise = service.getTeamTaskChangeSummaries(TEAM_NAME, [
        { taskId: 'slow-task', options: SUMMARY_OPTIONS },
        { taskId: 'fast-task', options: SUMMARY_OPTIONS },
      ]);

      await vi.advanceTimersByTimeAsync(31_000);
      const response = await responsePromise;

      expect(getTaskChanges).toHaveBeenCalledTimes(2);
      expect(response.truncated).toBe(true);
      expect(response.items[0]).toMatchObject({
        taskId: 'slow-task',
        changeSet: null,
        error: expect.stringContaining('timed out'),
      });
      expect(response.items[1].changeSet?.taskId).toBe('fast-task');
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits unscanned task summary placeholders after the batch deadline', async () => {
    vi.useFakeTimers();
    try {
      const { service } = createService({ logPaths: [] });
      vi.spyOn(service, 'getTaskChanges').mockImplementation(() => pendingTaskChangeResult());

      const responsePromise = service.getTeamTaskChangeSummaries(
        TEAM_NAME,
        Array.from({ length: 8 }, (_, index) => ({
          taskId: `slow-task-${index}`,
          options: SUMMARY_OPTIONS,
        }))
      );

      await vi.advanceTimersByTimeAsync(31_000);
      const response = await responsePromise;

      expect(response.truncated).toBe(true);
      expect(response.items).toHaveLength(6);
      expect(response.items.every((item) => item.error?.includes('timed out'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates team task change summary requests before loading', async () => {
    const { service } = createService({ logPaths: [] });
    const getTaskChanges = vi
      .spyOn(service, 'getTaskChanges')
      .mockImplementation((_teamName, taskId) =>
        Promise.resolve(makeTaskChangeResult(taskId, { taskId }))
      );

    const response = await service.getTeamTaskChangeSummaries(TEAM_NAME, [
      { taskId: 'task-1', options: SUMMARY_OPTIONS },
      { taskId: 'task-1', options: SUMMARY_OPTIONS },
      { taskId: ' task-2 ', options: SUMMARY_OPTIONS },
    ]);

    expect(response.items.map((item) => item.taskId)).toEqual(['task-1', 'task-2']);
    expect(response.truncated).toBeUndefined();
    expect(getTaskChanges).toHaveBeenCalledTimes(2);
  });

  it('ignores malformed team task change summary requests', async () => {
    const { service } = createService({ logPaths: [] });
    const getTaskChanges = vi
      .spyOn(service, 'getTaskChanges')
      .mockImplementation((_teamName, taskId) =>
        Promise.resolve(makeTaskChangeResult(taskId, { taskId }))
      );

    const response = await service.getTeamTaskChangeSummaries(TEAM_NAME, [
      null,
      { taskId: '' },
      { taskId: 'task-1', options: SUMMARY_OPTIONS },
      { taskId: 42 },
    ] as unknown as Parameters<typeof service.getTeamTaskChangeSummaries>[1]);

    expect(response.items.map((item) => item.taskId)).toEqual(['task-1']);
    expect(getTaskChanges).toHaveBeenCalledTimes(1);
  });

  it('limits raw team task summary request inspection before loading', async () => {
    const { service } = createService({ logPaths: [] });
    const getTaskChanges = vi
      .spyOn(service, 'getTaskChanges')
      .mockImplementation((_teamName, taskId) =>
        Promise.resolve(makeTaskChangeResult(taskId, { taskId }))
      );

    const response = await service.getTeamTaskChangeSummaries(TEAM_NAME, [
      ...Array.from({ length: 1000 }, () => null),
      { taskId: 'beyond-inspect-limit', options: SUMMARY_OPTIONS },
    ] as unknown as Parameters<typeof service.getTeamTaskChangeSummaries>[1]);

    expect(response.items).toEqual([]);
    expect(response.truncated).toBe(true);
    expect(getTaskChanges).not.toHaveBeenCalled();
  });

  it('does not reuse detailed task-change cache across different scope inputs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);

    const aliceLogPath = path.join(tmpDir, 'alice.jsonl');
    await writeJsonl(aliceLogPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    const findLogFileRefsForTask = vi.fn(
      async (_teamName: string, _taskId: string, options?: any) =>
        options?.owner === 'alice' ? [{ filePath: aliceLogPath, memberName: 'alice' }] : []
    );
    const service = createService({ logPaths: [aliceLogPath], findLogFileRefsForTask }).service;

    const empty = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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

  it('persists terminal summary signatures with task metadata status when request status is stale', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-stale-status.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    const first = createService({ logPaths: [logPath] });
    const initial = await first.service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      status: 'in_progress',
      stateBucket: 'active',
    });
    const persisted = JSON.parse(await fs.readFile(persistedEntryPath(tmpDir), 'utf8')) as {
      taskSignature: string;
    };
    const taskSignature = JSON.parse(persisted.taskSignature) as { status: string };

    const second = createService({ logPaths: [logPath] });
    const restored = await second.service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(taskSignature.status).toBe('completed');
    expect(initial.files).toHaveLength(1);
    expect(restored.files).toHaveLength(1);
    expect((second.findLogFileRefsForTask as any).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('forceFresh overwrites the persisted terminal summary snapshot', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-refresh.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    const { service } = createService({ logPaths: [logPath] });
    await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 2;\n',
        '2026-03-01T10:00:00.000Z'
      ),
      buildAssistantWriteEntry(
        'tool-2',
        '/repo/src/extra.ts',
        'export const extra = true;\n',
        '2026-03-01T10:02:00.000Z'
      ),
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    await createService({ logPaths: [logPath], projectPath: '/repo-a' }).service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );
    const drifted = createService({ logPaths: [logPath], projectPath: '/repo-b' });
    await drifted.service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect((drifted.findLogFileRefsForTask as any).mock.calls.length).toBeGreaterThan(1);
  });

  it('rejects persisted summaries when the task file is missing on restart', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    const taskPath = await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-missing-task.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    await createService({ logPaths: [logPath] }).service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );
    await fs.unlink(taskPath);
    await createService({ logPaths: [logPath] }).service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );

    await expect(fs.stat(persistedEntryPath(tmpDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back safely when the persisted summary file is corrupted', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-corrupt.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    await createService({ logPaths: [logPath] }).service.getTaskChanges(
      TEAM_NAME,
      TASK_ID,
      SUMMARY_OPTIONS
    );
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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
      buildAssistantWriteEntry(
        'tool-1',
        'C:\\repo\\src\\same.ts',
        'first\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);
    await writeJsonl(secondLogPath, [
      buildAssistantWriteEntry(
        'tool-2',
        'C:/repo/src/same.ts',
        'second\n',
        '2026-03-01T10:01:00.000Z'
      ),
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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

  it('does not fall back inline when task-change worker has a fatal OOM', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-inline-worker-oom.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
    ]);

    const computeTaskChanges = vi.fn(async () => {
      throw Object.assign(
        new Error('Worker terminated due to reaching memory limit: JS heap out of memory'),
        { code: 'ERR_WORKER_OUT_OF_MEMORY' }
      );
    });
    const { service, findLogFileRefsForTask } = createService({
      logPaths: [logPath],
      taskChangeWorkerClient: {
        isAvailable: vi.fn(() => true),
        computeTaskChanges,
      },
    });

    await expect(
      service.getTaskChanges(TEAM_NAME, TASK_ID, {
        owner: 'alice',
        status: 'completed',
      })
    ).rejects.toThrow('Worker terminated due to reaching memory limit');

    expect(computeTaskChanges).toHaveBeenCalledTimes(1);
    expect(findLogFileRefsForTask).not.toHaveBeenCalled();
  });

  it('keeps summary cache in main and skips worker on repeat terminal summary requests', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const logPath = path.join(tmpDir, 'alice-worker-summary-cache.jsonl');
    await writeJsonl(logPath, [
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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
      buildAssistantWriteEntry(
        'tool-1',
        '/repo/src/file.ts',
        'export const value = 1;\n',
        '2026-03-01T10:00:00.000Z'
      ),
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

  it('keeps in-flight summary compute across invalidation without caching stale results', async () => {
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
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.computeTaskChanges).toHaveBeenCalledTimes(1);

    first.resolve(makeTaskChangeResult());
    const stale = await stalePromise;
    const fresh = await freshPromise;

    expect(stale.files[0]?.filePath).toBe('/repo/src/file.ts');
    expect(fresh.files[0]?.filePath).toBe('/repo/src/file.ts');
    expect(worker.computeTaskChanges).toHaveBeenCalledTimes(1);

    const recomputed = await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);
    expect(recomputed.files[0]?.filePath).toBe('/repo/src/newer.ts');
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

  it('clears cached presence for diagnostic-only multi-scope task diff results', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const deleteEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      })
    );
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(() =>
        Promise.resolve(
          makeTaskChangeResult(TASK_ID, {
            content: '',
            confidence: 'fallback',
            warning: 'Ledger skipped attribution because multiple task scopes were active.',
          })
        )
      ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry, deleteEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, SUMMARY_OPTIONS);

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toEqual([
      'Ledger skipped attribution because multiple task scopes were active.',
    ]);
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith(TEAM_NAME, TASK_ID);
  });

  it('writes needs_attention presence entries for unclassified warning-only task diff results', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir);

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      })
    );
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(() =>
        Promise.resolve(
          makeTaskChangeResult(TASK_ID, {
            content: '',
            confidence: 'fallback',
            warning: 'Unexpected ledger warning.',
          })
        )
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
    expect(result.warnings).toEqual(['Unexpected ledger warning.']);
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
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
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
    expect(result.confidence === 'high' || result.confidence === 'medium').toBe(false);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it('clears stale presence entries for active uncertain empty task diff results', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, {
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
    });

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const deleteEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      })
    );
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(() =>
        Promise.resolve(makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' }))
      ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry, deleteEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      status: 'in_progress',
      stateBucket: 'active',
    });

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toEqual([]);
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith(TEAM_NAME, TASK_ID);
  });

  it('clears stale presence entries for newly created pending tasks without logs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, {
      status: 'pending',
      workIntervals: [],
    });

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const deleteEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      })
    );
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(() =>
        Promise.resolve(makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' }))
      ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry, deleteEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      status: 'completed',
      stateBucket: 'completed',
    });

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toEqual([]);
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith(TEAM_NAME, TASK_ID);
  });

  it('clears stale presence for pending related logs that have no task boundaries or file edits yet', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, {
      status: 'pending',
      workIntervals: [],
    });

    const logPath = path.join(tmpDir, 'lead-pending.jsonl');
    await writeJsonl(logPath, [
      {
        timestamp: '2026-03-01T10:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: `Task ${TASK_ID} was created and is waiting to start.`,
        },
      },
    ]);

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const deleteEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      })
    );
    const { service } = createService({
      logPaths: [logPath],
      taskChangePresenceRepository: { upsertEntry, deleteEntry },
      teamLogSourceTracker: { ensureTracking },
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      status: 'completed',
      stateBucket: 'completed',
    });

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toEqual([]);
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith(TEAM_NAME, TASK_ID);
  });

  it('passes task metadata status to task diff workers when request status is stale', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { status: 'completed', reviewState: 'none' });

    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(() =>
        Promise.resolve(makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' }))
      ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangeWorkerClient: workerClient,
    });

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      status: 'in_progress',
      stateBucket: 'completed',
    });

    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(1);
    const workerCalls = workerClient.computeTaskChanges.mock.calls as unknown as Array<[unknown]>;
    expect(workerCalls[0]?.[0]).toMatchObject({
      effectiveOptions: { status: 'completed' },
    });
  });

  it('keeps stale presence entries for completed uncertain empty task diff results even when request status is stale', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { status: 'completed', reviewState: 'none' });

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const deleteEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      })
    );
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(() =>
        Promise.resolve(makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' }))
      ),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry, deleteEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      status: 'in_progress',
      stateBucket: 'completed',
    });

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toEqual([]);
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('falls back inline before recording presence for malformed worker task diff results', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, {
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
    });

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const deleteEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      })
    );
    const malformedResult = {
      ...makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' }),
      files: undefined,
      warnings: undefined,
    } as unknown as ReturnType<typeof makeTaskChangeResult>;
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(() => Promise.resolve(malformedResult)),
    };
    const { service } = createService({
      logPaths: [],
      taskChangePresenceRepository: { upsertEntry, deleteEntry },
      teamLogSourceTracker: { ensureTracking },
      taskChangeWorkerClient: workerClient,
    });

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      status: 'in_progress',
      stateBucket: 'active',
    });

    expect(result.files).toEqual([]);
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith(TEAM_NAME, TASK_ID);
  });

  it('runs OpenCode recovery when a ledger result only contains warning notices', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeWarningOnlyLedgerNotice(projectDir, { memberName: 'bob' });
    await writeOpenCodeDeliveryLedger(tmpDir);

    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => {
      await writeOpenCodeLedgerEventJournal(input.projectDir, projectPath);
      return {
        schemaVersion: 1,
        providerId: 'opencode',
        opencodeTaskLedgerEvidenceContractVersion: OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
        teamName: input.teamName,
        taskId: input.taskId,
        projectDir: input.projectDir,
        workspaceRoot: input.workspaceRoot,
        dryRun: false,
        attributionMode: input.attributionMode,
        scannedSessions: 1,
        scannedToolparts: 1,
        candidateEvents: 1,
        importedEvents: 1,
        skippedEvents: 0,
        outcome: 'imported',
        notices: [],
        diagnostics: [],
      };
    });
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };
    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      owner: 'bob',
    });

    expect(result.files).toHaveLength(1);
    expect(result.warnings).toContain(
      'Task change ledger skipped attribution because multiple task scopes were active.'
    );
    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledTimes(1);
    expect(workerClient.computeTaskChanges).not.toHaveBeenCalled();
  });

  it('recovers Codex warning-only ledger results through the scoped worker path', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { owner: 'tom' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeWarningOnlyLedgerNotice(projectDir, { memberName: 'tom' });

    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, {
          filePath: path.join(projectPath, 'src/codex.ts'),
          scope: { memberName: 'tom' },
        })
      ),
    };
    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      {
        getConfig: vi.fn(async () => ({
          projectPath,
          members: [{ name: 'tom', providerId: 'codex' }],
        })),
      } as any,
      undefined,
      workerClient as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      owner: 'tom',
    });

    expect(result.files).toHaveLength(1);
    expect(result.warnings).toContain(
      'Task change ledger skipped attribution because multiple task scopes were active.'
    );
    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(1);
  });

  it('keeps non-Codex warning-only ledger results as diagnostics instead of adding legacy changes', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { owner: 'atlas' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeWarningOnlyLedgerNotice(projectDir, { memberName: 'atlas' });

    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () => makeTaskChangeResult(TASK_ID)),
    };
    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      {
        getConfig: vi.fn(async () => ({
          projectPath,
          members: [{ name: 'atlas', providerId: 'anthropic' }],
        })),
      } as any,
      undefined,
      workerClient as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      ...SUMMARY_OPTIONS,
      owner: 'atlas',
    });

    expect(result.files).toHaveLength(0);
    expect(result.warnings).toContain(
      'Task change ledger skipped attribution because multiple task scopes were active.'
    );
    expect(workerClient.computeTaskChanges).not.toHaveBeenCalled();
  });

  it('backfills OpenCode ledger artifacts once before falling back to legacy extraction', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir);

    let deliveryContextHashVerified = false;
    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => {
      deliveryContextHashVerified =
        createHash('sha256')
          .update(await fs.readFile(input.deliveryContextPath, 'utf8'))
          .digest('hex') === input.deliveryContextHash;
      await writeOpenCodeLedgerBundle(input.projectDir, projectPath);
      return {
        schemaVersion: 1,
        providerId: 'opencode',
        teamName: input.teamName,
        taskId: input.taskId,
        projectDir: input.projectDir,
        workspaceRoot: input.workspaceRoot,
        dryRun: false,
        scannedSessions: 1,
        scannedToolparts: 1,
        candidateEvents: 1,
        importedEvents: 1,
        skippedEvents: 0,
        outcome: 'imported',
        notices: [],
        diagnostics: [],
      };
    });
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.snippets[0]?.toolName).toBe('Write');
    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: TEAM_NAME,
        taskId: TASK_ID,
        taskDisplayId: 'abc12345',
        memberName: 'bob',
        projectDir,
        workspaceRoot: projectPath,
        attributionMode: 'strict-delivery',
      })
    );
    const backfillInput = backfillOpenCodeTaskLedger.mock.calls[0]?.[0];
    expect(backfillInput.deliveryContextPath).toEqual(
      expect.stringContaining('delivery-context.json')
    );
    expect(backfillInput.deliveryContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(deliveryContextHashVerified).toBe(true);
    expect(workerClient.computeTaskChanges).not.toHaveBeenCalled();
  });

  it('rereads ledger when OpenCode backfill writes artifacts and then fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir);

    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => {
      await writeOpenCodeLedgerBundle(input.projectDir, projectPath);
      throw new Error('timeout after import');
    });
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.snippets[0]?.toolName).toBe('Write');
    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledTimes(1);
    expect(workerClient.computeTaskChanges).not.toHaveBeenCalled();
  });

  it('uses the OpenCode delivery member when the current task owner changed later', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'alice' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir, { memberName: 'bob' });

    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => ({
      schemaVersion: 1,
      providerId: 'opencode',
      teamName: input.teamName,
      taskId: input.taskId,
      projectDir: input.projectDir,
      workspaceRoot: input.workspaceRoot,
      dryRun: false,
      attributionMode: input.attributionMode,
      scannedSessions: 0,
      scannedToolparts: 0,
      candidateEvents: 0,
      importedEvents: 0,
      skippedEvents: 0,
      outcome: 'no-history',
      notices: [],
      diagnostics: [],
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: 'bob',
        attributionMode: 'strict-delivery',
      })
    );
  });

  it('omits member filter when multiple OpenCode delivery members match the task', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'alice' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir, { memberName: 'bob', runtimeSessionId: 'session-1' });
    await writeOpenCodeDeliveryLedger(tmpDir, {
      memberName: 'carol',
      runtimeSessionId: 'session-2',
    });

    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => ({
      schemaVersion: 1,
      providerId: 'opencode',
      teamName: input.teamName,
      taskId: input.taskId,
      projectDir: input.projectDir,
      workspaceRoot: input.workspaceRoot,
      dryRun: false,
      attributionMode: input.attributionMode,
      scannedSessions: 0,
      scannedToolparts: 0,
      candidateEvents: 0,
      importedEvents: 0,
      skippedEvents: 0,
      outcome: 'no-history',
      notices: [],
      diagnostics: [],
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledTimes(1);
    expect(backfillOpenCodeTaskLedger.mock.calls[0]?.[0]).not.toHaveProperty('memberName');
  });

  it('ignores OpenCode delivery records that match only a recreated task display id', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir, {
      taskId: 'old-task',
      displayId: 'abc12345',
      memberName: 'bob',
    });

    const backfillOpenCodeTaskLedger = vi.fn(async () => {
      throw new Error('display-id-only delivery record must not backfill');
    });
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(result.files).toHaveLength(0);
    expect(backfillOpenCodeTaskLedger).not.toHaveBeenCalled();
    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(1);
  });

  it('ignores OpenCode delivery records that only mention related tasks', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir, {
      taskId: 'related-task',
      displayId: 'def67890',
      memberName: 'bob',
    });

    const backfillOpenCodeTaskLedger = vi.fn(async () => {
      throw new Error('related-only delivery record must not backfill');
    });
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(result.files).toHaveLength(0);
    expect(backfillOpenCodeTaskLedger).not.toHaveBeenCalled();
    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(1);
  });

  it('does not run OpenCode backfill for explicit non-OpenCode teams even if stale runtime files exist', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'alice' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'teams', TEAM_NAME, '.opencode-runtime'), {
      recursive: true,
    });

    const backfillOpenCodeTaskLedger = vi.fn(async () => {
      throw new Error('OpenCode backfill should not run for non-OpenCode teams');
    });
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () => makeTaskChangeResult(TASK_ID)),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      {
        getConfig: vi.fn(async () => ({
          projectPath,
          members: [{ name: 'alice', providerId: 'codex' }],
        })),
      } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'codex' })) } as any
    );

    const result = await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'alice',
      status: 'completed',
    });

    expect(result.files).toHaveLength(1);
    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(1);
    expect(backfillOpenCodeTaskLedger).not.toHaveBeenCalled();
  });

  it('awaits OpenCode backfill for summary-only requests with delivery context before falling back', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir);
    const pendingBackfill = deferred<any>();
    const backfillOpenCodeTaskLedger = vi.fn(() => pendingBackfill.promise);
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    let settled = false;
    const request = service
      .getTaskChanges(TEAM_NAME, TASK_ID, { ...SUMMARY_OPTIONS, owner: 'bob' })
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(
      () => {
        expect(backfillOpenCodeTaskLedger).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: TEAM_NAME,
            taskId: TASK_ID,
            projectDir,
            workspaceRoot: projectPath,
            deliveryContextPath: expect.stringContaining('delivery-context.json'),
            deliveryContextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            attributionMode: 'strict-delivery',
          })
        );
      },
      { timeout: 5_000 }
    );
    expect(settled).toBe(false);
    expect(workerClient.computeTaskChanges).not.toHaveBeenCalled();
    pendingBackfill.resolve({
      schemaVersion: 1,
      providerId: 'opencode',
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      projectDir,
      workspaceRoot: projectPath,
      dryRun: false,
      scannedSessions: 0,
      scannedToolparts: 0,
      candidateEvents: 0,
      importedEvents: 0,
      skippedEvents: 0,
      outcome: 'no-history',
      notices: [],
      diagnostics: [],
    });

    const result = await request;
    expect(result.files).toHaveLength(0);
    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a negative OpenCode backfill cache entry after delivery context appears', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => ({
      schemaVersion: 1,
      providerId: 'opencode',
      teamName: input.teamName,
      taskId: input.taskId,
      projectDir: input.projectDir,
      workspaceRoot: input.workspaceRoot,
      dryRun: false,
      attributionMode: input.attributionMode,
      scannedSessions: 0,
      scannedToolparts: 0,
      candidateEvents: 0,
      importedEvents: 0,
      skippedEvents: 0,
      outcome: 'no-attribution',
      notices: [],
      diagnostics: [],
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });
    expect(backfillOpenCodeTaskLedger).not.toHaveBeenCalled();

    await writeOpenCodeDeliveryLedger(tmpDir);

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledTimes(1);
    expect(backfillOpenCodeTaskLedger.mock.calls[0]?.[0]?.deliveryContextPath).toEqual(
      expect.stringContaining('delivery-context.json')
    );
    expect(backfillOpenCodeTaskLedger.mock.calls[0]?.[0]?.deliveryContextHash).toMatch(
      /^[a-f0-9]{64}$/
    );
  });

  it('does not cache negative OpenCode backfill while delivery context already exists', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const deliveryLedgerPath = path.join(
      tmpDir,
      'teams',
      TEAM_NAME,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent('secondary:opencode:bob'),
      'opencode-prompt-delivery-ledger.json'
    );
    await fs.mkdir(path.dirname(deliveryLedgerPath), { recursive: true });
    await fs.writeFile(
      deliveryLedgerPath,
      JSON.stringify({
        data: [
          {
            teamName: TEAM_NAME,
            memberName: 'bob',
            laneId: 'secondary:opencode:bob',
            runtimeSessionId: 'session-1',
            inboxMessageId: 'user-1',
            deliveredUserMessageId: 'user-1',
            observedAssistantMessageId: null,
            prePromptCursor: null,
            postPromptCursor: null,
            taskRefs: [{ taskId: TASK_ID, displayId: 'abc12345', teamName: TEAM_NAME }],
          },
        ],
      }),
      'utf8'
    );

    let backfillAttempt = 0;
    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => {
      const outcome = backfillAttempt++ === 0 ? 'transient-error' : 'no-attribution';
      return {
        schemaVersion: 1,
        providerId: 'opencode',
        teamName: input.teamName,
        taskId: input.taskId,
        projectDir: input.projectDir,
        workspaceRoot: input.workspaceRoot,
        dryRun: false,
        attributionMode: input.attributionMode,
        scannedSessions: 1,
        scannedToolparts: 0,
        candidateEvents: 0,
        importedEvents: 0,
        skippedEvents: 0,
        outcome,
        notices: [],
        diagnostics:
          outcome === 'transient-error'
            ? ['OpenCode SQLite file changed while snapshot was read; using transaction snapshot.']
            : [],
      };
    });
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });
    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledTimes(2);
    expect(backfillOpenCodeTaskLedger.mock.calls[0]?.[0]?.deliveryContextPath).toEqual(
      expect.stringContaining('delivery-context.json')
    );
    expect(backfillOpenCodeTaskLedger.mock.calls[0]?.[0]?.deliveryContextHash).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(backfillOpenCodeTaskLedger.mock.calls[1]?.[0]?.deliveryContextPath).toEqual(
      expect.stringContaining('delivery-context.json')
    );
    expect(backfillOpenCodeTaskLedger.mock.calls[1]?.[0]?.deliveryContextHash).toMatch(
      /^[a-f0-9]{64}$/
    );
  });

  it('does not cache duplicates-only OpenCode backfill from an old evidence contract', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir);

    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => ({
      schemaVersion: 1,
      providerId: 'opencode',
      teamName: input.teamName,
      taskId: input.taskId,
      projectDir: input.projectDir,
      workspaceRoot: input.workspaceRoot,
      dryRun: false,
      attributionMode: input.attributionMode,
      scannedSessions: 1,
      scannedToolparts: 1,
      candidateEvents: 1,
      importedEvents: 0,
      skippedEvents: 1,
      outcome: 'duplicates-only',
      notices: [],
      diagnostics: [],
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });
    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledTimes(2);
    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(2);
  });

  it('caches duplicates-only OpenCode backfill from the current evidence contract', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-service-'));
    setClaudeBasePathOverride(tmpDir);
    await writeTaskFile(tmpDir, { displayId: 'abc12345', owner: 'bob' });
    const projectDir = path.join(tmpDir, 'project-dir');
    const projectPath = path.join(tmpDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeOpenCodeDeliveryLedger(tmpDir);

    const backfillOpenCodeTaskLedger = vi.fn(async (input: any) => ({
      schemaVersion: 1,
      providerId: 'opencode',
      opencodeTaskLedgerEvidenceContractVersion: OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
      teamName: input.teamName,
      taskId: input.taskId,
      projectDir: input.projectDir,
      workspaceRoot: input.workspaceRoot,
      dryRun: false,
      attributionMode: input.attributionMode,
      scannedSessions: 1,
      scannedToolparts: 1,
      candidateEvents: 1,
      importedEvents: 0,
      skippedEvents: 1,
      outcome: 'duplicates-only',
      notices: [],
      diagnostics: [],
    }));
    const workerClient = {
      isAvailable: vi.fn(() => true),
      computeTaskChanges: vi.fn(async () =>
        makeTaskChangeResult(TASK_ID, { content: '', confidence: 'fallback' })
      ),
    };

    const service = new ChangeExtractorService(
      {
        getLogSourceWatchContext: vi.fn(async () => ({
          projectDir,
          projectPath,
          sessionIds: [],
        })),
        findLogFileRefsForTask: vi.fn(async () => []),
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
      { getConfig: vi.fn(async () => ({ projectPath })) } as any,
      undefined,
      workerClient as any,
      { backfillOpenCodeTaskLedger } as any,
      { getMeta: vi.fn(async () => ({ providerId: 'opencode' })) } as any
    );

    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });
    await service.getTaskChanges(TEAM_NAME, TASK_ID, {
      owner: 'bob',
      status: 'completed',
    });

    expect(backfillOpenCodeTaskLedger).toHaveBeenCalledTimes(1);
    expect(workerClient.computeTaskChanges).toHaveBeenCalledTimes(2);
  });
});
