import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { BoardTaskLogStreamService } from '../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';
import { BoardTaskActivityRecordBuilder } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordBuilder';
import { BoardTaskActivityTranscriptReader } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';

import type { ParsedMessage } from '../../../../src/main/types';
import type { TeamTask } from '../../../../src/shared/types';

const TEAM_NAME = 'beacon-desk-2';
const TASK_ID = 'c414cd52-470a-4b51-ae1e-e5250fff95d7';
const REAL_FIXTURE_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/team/task-log-stream-fallback-real.jsonl',
);

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: TASK_ID,
    displayId: 'c414cd52',
    subject: 'Help alice: fast lint/link check',
    status: 'completed',
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
  toolUseResult?: unknown;
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

async function buildRecordsFromTranscript(filePath: string, task: TeamTask) {
  const transcriptReader = new BoardTaskActivityTranscriptReader();
  const recordBuilder = new BoardTaskActivityRecordBuilder();
  const messages = await transcriptReader.readFiles([filePath]);

  return recordBuilder.buildForTask({
    teamName: TEAM_NAME,
    targetTask: task,
    tasks: [task],
    messages,
  });
}

function flattenRawMessages(response: Awaited<ReturnType<BoardTaskLogStreamService['getTaskLogStream']>>): ParsedMessage[] {
  return response.segments.flatMap((segment) =>
    segment.chunks.flatMap((chunk) => chunk.rawMessages),
  );
}

describe('BoardTaskLogStreamService integration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('includes worker tool logs when transcript rows carry execution links with toolUseId', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-stream-integration-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    const task = createTask();

    const lines = [
      createUserEntry({
        uuid: 'u-start',
        timestamp: '2026-04-12T15:36:07.747Z',
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
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'call-grep',
            task: {
              ref: TASK_ID,
              refKind: 'canonical',
              canonicalId: TASK_ID,
            },
            targetRole: 'subject',
            linkKind: 'execution',
            actorContext: {
              relation: 'same_task',
            },
          },
        ],
        toolUseResult: {
          toolUseId: 'call-grep',
          content: 'docs-site/guide.md:42: ITERATION_PLAN',
        },
      }),
      createAssistantEntry({
        uuid: 'a-edit',
        timestamp: '2026-04-12T15:36:40.000Z',
        requestId: 'req-edit',
        content: [
          {
            type: 'tool_use',
            id: 'call-edit',
            name: 'Edit',
            input: {
              file_path: 'docs-site/guide.md',
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-edit',
        timestamp: '2026-04-12T15:36:40.200Z',
        sourceToolAssistantUUID: 'a-edit',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-edit',
            content: 'File updated',
          },
        ],
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'call-edit',
            task: {
              ref: TASK_ID,
              refKind: 'canonical',
              canonicalId: TASK_ID,
            },
            targetRole: 'subject',
            linkKind: 'execution',
            actorContext: {
              relation: 'same_task',
            },
          },
        ],
        toolUseResult: {
          toolUseId: 'call-edit',
          content: 'File updated',
        },
      }),
    ];

    await writeFile(
      transcriptPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const recordSource = {
      getTaskRecords: async () => buildRecordsFromTranscript(transcriptPath, task),
    };

    const service = new BoardTaskLogStreamService(recordSource as never);
    const response = await service.getTaskLogStream(TEAM_NAME, task.id);
    const rawMessages = flattenRawMessages(response);
    const toolNames = rawMessages.flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name),
    );

    expect(response.participants.map((participant) => participant.label)).toEqual(['tom']);
    expect(response.defaultFilter).toBe('member:tom');
    expect(response.segments).toHaveLength(1);
    expect(toolNames).toContain('Grep');
    expect(toolNames).toContain('Edit');
  });

  it('does not leak empty array board-tool payloads into the task log stream', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-stream-board-tool-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    const task = createTask();

    const lines = [
      createAssistantEntry({
        uuid: 'a-comment',
        timestamp: '2026-04-12T18:35:02.000Z',
        requestId: 'req-comment',
        content: [
          {
            type: 'tool_use',
            id: 'call-comment',
            name: 'mcp__agent-teams__task_add_comment',
            input: {
              taskId: TASK_ID,
              text: 'Done',
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-comment',
        timestamp: '2026-04-12T18:35:02.064Z',
        sourceToolAssistantUUID: 'a-comment',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-comment',
            content: [
              {
                type: 'text',
                text: '{\n  "commentId": "comment-1",\n  "task": {\n    "id": "c414cd52-470a-4b51-ae1e-e5250fff95d7"\n  }\n}',
              },
            ],
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
        toolUseResult: [
          {
            type: 'text',
            text: '{\n  "commentId": "comment-1",\n  "task": {\n    "id": "c414cd52-470a-4b51-ae1e-e5250fff95d7"\n  }\n}',
          },
        ],
      }),
    ];

    await writeFile(
      transcriptPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const recordSource = {
      getTaskRecords: async () => buildRecordsFromTranscript(transcriptPath, task),
    };

    const service = new BoardTaskLogStreamService(recordSource as never);
    const response = await service.getTaskLogStream(TEAM_NAME, task.id);
    const rawMessages = flattenRawMessages(response);
    const commentResult = rawMessages.find((message) => message.uuid === 'u-comment');

    expect(response.segments).toHaveLength(1);
    expect(commentResult).toBeUndefined();
  });

  it('falls back to task time-window worker logs when explicit execution links are missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-stream-inferred-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    const task = createTask({
      owner: 'tom',
      workIntervals: [
        {
          startedAt: '2026-04-12T15:36:00.000Z',
          completedAt: '2026-04-12T15:40:00.000Z',
        },
      ],
    });

    const lines = [
      createAssistantEntry({
        uuid: 'a-start',
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
        uuid: 'u-start',
        timestamp: '2026-04-12T15:36:00.120Z',
        sourceToolAssistantUUID: 'a-start',
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
        uuid: 'a-bash',
        timestamp: '2026-04-12T15:36:14.000Z',
        requestId: 'req-bash',
        content: [
          {
            type: 'tool_use',
            id: 'call-bash',
            name: 'Bash',
            input: {
              command: 'pnpm test',
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-bash',
        timestamp: '2026-04-12T15:36:14.300Z',
        sourceToolAssistantUUID: 'a-bash',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-bash',
            content: 'tests ok',
          },
        ],
        toolUseResult: {
          toolUseId: 'call-bash',
          content: 'tests ok',
        },
      }),
      createAssistantEntry({
        uuid: 'a-complete',
        timestamp: '2026-04-12T15:36:30.000Z',
        requestId: 'req-complete',
        content: [
          {
            type: 'tool_use',
            id: 'call-complete',
            name: 'mcp__agent-teams__task_complete',
            input: {
              teamName: TEAM_NAME,
              taskId: TASK_ID,
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-complete',
        timestamp: '2026-04-12T15:36:30.150Z',
        sourceToolAssistantUUID: 'a-complete',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-complete',
            content: 'ok',
          },
        ],
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'call-complete',
            task: {
              ref: TASK_ID,
              refKind: 'canonical',
              canonicalId: TASK_ID,
            },
            targetRole: 'subject',
            linkKind: 'lifecycle',
            taskArgumentSlot: 'taskId',
            actorContext: {
              relation: 'same_task',
            },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'call-complete',
            canonicalToolName: 'task_complete',
          },
        ],
        toolUseResult: {
          toolUseId: 'call-complete',
          content: '{"id":"c414cd52"}',
        },
      }),
    ];

    await writeFile(
      transcriptPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const recordSource = {
      getTaskRecords: async () => buildRecordsFromTranscript(transcriptPath, task),
    };
    const taskReader = {
      getTasks: async () => [task],
      getDeletedTasks: async () => [] as TeamTask[],
    };
    const transcriptSourceLocator = {
      getContext: async () =>
        ({
          transcriptFiles: [transcriptPath],
          config: {
            members: [{ name: 'team-lead', agentType: 'team-lead' }],
          },
        }) as never,
    };

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      taskReader as never,
      transcriptSourceLocator as never,
    );
    const response = await service.getTaskLogStream(TEAM_NAME, task.id);
    const rawMessages = flattenRawMessages(response);
    const toolNames = rawMessages.flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name),
    );

    expect(response.participants.map((participant) => participant.label)).toEqual(['tom']);
    expect(response.defaultFilter).toBe('member:tom');
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('mcp__agent-teams__task_complete');
  });

  it('reads a real-format transcript fixture and surfaces fallback worker logs for the task owner only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-stream-real-fixture-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    const fixtureText = await readFile(REAL_FIXTURE_PATH, 'utf8');
    await writeFile(transcriptPath, fixtureText, 'utf8');

    const task = createTask({
      owner: 'tom',
      workIntervals: [
        {
          startedAt: '2026-04-12T15:36:00.000Z',
          completedAt: '2026-04-12T15:40:00.000Z',
        },
      ],
    });

    const recordSource = {
      getTaskRecords: async () => buildRecordsFromTranscript(transcriptPath, task),
    };
    const taskReader = {
      getTasks: async () => [task],
      getDeletedTasks: async () => [] as TeamTask[],
    };
    const transcriptSourceLocator = {
      getContext: async () =>
        ({
          transcriptFiles: [transcriptPath],
          config: {
            members: [{ name: 'team-lead', agentType: 'team-lead' }],
          },
        }) as never,
    };

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      taskReader as never,
      transcriptSourceLocator as never,
    );
    const response = await service.getTaskLogStream(TEAM_NAME, task.id);
    const rawMessages = flattenRawMessages(response);
    const bashCommands = rawMessages.flatMap((message) =>
      message.toolCalls
        .filter((toolCall) => toolCall.name === 'Bash')
        .map((toolCall) => String(toolCall.input.command ?? '')),
    );

    expect(response.participants.map((participant) => participant.label)).toEqual(['tom']);
    expect(response.defaultFilter).toBe('member:tom');
    expect(bashCommands).toContain('pnpm test --filter signal-ops');
    expect(bashCommands).not.toContain('echo alien');
    expect(rawMessages.some((message) => message.uuid === 'u-bash-alice-real')).toBe(false);
  });
});
