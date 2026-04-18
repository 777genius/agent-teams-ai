import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardTaskLogStreamService } from '../../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';
import { BoardTaskActivityRecordBuilder } from '../../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordBuilder';
import { BoardTaskActivityTranscriptReader } from '../../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { TeamTask } from '../../../../../src/shared/types';

const TEAM_NAME = 'beacon-desk-2';
const TASK_ID = 'c414cd52-470a-4b51-ae1e-e5250fff95d7';
const REAL_FIXTURE_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/team/task-log-stream-fallback-real.jsonl',
);

const apiState = {
  getTaskLogStream: vi.fn(),
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskLogStream: (...args: Parameters<typeof apiState.getTaskLogStream>) =>
        apiState.getTaskLogStream(...args),
    },
  },
}));

import { TaskLogStreamSection } from '@renderer/components/team/taskLogs/TaskLogStreamSection';

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

async function buildStreamResponse(transcriptPath: string, task: TeamTask = createTask()) {
  const transcriptReader = new BoardTaskActivityTranscriptReader();
  const recordBuilder = new BoardTaskActivityRecordBuilder();
  const messages = await transcriptReader.readFiles([transcriptPath]);
  const recordSource = {
    getTaskRecords: async () =>
      recordBuilder.buildForTask({
        teamName: TEAM_NAME,
        targetTask: task,
        tasks: [task],
        messages,
      }),
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
  return service.getTaskLogStream(TEAM_NAME, task.id);
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe('TaskLogStreamSection integration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    document.body.innerHTML = '';
    apiState.getTaskLogStream.mockReset();
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('renders worker tools and does not show empty array output blocks', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-stream-render-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');

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
      createAssistantEntry({
        uuid: 'a-comment',
        timestamp: '2026-04-12T15:47:44.500Z',
        requestId: 'req-comment',
        content: [
          {
            type: 'tool_use',
            id: 'call-comment',
            name: 'mcp__agent-teams__task_add_comment',
            input: {
              taskId: TASK_ID,
              text: 'Audit complete',
            },
          },
        ],
      }),
      createUserEntry({
        uuid: 'u-comment',
        timestamp: '2026-04-12T15:47:44.773Z',
        sourceToolAssistantUUID: 'a-comment',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-comment',
            content: [
              {
                type: 'text',
                text: '{\n  "commentId": "comment-1",\n  "comment": {\n    "text": "Audit complete"\n  }\n}',
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
            text: '{\n  "commentId": "comment-1",\n  "comment": {\n    "text": "Audit complete"\n  }\n}',
          },
        ],
      }),
    ];

    await writeFile(
      transcriptPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    apiState.getTaskLogStream.mockResolvedValueOnce(await buildStreamResponse(transcriptPath));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TaskLogStreamSection, { teamName: TEAM_NAME, taskId: TASK_ID }),
        ),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const text = host.textContent ?? '';
    expect(text).toContain('Task Log Stream');
    expect(text).toContain('Grep');
    expect(text).toContain('Edit');
    expect(text).toContain('Claude');
    expect(text).toContain('3 tool calls');
    expect(text).not.toContain('[]');
    expect(text).not.toContain('Audit complete');
    expect(text).not.toContain('lead session');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('does not render empty board lifecycle payload blocks for task_start/task_complete', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-stream-board-lifecycle-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');

    const lines = [
      createAssistantEntry({
        uuid: 'a-start',
        timestamp: '2026-04-12T18:25:04.000Z',
        requestId: 'req-start',
        content: [
          {
            type: 'tool_use',
            id: 'call-start',
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
        timestamp: '2026-04-12T18:25:04.039Z',
        sourceToolAssistantUUID: 'a-start',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-start',
            content: '',
          },
        ],
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'call-start',
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
            toolUseId: 'call-start',
            canonicalToolName: 'task_start',
          },
        ],
        toolUseResult: {
          toolUseId: 'call-start',
          content: '',
        },
      }),
      createAssistantEntry({
        uuid: 'a-complete',
        timestamp: '2026-04-12T18:27:04.000Z',
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
        timestamp: '2026-04-12T18:27:04.039Z',
        sourceToolAssistantUUID: 'a-complete',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-complete',
            content: '',
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
          content: '',
        },
      }),
    ];

    await writeFile(
      transcriptPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    apiState.getTaskLogStream.mockResolvedValueOnce(await buildStreamResponse(transcriptPath));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TaskLogStreamSection, { teamName: TEAM_NAME, taskId: TASK_ID }),
        ),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const text = host.textContent ?? '';
    expect(text).toContain('Task Log Stream');
    expect(text).toContain('mcp__agent-teams__task_start');
    expect(text).toContain('mcp__agent-teams__task_complete');
    expect(text).not.toContain('[]');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('renders fallback worker logs from a real-format transcript fixture and hides unrelated participant logs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const dir = await mkdtemp(path.join(tmpdir(), 'task-log-stream-render-real-'));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    const fixtureText = await readFile(REAL_FIXTURE_PATH, 'utf8');
    await writeFile(transcriptPath, fixtureText, 'utf8');

    apiState.getTaskLogStream.mockResolvedValueOnce(
      await buildStreamResponse(
        transcriptPath,
        createTask({
          owner: 'tom',
          workIntervals: [
            {
              startedAt: '2026-04-12T15:36:00.000Z',
              completedAt: '2026-04-12T15:40:00.000Z',
            },
          ],
        }),
      ),
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TaskLogStreamSection, { teamName: TEAM_NAME, taskId: TASK_ID }),
        ),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const text = host.textContent ?? '';
    expect(text).toContain('Task Log Stream');
    expect(text).toContain('Bash');
    expect(text).toContain('Run targeted tests');
    expect(text).not.toContain('echo alien');
    expect(text).not.toContain('alice');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
