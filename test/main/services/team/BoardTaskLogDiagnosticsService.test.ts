import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardTaskActivityRecordBuilder } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordBuilder';
import { BoardTaskActivityRecordSource } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordSource';
import { BoardTaskActivityTranscriptReader } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';
import { BoardTaskLogDiagnosticsService } from '../../../../src/main/services/team/taskLogs/diagnostics/BoardTaskLogDiagnosticsService';
import { BoardTaskLogStreamService } from '../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';

import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type { TeamTask } from '../../../../src/shared/types';

const TEAM_NAME = 'beacon-desk-2';
const TASK_ID = 'c414cd52-470a-4b51-ae1e-e5250fff95d7';
const ANNOTATED_REAL_FIXTURE_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/team/task-log-stream-annotated-real.jsonl',
);

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: TASK_ID,
    displayId: 'c414cd52',
    subject: 'Help alice: fast lint/link check',
    status: 'completed',
    workIntervals: [
      {
        startedAt: '2026-04-12T15:36:00.000Z',
        completedAt: '2026-04-12T15:40:00.000Z',
      },
    ],
    ...overrides,
  };
}

function createAssistantEntry(args: {
  uuid: string;
  timestamp: string;
  content: unknown[];
  agentName?: string;
  sessionId?: string;
  requestId?: string;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: args.uuid,
    timestamp: args.timestamp,
    sessionId: args.sessionId ?? 'session-tom',
    teamName: TEAM_NAME,
    agentName: args.agentName ?? 'tom',
    isSidechain: false,
    requestId: args.requestId,
    message: {
      id: `${args.uuid}-msg`,
      role: 'assistant',
      model: 'claude-test',
      type: 'message',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      content: args.content,
    },
  };
}

function createUserEntry(args: {
  uuid: string;
  timestamp: string;
  content: unknown[];
  boardTaskLinks?: unknown[];
  boardTaskToolActions?: unknown[];
  toolUseResult?: Record<string, unknown>;
  sourceToolAssistantUUID?: string;
  agentName?: string;
  sessionId?: string;
}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: args.uuid,
    timestamp: args.timestamp,
    sessionId: args.sessionId ?? 'session-tom',
    teamName: TEAM_NAME,
    agentName: args.agentName ?? 'tom',
    isSidechain: false,
    ...(args.boardTaskLinks ? { boardTaskLinks: args.boardTaskLinks } : {}),
    ...(args.boardTaskToolActions ? { boardTaskToolActions: args.boardTaskToolActions } : {}),
    ...(args.toolUseResult ? { toolUseResult: args.toolUseResult } : {}),
    ...(args.sourceToolAssistantUUID
      ? { sourceToolAssistantUUID: args.sourceToolAssistantUUID }
      : {}),
    message: {
      role: 'user',
      content: args.content,
    },
  };
}

describe('BoardTaskLogDiagnosticsService', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('explains when worker tools exist in transcript but only board MCP actions are explicit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-diagnostics-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    const task = createTask();

    const lines = [
      createAssistantEntry({
        uuid: 'a-task-start',
        timestamp: '2026-04-12T15:36:00.000Z',
        requestId: 'req-start',
        content: [
          {
            type: 'tool_use',
            id: 'call-task-start',
            name: 'mcp__agent-teams__task_start',
            input: {
              teamName: TEAM_NAME,
              taskId: TASK_ID,
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-task-start',
        timestamp: '2026-04-12T15:36:00.100Z',
        sourceToolAssistantUUID: 'a-task-start',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-task-start',
            content: 'ok',
          },
        ],
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'call-task-start',
            task: {
              ref: TASK_ID,
              refKind: 'canonical',
              canonicalId: TASK_ID,
            },
            targetRole: 'subject',
            linkKind: 'lifecycle',
            taskArgumentSlot: 'taskId',
            actorContext: {
              relation: 'idle',
            },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'call-task-start',
            canonicalToolName: 'task_start',
          },
        ],
        toolUseResult: {
          toolUseId: 'call-task-start',
          content: '{"id":"c414cd52"}',
        },
      }),
      createAssistantEntry({
        uuid: 'a-grep',
        timestamp: '2026-04-12T15:36:14.522Z',
        requestId: 'req-grep',
        content: [
          {
            type: 'tool_use',
            id: 'call-grep',
            name: 'Grep',
            input: {
              pattern: 'ITERATION_PLAN',
              path: 'docs-site',
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-grep',
        timestamp: '2026-04-12T15:36:14.749Z',
        sourceToolAssistantUUID: 'a-grep',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-grep',
            content: 'docs-site/guide.md:42: ITERATION_PLAN',
          },
        ],
        toolUseResult: {
          toolUseId: 'call-grep',
          content: 'docs-site/guide.md:42: ITERATION_PLAN',
        },
      }),
      createAssistantEntry({
        uuid: 'a-comment',
        timestamp: '2026-04-12T15:36:30.000Z',
        requestId: 'req-comment',
        content: [
          {
            type: 'tool_use',
            id: 'call-comment',
            name: 'mcp__agent-teams__task_add_comment',
            input: {
              teamName: TEAM_NAME,
              taskId: TASK_ID,
              text: 'Audit complete',
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-comment',
        timestamp: '2026-04-12T15:36:30.100Z',
        sourceToolAssistantUUID: 'a-comment',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-comment',
            content: '{"comment":{"text":"Audit complete"}}',
          },
        ],
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'call-comment',
            task: {
              ref: TASK_ID,
              refKind: 'canonical',
              canonicalId: TASK_ID,
            },
            targetRole: 'subject',
            linkKind: 'board_action',
            taskArgumentSlot: 'taskId',
            actorContext: {
              relation: 'same_task',
            },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'call-comment',
            canonicalToolName: 'task_add_comment',
            resultRefs: {
              commentId: 'comment-1',
            },
          },
        ],
        toolUseResult: {
          toolUseId: 'call-comment',
          content: '{"comment":{"text":"Audit complete"}}',
        },
      }),
    ];

    await writeFile(
      transcriptPath,
      lines.map((line) => JSON.stringify(line)).join('\n'),
      'utf8',
    );

    const taskReader = {
      getTasks: async () => [task],
      getDeletedTasks: async () => [] as TeamTask[],
    };
    const transcriptSourceLocator = {
      listTranscriptFiles: async () => [transcriptPath],
    };
    const recordSource = new BoardTaskActivityRecordSource(
      transcriptSourceLocator as never,
      taskReader as never,
      new BoardTaskActivityTranscriptReader(),
      new BoardTaskActivityRecordBuilder(),
    );
    const streamService = new BoardTaskLogStreamService(recordSource);
    const diagnosticsService = new BoardTaskLogDiagnosticsService(
      taskReader as never,
      transcriptSourceLocator as never,
      recordSource,
      undefined,
      streamService,
    );

    const report = await diagnosticsService.diagnose(TEAM_NAME, '#c414cd52');

    expect(report.explicitRecords.execution).toBe(0);
    expect(report.intervalToolResults.worker.total).toBe(1);
    expect(report.intervalToolResults.worker.explicitLinked).toBe(0);
    expect(report.intervalToolResults.worker.missingExplicit).toBe(1);
    expect(report.intervalToolResults.worker.examples).toContainEqual(
      expect.objectContaining({
        toolName: 'Grep',
        toolUseId: 'call-grep',
      }),
    );
    expect(report.stream.visibleToolNames).toEqual([
      'mcp__agent-teams__task_start',
      'mcp__agent-teams__task_add_comment',
    ]);
    expect(report.diagnosis.join(' ')).toContain('Only board MCP actions are explicit');
  });

  it('does not report missing explicit worker links for a real-format annotated transcript fixture', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-diagnostics-annotated-real-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    const fixtureText = await readFile(ANNOTATED_REAL_FIXTURE_PATH, 'utf8');
    await writeFile(transcriptPath, fixtureText, 'utf8');

    const task = createTask({
      workIntervals: undefined,
    });

    const taskReader = {
      getTasks: async () => [task],
      getDeletedTasks: async () => [] as TeamTask[],
    };
    const transcriptSourceLocator = {
      listTranscriptFiles: async () => [transcriptPath],
    };
    const recordSource = new BoardTaskActivityRecordSource(
      transcriptSourceLocator as never,
      taskReader as never,
      new BoardTaskActivityTranscriptReader(),
      new BoardTaskActivityRecordBuilder(),
    );
    const streamService = new BoardTaskLogStreamService(recordSource);
    const diagnosticsService = new BoardTaskLogDiagnosticsService(
      taskReader as never,
      transcriptSourceLocator as never,
      recordSource,
      undefined,
      streamService,
    );

    const report = await diagnosticsService.diagnose(TEAM_NAME, '#c414cd52');

    expect(report.explicitRecords.execution).toBeGreaterThan(0);
    expect(report.intervalToolResults.worker.missingExplicit).toBe(0);
    expect(report.stream.visibleToolNames).toContain('Bash');
    expect(report.stream.visibleToolNames).toContain('mcp__agent-teams__task_complete');
    expect(report.diagnosis.join(' ')).not.toContain('Only board MCP actions are explicit');
  });

  it('ignores non-record toolUseResult values when checking empty stream payloads', async () => {
    const task = createTask();
    const taskReader = {
      getTasks: async () => [task],
      getDeletedTasks: async () => [] as TeamTask[],
    };
    const transcriptSourceLocator = {
      listTranscriptFiles: async () => [] as string[],
    };
    const recordSource = {
      getTaskRecords: async () => [],
    };
    const strictParser = {
      parseFiles: async () => new Map(),
    };
    const streamService = {
      getTaskLogStream: async () => ({
        participants: [],
        defaultFilter: 'all' as const,
        segments: [
          {
            id: 'segment-1',
            participantKey: 'member:tom',
            actor: {
              memberName: 'tom',
              role: 'member' as const,
              sessionId: 'session-tom',
              isSidechain: false,
            },
            startTimestamp: '2026-04-12T15:36:00.000Z',
            endTimestamp: '2026-04-12T15:36:00.000Z',
            chunks: [
              {
                id: 'chunk-1',
                rawMessages: [
                  {
                    uuid: 'assistant-1',
                    parentUuid: null,
                    type: 'assistant',
                    timestamp: new Date('2026-04-12T15:36:00.000Z'),
                    role: 'assistant',
                    content: [
                      {
                        type: 'tool_use',
                        id: 'tool-1',
                        name: 'mcp__agent-teams__task_add_comment',
                        input: {},
                      },
                    ],
                    toolCalls: [
                      {
                        id: 'tool-1',
                        name: 'mcp__agent-teams__task_add_comment',
                        input: {},
                        isTask: false,
                      },
                    ],
                    toolResults: [],
                    isSidechain: false,
                    isMeta: false,
                    isCompactSummary: false,
                  },
                  {
                    uuid: 'user-1',
                    parentUuid: 'assistant-1',
                    type: 'user',
                    timestamp: new Date('2026-04-12T15:36:01.000Z'),
                    role: 'user',
                    content: [
                      {
                        type: 'tool_result',
                        tool_use_id: 'tool-1',
                        content: 'validation failed',
                        is_error: true,
                      },
                    ],
                    toolCalls: [],
                    toolResults: [
                      {
                        toolUseId: 'tool-1',
                        content: 'validation failed',
                        isError: true,
                      },
                    ],
                    sourceToolUseID: 'tool-1',
                    toolUseResult: new Error('validation failed'),
                    isSidechain: false,
                    isMeta: false,
                    isCompactSummary: false,
                  },
                ],
              },
            ],
          },
        ],
      }),
    };
    const diagnosticsService = new BoardTaskLogDiagnosticsService(
      taskReader as never,
      transcriptSourceLocator as never,
      recordSource as never,
      strictParser as never,
      streamService as never,
    );

    const report = await diagnosticsService.diagnose(TEAM_NAME, TASK_ID);

    expect(report.stream.emptyPayloadExamples).toEqual([]);
    expect(report.stream.visibleToolNames).toEqual(['mcp__agent-teams__task_add_comment']);
  });

  it('bounds diagnostics strict parsing to activity-record candidate files', async () => {
    const projectDir = path.join(tmpdir(), 'diagnostics-project');
    const rootFile = path.join(projectDir, 'session-tom.jsonl');
    const subagentFile = path.join(projectDir, 'session-tom', 'subagents', 'agent-work.jsonl');
    const unrelatedFile = path.join(projectDir, 'session-alice.jsonl');
    const task = createTask({ owner: 'tom' });
    const record: BoardTaskActivityRecord = {
      id: 'record-comment',
      timestamp: '2026-04-12T15:36:00.000Z',
      task: {
        locator: { ref: 'c414cd52', refKind: 'display', canonicalId: TASK_ID },
        resolution: 'resolved',
      },
      linkKind: 'board_action',
      targetRole: 'subject',
      actor: {
        memberName: 'tom',
        role: 'member',
        sessionId: 'session-tom',
        isSidechain: false,
      },
      actorContext: { relation: 'same_task' },
      action: {
        canonicalToolName: 'task_add_comment',
        toolUseId: 'tool-comment',
        category: 'comment',
      },
      source: {
        filePath: rootFile,
        messageUuid: 'message-comment',
        toolUseId: 'tool-comment',
        sourceOrder: 1,
      },
    };
    const strictParser = {
      parseFiles: async (filePaths: string[]) =>
        new Map(filePaths.map((filePath) => [filePath, []])),
    };
    const parseSpy = vi.spyOn(strictParser, 'parseFiles');
    const diagnosticsService = new BoardTaskLogDiagnosticsService(
      {
        getTasks: async () => [task],
        getDeletedTasks: async () => [] as TeamTask[],
      } as never,
      {
        getContext: async () => ({
          projectDir,
          transcriptFiles: [rootFile, subagentFile, unrelatedFile],
        }),
      } as never,
      {
        getTaskRecords: async () => [record],
      } as never,
      strictParser as never,
      {
        getTaskLogStream: async () => ({
          participants: [],
          defaultFilter: 'all' as const,
          segments: [],
        }),
      } as never,
    );

    const report = await diagnosticsService.diagnose(TEAM_NAME, TASK_ID);

    expect(parseSpy).toHaveBeenCalledWith([rootFile, subagentFile]);
    expect(parseSpy.mock.calls.flatMap((call) => call[0] as string[])).not.toContain(
      unrelatedFile,
    );
    expect(report.transcript.parsedFileCount).toBe(2);
    expect(report.transcript.candidateSelection).toMatchObject({
      mode: 'activity_records',
      candidateFileCount: 2,
    });
  });

  it('bounds diagnostics historical recovery parsing to raw-probe hit files', async () => {
    const task = createTask({ owner: 'tom' });
    const hitFile = path.join(tmpdir(), 'diagnostics-historical-hit.jsonl');
    const unrelatedFile = path.join(tmpdir(), 'diagnostics-historical-unrelated.jsonl');
    const strictParser = {
      parseFiles: async (filePaths: string[]) =>
        new Map(filePaths.map((filePath) => [filePath, []])),
    };
    const parseSpy = vi.spyOn(strictParser, 'parseFiles');
    const rawProbe = {
      findCandidateFiles: async () => ({
        filePaths: [hitFile],
        scannedFileCount: 2,
        hitCount: 1,
        elapsedMs: 0,
      }),
    };
    const diagnosticsService = new BoardTaskLogDiagnosticsService(
      {
        getTasks: async () => [task],
        getDeletedTasks: async () => [] as TeamTask[],
      } as never,
      {
        getContext: async () => ({
          projectDir: tmpdir(),
          transcriptFiles: [hitFile, unrelatedFile],
        }),
      } as never,
      {
        getTaskRecords: async () => [],
      } as never,
      strictParser as never,
      {
        getTaskLogStream: async () => ({
          participants: [],
          defaultFilter: 'all' as const,
          segments: [],
        }),
      } as never,
      undefined,
      rawProbe as never,
    );

    const report = await diagnosticsService.diagnose(TEAM_NAME, TASK_ID);

    expect(parseSpy).toHaveBeenCalledWith([hitFile]);
    expect(parseSpy.mock.calls.flatMap((call) => call[0] as string[])).not.toContain(
      unrelatedFile,
    );
    expect(report.transcript.candidateSelection).toMatchObject({
      mode: 'historical_raw_probe',
      candidateFileCount: 1,
      rawProbeScannedFileCount: 2,
      rawProbeHitCount: 1,
    });
  });
});
