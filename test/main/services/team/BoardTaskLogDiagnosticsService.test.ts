import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { BoardTaskActivityRecordBuilder } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordBuilder';
import { BoardTaskActivityRecordSource } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordSource';
import { BoardTaskActivityTranscriptReader } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';
import { BoardTaskLogDiagnosticsService } from '../../../../src/main/services/team/taskLogs/diagnostics/BoardTaskLogDiagnosticsService';
import { BoardTaskLogStreamService } from '../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';

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
});
