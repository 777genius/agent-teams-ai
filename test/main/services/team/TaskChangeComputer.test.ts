import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskChangeComputer } from '../../../../src/main/services/team/TaskChangeComputer';

import type { TaskChangeTaskMeta } from '../../../../src/main/services/team/taskChangeWorkerTypes';

const NO_TASK_BOUNDARIES_WARNING =
  'No task boundaries found - showing all changes from related sessions.';

const noBoundaryTerminalCases: Array<{
  name: string;
  taskMeta: TaskChangeTaskMeta;
}> = [
  {
    name: 'completed',
    taskMeta: { status: 'completed', reviewState: 'none' },
  },
  {
    name: 'review',
    taskMeta: { status: 'completed', reviewState: 'review' },
  },
  {
    name: 'approved',
    taskMeta: { status: 'completed', reviewState: 'approved' },
  },
];

async function writeJsonl(filePath: string, entries: object[]): Promise<void> {
  await fs.writeFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  );
}

function writeToolUse(
  toolUseId: string,
  filePath: string,
  content: string,
  timestamp = '2026-03-01T10:00:00.000Z'
): object {
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

function lines(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join('\n')}\n`;
}

function metadataOnlyEditToolUse(toolUseId: string, filePath: string): object {
  return {
    timestamp: '2026-03-01T10:00:00.000Z',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Edit',
          input: {
            file_path: filePath,
            changes: [{ path: filePath, kind: 'update' }],
          },
        },
      ],
    },
  };
}

function metadataOnlyMultiFileEditToolUse(
  toolUseId: string,
  filePaths: string[],
  primaryPath = filePaths[0] ?? ''
): object {
  return metadataOnlyMultiFileEditChangesToolUse(
    toolUseId,
    filePaths.map((filePath) => ({ filePath, kind: 'add' })),
    primaryPath
  );
}

function metadataOnlyMultiFileEditChangesToolUse(
  toolUseId: string,
  changes: Array<{ filePath: string; kind?: string }>,
  primaryPath = changes[0]?.filePath ?? ''
): object {
  return {
    timestamp: '2026-03-01T10:00:00.000Z',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Edit',
          input: {
            file_path: primaryPath,
            changes: changes.map((change) => ({
              path: change.filePath,
              ...(change.kind ? { kind: change.kind } : {}),
            })),
          },
        },
      ],
    },
  };
}

function createNoLogTaskChangeComputer(): TaskChangeComputer {
  const logsFinder = {
    findLogFileRefsForTask: () => Promise.resolve([]),
  };
  const boundaryParser = {
    parseBoundaries: () =>
      Promise.resolve({
        boundaries: [],
        scopes: [],
        isSingleTaskSession: true,
        detectedMechanism: 'none' as const,
      }),
  };
  return new TaskChangeComputer(logsFinder as never, boundaryParser as never);
}

function createNoBoundaryTaskChangeComputer(
  logPath: string,
  options?: { maxSummaryJsonlParseBytes?: number }
): TaskChangeComputer {
  const logsFinder = {
    findLogFileRefsForTask: () => Promise.resolve([{ filePath: logPath, memberName: 'team-lead' }]),
  };
  const boundaryParser = {
    parseBoundaries: () =>
      Promise.resolve({
        boundaries: [],
        scopes: [],
        isSingleTaskSession: true,
        detectedMechanism: 'none' as const,
      }),
  };
  return new TaskChangeComputer(logsFinder as never, boundaryParser as never, options);
}

async function writeNoBoundaryTaskMentionLog(tmpDir: string, content: string): Promise<string> {
  const logPath = path.join(tmpDir, 'lead.jsonl');
  await writeJsonl(logPath, [
    {
      timestamp: '2026-03-01T10:00:00.000Z',
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    },
  ]);
  return logPath;
}

describe('TaskChangeComputer', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('keeps active tasks without logs quiet even when request status is stale', async () => {
    const computer = createNoLogTaskChangeComputer();

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: {
        status: 'in_progress',
        reviewState: 'none',
      },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(result.confidence).toBe('fallback');
    expect(result.warnings).toEqual([]);
  });

  it('omits raw tool payload text in summary mode while preserving line counts', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'lead-large-summary.jsonl');
    const largeContent =
      ['oom-retention-marker', ...Array.from({ length: 1000 }, (_, index) => `line-${index}`)].join(
        '\n'
      ) + '\n';
    await writeJsonl(logPath, [writeToolUse('tool-1', '/repo/src/large.ts', largeContent)]);

    const computer = createNoBoundaryTaskChangeComputer(logPath);
    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: { status: 'completed', reviewState: 'none' },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.relativePath).toBe('src/large.ts');
    expect(result.files[0]?.linesAdded).toBe(1001);
    expect(result.files[0]?.snippets).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('oom-retention-marker');
  });

  it('extracts summary metadata from oversized JSONL tool events without full parsing', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'lead-oversized-summary.jsonl');
    const oversizedContent = lines('line', 250);
    await writeJsonl(logPath, [
      writeToolUse('tool-oversized', '/repo/src/oversized.ts', oversizedContent),
    ]);

    const computer = createNoBoundaryTaskChangeComputer(logPath, {
      maxSummaryJsonlParseBytes: 256,
    });
    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: { status: 'completed', reviewState: 'none' },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.relativePath).toBe('src/oversized.ts');
    expect(result.files[0]?.linesAdded).toBe(250);
    expect(result.files[0]?.snippets).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('line-249');
  });

  it('keeps multiple oversized tool events in one assistant line separated in summary mode', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'lead-multi-oversized-summary.jsonl');
    await writeJsonl(logPath, [
      {
        timestamp: '2026-03-01T10:00:00.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-a',
              name: 'MultiEdit',
              input: {
                file_path: '/repo/src/a.ts',
                edits: [{ old_string: lines('old-a', 3), new_string: lines('new-a', 4) }],
              },
            },
            {
              type: 'tool_use',
              id: 'tool-b',
              name: 'MultiEdit',
              input: {
                file_path: '/repo/src/b.ts',
                edits: [{ old_string: lines('old-b', 50), new_string: lines('new-b', 60) }],
              },
            },
          ],
        },
      },
    ]);

    const computer = createNoBoundaryTaskChangeComputer(logPath, {
      maxSummaryJsonlParseBytes: 256,
    });
    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: { status: 'completed', reviewState: 'none' },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    const files = new Map(result.files.map((file) => [file.relativePath, file]));
    expect(files.get('src/a.ts')).toMatchObject({ linesAdded: 4, linesRemoved: 3 });
    expect(files.get('src/b.ts')).toMatchObject({ linesAdded: 60, linesRemoved: 50 });
    expect(result.files.every((file) => file.snippets.length === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('new-b-59');
  });

  it('marks oversized failed tool results without full parsing in summary mode', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'lead-oversized-error-summary.jsonl');
    await writeJsonl(logPath, [
      writeToolUse('tool-error', '/repo/src/failed.ts', lines('failed-write', 200)),
      {
        timestamp: '2026-03-01T10:00:01.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-error',
              is_error: true,
              content: lines('large-error-output', 200),
            },
          ],
        },
      },
    ]);

    const computer = createNoBoundaryTaskChangeComputer(logPath, {
      maxSummaryJsonlParseBytes: 256,
    });
    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: { status: 'completed', reviewState: 'none' },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('failed-write-199');
    expect(JSON.stringify(result)).not.toContain('large-error-output-199');
  });

  it('keeps newly created pending tasks without logs quiet', async () => {
    const computer = createNoLogTaskChangeComputer();

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: {
        status: 'pending',
        reviewState: 'none',
      },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(result.confidence).toBe('fallback');
    expect(result.warnings).toEqual([]);
  });

  it('keeps pending tasks quiet when related logs exist but no file edits were captured yet', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = await writeNoBoundaryTaskMentionLog(
      tmpDir,
      'Task task-1 was created and is waiting to start.'
    );
    const computer = createNoBoundaryTaskChangeComputer(logPath);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: {
        status: 'pending',
        reviewState: 'none',
      },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(result.confidence).toBe('fallback');
    expect(result.warnings).toEqual([]);
  });

  it('keeps in-progress related logs quiet when no boundaries or file edits were captured yet', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = await writeNoBoundaryTaskMentionLog(
      tmpDir,
      'Task task-1 is in progress and has not edited files yet.'
    );
    const computer = createNoBoundaryTaskChangeComputer(logPath);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: {
        status: 'in_progress',
        reviewState: 'none',
      },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(result.confidence).toBe('fallback');
    expect(result.warnings).toEqual([]);
  });

  it('keeps reopened needs-fix related logs quiet when no boundaries or file edits were captured', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = await writeNoBoundaryTaskMentionLog(
      tmpDir,
      'Task task-1 was reopened for fixes and is waiting for edits.'
    );

    const computer = createNoBoundaryTaskChangeComputer(logPath);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: {
        status: 'completed',
        reviewState: 'needsFix',
      },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(result.confidence).toBe('fallback');
    expect(result.warnings).toEqual([]);
  });

  it.each(noBoundaryTerminalCases)(
    'warns when $name related logs have no task boundaries or file edits',
    async ({ taskMeta }) => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
      const logPath = await writeNoBoundaryTaskMentionLog(
        tmpDir,
        'Task task-1 completed but no edit data was captured.'
      );

      const computer = createNoBoundaryTaskChangeComputer(logPath);

      const result = await computer.computeTaskChanges({
        teamName: 'team-a',
        taskId: 'task-1',
        taskMeta,
        effectiveOptions: { status: 'in_progress' },
        projectPath: '/repo',
        includeDetails: false,
      });

      expect(result.files).toEqual([]);
      expect(result.confidence).toBe('fallback');
      expect(result.warnings).toEqual([NO_TASK_BOUNDARIES_WARNING]);
    }
  );

  it('warns when completed tasks have no logs even when request status is stale', async () => {
    const computer = createNoLogTaskChangeComputer();

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: {
        status: 'completed',
        reviewState: 'none',
      },
      effectiveOptions: { status: 'in_progress' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(result.confidence).toBe('fallback');
    expect(result.warnings).toEqual(['No log files found for this task.']);
  });

  it('keeps reopened needs-fix tasks quiet even when their base status is completed', async () => {
    const computer = createNoLogTaskChangeComputer();

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: {
        status: 'completed',
        reviewState: 'needsFix',
      },
      effectiveOptions: { status: 'completed' },
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result.files).toEqual([]);
    expect(result.confidence).toBe('fallback');
    expect(result.warnings).toEqual([]);
  });

  it('shares concurrent JSONL parsing and invalidates when the file changes', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'agent.jsonl');
    await writeJsonl(logPath, [writeToolUse('tool-1', '/repo/src/a.ts', 'export const a = 1;\n')]);

    const logsFinder = {
      findLogFileRefsForTask: () => Promise.resolve([{ filePath: logPath, memberName: 'alice' }]),
    };
    const boundaryParser = {
      parseBoundaries: () =>
        Promise.resolve({
          boundaries: [],
          scopes: [],
          isSingleTaskSession: true,
          detectedMechanism: 'none' as const,
        }),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);
    const input = {
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: null,
      effectiveOptions: {},
      projectPath: '/repo',
      includeDetails: false,
    };

    const [first, second] = await Promise.all([
      computer.computeTaskChanges(input),
      computer.computeTaskChanges(input),
    ]);

    expect(first.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
    expect(first.warnings).toEqual([NO_TASK_BOUNDARIES_WARNING]);
    expect(second.files).toEqual(first.files);
    expect(second.warnings).toEqual([NO_TASK_BOUNDARIES_WARNING]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeJsonl(logPath, [
      writeToolUse('tool-1', '/repo/src/a.ts', 'export const a = 1;\n'),
      writeToolUse('tool-2', '/repo/src/b.ts', 'export const b = 2;\n'),
    ]);

    const afterChange = await computer.computeTaskChanges(input);
    expect(
      afterChange.files
        .map((file) => file.relativePath)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(['src/a.ts', 'src/b.ts']);
    expect(afterChange.warnings).toEqual([NO_TASK_BOUNDARIES_WARNING]);
  });

  it('does not pull unrelated log changes into a precise task scope with no file edits', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const leadLogPath = path.join(tmpDir, 'lead.jsonl');
    const memberLogPath = path.join(tmpDir, 'alice.jsonl');
    await writeJsonl(leadLogPath, [
      writeToolUse('lead-write', '/repo/src/unrelated.ts', 'export const unrelated = true;\n'),
    ]);
    await writeJsonl(memberLogPath, []);

    const logsFinder = {
      findLogFileRefsForTask: () =>
        Promise.resolve([
          { filePath: leadLogPath, memberName: 'team-lead' },
          { filePath: memberLogPath, memberName: 'alice' },
        ]),
    };
    const boundaryParser = {
      parseBoundaries: (filePath: string) =>
        Promise.resolve(
          filePath === memberLogPath
            ? {
                boundaries: [],
                scopes: [
                  {
                    taskId: 'task-1',
                    memberName: '',
                    startLine: 1,
                    endLine: 1,
                    startTimestamp: '2026-03-01T10:00:00.000Z',
                    endTimestamp: '2026-03-01T10:01:00.000Z',
                    toolUseIds: [],
                    filePaths: [],
                    confidence: { tier: 1, label: 'high', reason: 'Both markers found' },
                  },
                ],
                isSingleTaskSession: true,
                detectedMechanism: 'mcp' as const,
              }
            : {
                boundaries: [],
                scopes: [],
                isSingleTaskSession: true,
                detectedMechanism: 'none' as const,
              }
        ),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: null,
      effectiveOptions: {},
      projectPath: '/repo',
      includeDetails: true,
    });

    expect(result.files).toEqual([]);
    expect(result.totalFiles).toBe(0);
    expect(result.confidence).toBe('high');
  });

  it('prefers persisted workIntervals over low-confidence complete-only scopes', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'alice.jsonl');
    await writeJsonl(logPath, [
      writeToolUse(
        'outside-tool',
        '/repo/src/outside.ts',
        'export const outside = true;\n',
        '2026-03-01T09:55:00.000Z'
      ),
      writeToolUse(
        'inside-tool',
        '/repo/src/inside.ts',
        'export const inside = true;\n',
        '2026-03-01T10:05:00.000Z'
      ),
    ]);

    const logsFinder = {
      findLogFileRefsForTask: () => Promise.resolve([{ filePath: logPath, memberName: 'alice' }]),
    };
    const boundaryParser = {
      parseBoundaries: () =>
        Promise.resolve({
          boundaries: [],
          scopes: [
            {
              taskId: 'task-1',
              memberName: '',
              startLine: 1,
              endLine: 2,
              startTimestamp: '',
              endTimestamp: '2026-03-01T10:06:00.000Z',
              toolUseIds: ['outside-tool', 'inside-tool'],
              filePaths: ['/repo/src/outside.ts', '/repo/src/inside.ts'],
              confidence: {
                tier: 3,
                label: 'low',
                reason: 'Only complete marker found, start assumed at file beginning',
              },
            },
          ],
          isSingleTaskSession: true,
          detectedMechanism: 'mcp' as const,
        }),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: { owner: 'alice', status: 'completed' },
      effectiveOptions: {
        intervals: [
          {
            startedAt: '2026-03-01T10:00:00.000Z',
            completedAt: '2026-03-01T10:10:00.000Z',
          },
        ],
      },
      projectPath: '/repo',
      includeDetails: true,
    });

    expect(result.confidence).toBe('medium');
    expect(result.warnings).toEqual([
      'Task start boundary missing - scoped by persisted workIntervals timestamps.',
    ]);
    expect(result.files.map((file) => file.relativePath)).toEqual(['src/inside.ts']);
    expect(result.scope.toolUseIds).toEqual(['inside-tool']);
  });

  it('does not pull lead-session interval edits into a member complete-only scope', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const leadLogPath = path.join(tmpDir, 'lead.jsonl');
    const memberLogPath = path.join(tmpDir, 'alice.jsonl');
    await writeJsonl(leadLogPath, [
      writeToolUse(
        'lead-inside-tool',
        '/repo/src/lead.ts',
        'export const lead = true;\n',
        '2026-03-01T10:05:00.000Z'
      ),
    ]);
    await writeJsonl(memberLogPath, [
      writeToolUse(
        'member-inside-tool',
        '/repo/src/member.ts',
        'export const member = true;\n',
        '2026-03-01T10:06:00.000Z'
      ),
    ]);

    const logsFinder = {
      findLogFileRefsForTask: () =>
        Promise.resolve([
          { filePath: leadLogPath, memberName: 'team-lead' },
          { filePath: memberLogPath, memberName: 'alice' },
        ]),
    };
    const boundaryParser = {
      parseBoundaries: (filePath: string) =>
        Promise.resolve(
          filePath === memberLogPath
            ? {
                boundaries: [],
                scopes: [
                  {
                    taskId: 'task-1',
                    memberName: '',
                    startLine: 1,
                    endLine: 1,
                    startTimestamp: '',
                    endTimestamp: '2026-03-01T10:07:00.000Z',
                    toolUseIds: ['member-inside-tool'],
                    filePaths: ['/repo/src/member.ts'],
                    confidence: {
                      tier: 3,
                      label: 'low',
                      reason: 'Only complete marker found, start assumed at file beginning',
                    },
                  },
                ],
                isSingleTaskSession: true,
                detectedMechanism: 'mcp' as const,
              }
            : {
                boundaries: [],
                scopes: [],
                isSingleTaskSession: true,
                detectedMechanism: 'none' as const,
              }
        ),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: { owner: 'alice', status: 'completed' },
      effectiveOptions: {
        intervals: [
          {
            startedAt: '2026-03-01T10:00:00.000Z',
            completedAt: '2026-03-01T10:10:00.000Z',
          },
        ],
      },
      projectPath: '/repo',
      includeDetails: true,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual(['src/member.ts']);
    expect(result.scope.toolUseIds).toEqual(['member-inside-tool']);
  });

  it('keeps metadata-only synthetic Edit entries as file-change hints', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'agent.jsonl');
    await writeJsonl(logPath, [metadataOnlyEditToolUse('tool-1', '/repo/src/a.ts')]);

    const logsFinder = {
      findLogFileRefsForTask: () => Promise.resolve([{ filePath: logPath, memberName: 'alice' }]),
    };
    const boundaryParser = {
      parseBoundaries: () =>
        Promise.resolve({
          boundaries: [],
          scopes: [],
          isSingleTaskSession: true,
          detectedMechanism: 'none' as const,
        }),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: null,
      effectiveOptions: {},
      projectPath: '/repo',
      includeDetails: true,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
    expect(result.files[0]?.snippets).toHaveLength(1);
    expect(result.files[0]?.isNewFile).toBe(false);
    expect(result.files[0]?.snippets[0]?.type).toBe('edit');
    expect(result.files[0]?.snippets[0]?.oldString).toBe('');
    expect(result.files[0]?.snippets[0]?.newString).toBe('');
    expect(result.totalFiles).toBe(1);
  });

  it('expands metadata-only Edit changes arrays into all changed file hints', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'agent.jsonl');
    await writeJsonl(logPath, [
      metadataOnlyMultiFileEditToolUse('tool-1', ['/repo/dfdf/calc.js', '/repo/dfdf/style.css']),
    ]);

    const logsFinder = {
      findLogFileRefsForTask: () => Promise.resolve([{ filePath: logPath, memberName: 'tom' }]),
    };
    const boundaryParser = {
      parseBoundaries: () =>
        Promise.resolve({
          boundaries: [],
          scopes: [
            {
              taskId: 'task-1',
              memberName: '',
              startLine: 1,
              endLine: 1,
              startTimestamp: '2026-03-01T10:00:00.000Z',
              endTimestamp: '2026-03-01T10:01:00.000Z',
              toolUseIds: ['tool-1'],
              filePaths: ['/repo/dfdf/calc.js', '/repo/dfdf/style.css'],
              confidence: { tier: 1, label: 'high', reason: 'Both markers found' },
            },
          ],
          isSingleTaskSession: true,
          detectedMechanism: 'mcp' as const,
        }),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: null,
      effectiveOptions: {},
      projectPath: '/repo',
      includeDetails: true,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual([
      'dfdf/calc.js',
      'dfdf/style.css',
    ]);
    expect(result.files.every((file) => file.snippets[0]?.toolUseId === 'tool-1')).toBe(true);
    expect(result.files.every((file) => file.isNewFile)).toBe(true);
    expect(result.files.every((file) => file.snippets[0]?.type === 'write-new')).toBe(true);
    expect(result.files.every((file) => file.linesAdded === 0 && file.linesRemoved === 0)).toBe(
      true
    );
  });

  it('preserves metadata-only Edit change kinds without upgrading updates to new files', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'agent.jsonl');
    await writeJsonl(logPath, [
      metadataOnlyMultiFileEditChangesToolUse('tool-1', [
        { filePath: '/repo/src/new.ts', kind: 'add' },
        { filePath: '/repo/src/existing.ts', kind: 'update' },
      ]),
    ]);

    const logsFinder = {
      findLogFileRefsForTask: () => Promise.resolve([{ filePath: logPath, memberName: 'tom' }]),
    };
    const boundaryParser = {
      parseBoundaries: () =>
        Promise.resolve({
          boundaries: [],
          scopes: [],
          isSingleTaskSession: true,
          detectedMechanism: 'none' as const,
        }),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: null,
      effectiveOptions: {},
      projectPath: '/repo',
      includeDetails: true,
    });

    const filesByPath = new Map(result.files.map((file) => [file.relativePath, file]));
    const newFile = filesByPath.get('src/new.ts');
    const existingFile = filesByPath.get('src/existing.ts');

    expect(newFile?.isNewFile).toBe(true);
    expect(newFile?.snippets[0]?.type).toBe('write-new');
    expect(existingFile?.isNewFile).toBe(false);
    expect(existingFile?.snippets[0]?.type).toBe('edit');
  });

  it('does not include repeated tool ids from outside the scoped source lines', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-change-computer-'));
    const logPath = path.join(tmpDir, 'agent.jsonl');
    await writeJsonl(logPath, [
      metadataOnlyMultiFileEditToolUse('tool-1', ['/repo/index.html', '/repo/style.css']),
      metadataOnlyMultiFileEditToolUse(
        'tool-1',
        ['/repo/177/landing.css'],
        '/repo/177/landing.css'
      ),
    ]);

    const logsFinder = {
      findLogFileRefsForTask: () => Promise.resolve([{ filePath: logPath, memberName: 'tom' }]),
    };
    const boundaryParser = {
      parseBoundaries: () =>
        Promise.resolve({
          boundaries: [],
          scopes: [
            {
              taskId: 'task-1',
              memberName: '',
              startLine: 2,
              endLine: 2,
              startTimestamp: '2026-03-01T09:59:00.000Z',
              endTimestamp: '2026-03-01T10:01:00.000Z',
              toolUseIds: ['tool-1'],
              filePaths: ['/repo/177/landing.css'],
              confidence: { tier: 1, label: 'high', reason: 'Both markers found' },
            },
          ],
          isSingleTaskSession: true,
          detectedMechanism: 'mcp' as const,
        }),
    };
    const computer = new TaskChangeComputer(logsFinder as never, boundaryParser as never);

    const result = await computer.computeTaskChanges({
      teamName: 'team-a',
      taskId: 'task-1',
      taskMeta: null,
      effectiveOptions: {},
      projectPath: '/repo',
      includeDetails: true,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual(['177/landing.css']);
    expect(result.scope.filePaths).toEqual(['/repo/177/landing.css']);
  });
});
