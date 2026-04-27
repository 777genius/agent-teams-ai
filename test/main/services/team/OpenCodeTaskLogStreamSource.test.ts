import { describe, expect, it, vi } from 'vitest';

import { OpenCodeTaskLogStreamSource } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource';

import type { TeamTask } from '../../../../src/shared/types';
import type { OpenCodeRuntimeTranscriptLogMessage } from '../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { OpenCodeTaskLogAttributionRecord } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionStore';

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-a',
    displayId: 'task-a',
    subject: 'Investigate failing command',
    owner: 'alice',
    status: 'in_progress',
    createdAt: '2026-04-21T09:59:00.000Z',
    updatedAt: '2026-04-21T10:10:00.000Z',
    workIntervals: [
      {
        startedAt: '2026-04-21T10:00:00.000Z',
        completedAt: '2026-04-21T10:10:00.000Z',
      },
    ],
    ...overrides,
  };
}

function textLogMessage(
  overrides: Pick<OpenCodeRuntimeTranscriptLogMessage, 'uuid' | 'timestamp'> &
    Partial<OpenCodeRuntimeTranscriptLogMessage>
): OpenCodeRuntimeTranscriptLogMessage {
  const type = overrides.type ?? 'assistant';
  return {
    uuid: overrides.uuid,
    parentUuid: overrides.parentUuid ?? null,
    type,
    timestamp: overrides.timestamp,
    role: overrides.role ?? type,
    content: overrides.content ?? [{ type: 'text', text: overrides.uuid }],
    isMeta: overrides.isMeta ?? false,
    sessionId: overrides.sessionId ?? 'session-opencode',
    toolCalls: overrides.toolCalls ?? [],
    toolResults: overrides.toolResults ?? [],
    ...(overrides.sourceToolUseID ? { sourceToolUseID: overrides.sourceToolUseID } : {}),
    ...(overrides.sourceToolAssistantUUID
      ? { sourceToolAssistantUUID: overrides.sourceToolAssistantUUID }
      : {}),
  };
}

function taskMarkerLogMessage({
  uuid,
  parentUuid = null,
  timestamp,
  toolName,
  input,
}: {
  uuid: string;
  parentUuid?: string | null;
  timestamp: string;
  toolName: string;
  input: Record<string, unknown>;
}): OpenCodeRuntimeTranscriptLogMessage {
  const toolId = `${uuid}-tool`;
  return textLogMessage({
    uuid,
    parentUuid,
    timestamp,
    content: [
      {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input,
      },
    ],
    toolCalls: [
      {
        id: toolId,
        name: toolName,
        input,
        isTask: false,
      },
    ],
  });
}

function toolResultLogMessage({
  uuid,
  parentUuid,
  timestamp,
  sourceToolAssistantUUID,
}: {
  uuid: string;
  parentUuid: string;
  timestamp: string;
  sourceToolAssistantUUID: string;
}): OpenCodeRuntimeTranscriptLogMessage {
  const toolUseId = `${sourceToolAssistantUUID}-tool`;
  return textLogMessage({
    uuid,
    parentUuid,
    type: 'user',
    role: 'user',
    timestamp,
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'ok',
      },
    ],
    isMeta: true,
    toolResults: [
      {
        toolUseId,
        content: 'ok',
        isError: false,
      },
    ],
    sourceToolUseID: toolUseId,
    sourceToolAssistantUUID,
  });
}

describe('OpenCodeTaskLogStreamSource', () => {
  it('projects OpenCode runtime logs into a task stream segment and caches repeated reads', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            {
              uuid: 'assistant-1',
              parentUuid: 'user-1',
              type: 'assistant',
              timestamp: '2026-04-21T10:05:00.000Z',
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'Inspecting repository', signature: 'opencode' },
                { type: 'text', text: 'Running the check now.' },
                {
                  type: 'tool_use',
                  id: 'tool-1',
                  name: 'bash',
                  input: { command: 'npm test' },
                },
              ],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [
                {
                  id: 'tool-1',
                  name: 'bash',
                  input: { command: 'npm test' },
                  isTask: false,
                },
              ],
              toolResults: [],
            },
            {
              uuid: 'assistant-1::tool_results',
              parentUuid: 'assistant-1',
              type: 'user',
              timestamp: '2026-04-21T10:05:03.000Z',
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  content: 'ok',
                },
              ],
              isMeta: true,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [
                {
                  toolUseId: 'tool-1',
                  content: 'ok',
                  isError: false,
                },
              ],
              sourceToolUseID: 'tool-1',
              sourceToolAssistantUUID: 'assistant-1',
            },
            {
              uuid: 'assistant-outside-window',
              parentUuid: 'user-2',
              type: 'assistant',
              timestamp: '2026-04-21T08:00:00.000Z',
              role: 'assistant',
              content: [{ type: 'text', text: 'Old task output' }],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [],
            },
          ],
        },
      })),
    };

    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-1',
          kind: 'assistant',
          messages,
        },
      ]),
    };

    const taskReader = {
      getTasks: vi.fn(async () => [createTask()]),
      getDeletedTasks: vi.fn(async () => []),
    };

    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      taskReader as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const first = await source.getTaskLogStream('team-a', 'task-a');
    const second = await source.getTaskLogStream('team-a', 'task-a');

    expect(first?.source).toBe('opencode_runtime_fallback');
    expect(first?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 2,
      boardMcpToolCount: 0,
      nativeToolCount: 1,
      fallbackReason: 'no_attribution_records',
    });
    expect(first?.participants).toEqual([
      {
        key: 'member:alice',
        label: 'alice',
        role: 'member',
        isLead: false,
        isSidechain: true,
      },
    ]);
    expect(first?.segments).toHaveLength(1);
    expect(first?.segments[0]?.actor).toEqual({
      memberName: 'alice',
      role: 'member',
      sessionId: 'session-opencode',
      isSidechain: true,
    });
    expect(chunkBuilder.buildBundleChunks).toHaveBeenCalledTimes(1);
    expect(chunkBuilder.buildBundleChunks.mock.calls[0]?.[0]).toHaveLength(2);
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual(['assistant-1', 'assistant-1::tool_results']);
    expect(bridge.getOpenCodeTranscript).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('sanitizes OpenCode delivery retry envelopes from projected task log text', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            textLogMessage({
              uuid: 'task-delivery',
              type: 'user',
              role: 'user',
              timestamp: '2026-04-21T10:05:00.000Z',
              content: [
                {
                  type: 'text',
                  text: [
                    '<opencode_inbound_app_message>',
                    '<opencode_delivery_retry>',
                    'This is retry attempt 3/3 for inbound app messageId "message-1".',
                    '</opencode_delivery_retry>',
                    '',
                    'New task assigned to you: #task-a Investigate failing command',
                    '</opencode_inbound_app_message>',
                  ].join('\n'),
                },
              ],
            }),
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-sanitized',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask()],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.source).toBe('opencode_runtime_fallback');
    const projectedMessage = chunkBuilder.buildBundleChunks.mock.calls[0]?.[0]?.[0] as
      | { content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(projectedMessage?.content).toEqual([
      {
        type: 'text',
        text: 'New task assigned to you: #task-a Investigate failing command',
      },
    ]);
  });

  it('returns null when the task has no owner', async () => {
    const source = new OpenCodeTaskLogStreamSource(
      { getOpenCodeTranscript: vi.fn() } as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask({ owner: undefined })],
        getDeletedTasks: async () => [],
      } as never,
      { buildBundleChunks: vi.fn() } as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    await expect(source.getTaskLogStream('team-a', 'task-a')).resolves.toBeNull();
  });

  it('narrows owner fallback to OpenCode task tool marker ranges when available', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            {
              uuid: 'unrelated-before',
              parentUuid: undefined,
              type: 'assistant',
              timestamp: '2026-04-21T10:01:00.000Z',
              role: 'assistant',
              content: [{ type: 'text', text: 'Other work before the task marker' }],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [],
            },
            {
              uuid: 'user-task-prompt',
              parentUuid: undefined,
              type: 'user',
              timestamp: '2026-04-21T10:02:00.000Z',
              role: 'user',
              content: [{ type: 'text', text: 'Start task-a now' }],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [],
            },
            {
              uuid: 'assistant-start',
              parentUuid: 'user-task-prompt',
              type: 'assistant',
              timestamp: '2026-04-21T10:03:00.000Z',
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-start',
                  name: 'mcp__agent-teams__task_start',
                  input: { teamName: 'team-a', taskId: 'task-a' },
                },
              ],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [
                {
                  id: 'tool-start',
                  name: 'mcp__agent-teams__task_start',
                  input: { teamName: 'team-a', taskId: 'task-a' },
                  isTask: false,
                },
              ],
              toolResults: [],
            },
            {
              uuid: 'assistant-start::tool_results',
              parentUuid: 'assistant-start',
              type: 'user',
              timestamp: '2026-04-21T10:03:01.000Z',
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-start',
                  content: 'started',
                },
              ],
              isMeta: true,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [
                {
                  toolUseId: 'tool-start',
                  content: 'started',
                  isError: false,
                },
              ],
              sourceToolUseID: 'tool-start',
              sourceToolAssistantUUID: 'assistant-start',
            },
            {
              uuid: 'assistant-work',
              parentUuid: 'assistant-start::tool_results',
              type: 'assistant',
              timestamp: '2026-04-21T10:04:00.000Z',
              role: 'assistant',
              content: [{ type: 'text', text: 'Doing the actual work' }],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [],
            },
            {
              uuid: 'assistant-complete',
              parentUuid: 'assistant-work',
              type: 'assistant',
              timestamp: '2026-04-21T10:06:00.000Z',
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-complete',
                  name: 'mcp__agent-teams__task_complete',
                  input: { teamName: 'team-a', taskId: 'task-a' },
                },
              ],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [
                {
                  id: 'tool-complete',
                  name: 'mcp__agent-teams__task_complete',
                  input: { teamName: 'team-a', taskId: 'task-a' },
                  isTask: false,
                },
              ],
              toolResults: [],
            },
            {
              uuid: 'assistant-complete::tool_results',
              parentUuid: 'assistant-complete',
              type: 'user',
              timestamp: '2026-04-21T10:06:01.000Z',
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-complete',
                  content: 'completed',
                },
              ],
              isMeta: true,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [
                {
                  toolUseId: 'tool-complete',
                  content: 'completed',
                  isError: false,
                },
              ],
              sourceToolUseID: 'tool-complete',
              sourceToolAssistantUUID: 'assistant-complete',
            },
            {
              uuid: 'unrelated-after',
              parentUuid: 'assistant-complete::tool_results',
              type: 'assistant',
              timestamp: '2026-04-21T10:07:00.000Z',
              role: 'assistant',
              content: [{ type: 'text', text: 'Other work after task completion' }],
              isMeta: false,
              sessionId: 'session-opencode',
              toolCalls: [],
              toolResults: [],
            },
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-marker',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask()],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.source).toBe('opencode_runtime_fallback');
    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 6,
      boardMcpToolCount: 2,
      nativeToolCount: 0,
      fallbackReason: 'task_tool_markers',
      markerMatchCount: 2,
      markerSpanCount: 1,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual([
      'user-task-prompt',
      'assistant-start',
      'assistant-start::tool_results',
      'assistant-work',
      'assistant-complete',
      'assistant-complete::tool_results',
    ]);
  });

  it('keeps native OpenCode tools near task markers in the task stream', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            taskMarkerLogMessage({
              uuid: 'native-before-task',
              timestamp: '2026-04-21T09:50:00.000Z',
              toolName: 'read',
              input: { filePath: '/tmp/unrelated.ts' },
            }),
            textLogMessage({
              uuid: 'user-task-prompt',
              type: 'user',
              role: 'user',
              timestamp: '2026-04-21T10:01:00.000Z',
              content: [{ type: 'text', text: 'Start task-a now' }],
            }),
            taskMarkerLogMessage({
              uuid: 'assistant-start',
              parentUuid: 'user-task-prompt',
              timestamp: '2026-04-21T10:02:00.000Z',
              toolName: 'mcp__agent-teams__task_start',
              input: { teamName: 'team-a', taskId: 'task-a' },
            }),
            toolResultLogMessage({
              uuid: 'assistant-start::tool_results',
              parentUuid: 'assistant-start',
              timestamp: '2026-04-21T10:02:01.000Z',
              sourceToolAssistantUUID: 'assistant-start',
            }),
            taskMarkerLogMessage({
              uuid: 'native-read',
              parentUuid: 'assistant-start::tool_results',
              timestamp: '2026-04-21T10:03:00.000Z',
              toolName: 'read',
              input: { filePath: '/tmp/app.ts' },
            }),
            toolResultLogMessage({
              uuid: 'native-read::tool_results',
              parentUuid: 'native-read',
              timestamp: '2026-04-21T10:03:01.000Z',
              sourceToolAssistantUUID: 'native-read',
            }),
            taskMarkerLogMessage({
              uuid: 'native-bash',
              parentUuid: 'native-read::tool_results',
              timestamp: '2026-04-21T10:04:00.000Z',
              toolName: 'bash',
              input: { command: 'pnpm test' },
            }),
            toolResultLogMessage({
              uuid: 'native-bash::tool_results',
              parentUuid: 'native-bash',
              timestamp: '2026-04-21T10:04:01.000Z',
              sourceToolAssistantUUID: 'native-bash',
            }),
            taskMarkerLogMessage({
              uuid: 'assistant-comment',
              parentUuid: 'native-bash::tool_results',
              timestamp: '2026-04-21T10:05:00.000Z',
              toolName: 'mcp__agent-teams__task_add_comment',
              input: { teamName: 'team-a', taskId: 'task-a', text: 'Tests passed' },
            }),
            toolResultLogMessage({
              uuid: 'assistant-comment::tool_results',
              parentUuid: 'assistant-comment',
              timestamp: '2026-04-21T10:05:01.000Z',
              sourceToolAssistantUUID: 'assistant-comment',
            }),
            taskMarkerLogMessage({
              uuid: 'native-after-task',
              timestamp: '2026-04-21T10:20:00.000Z',
              toolName: 'bash',
              input: { command: 'echo unrelated' },
            }),
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-native-tools',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [
          createTask({
            workIntervals: [
              {
                startedAt: '2026-04-21T10:00:00.000Z',
                completedAt: '2026-04-21T10:06:00.000Z',
              },
            ],
          }),
        ],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 9,
      boardMcpToolCount: 2,
      nativeToolCount: 2,
      fallbackReason: 'task_tool_markers',
      markerMatchCount: 2,
      markerSpanCount: 1,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual([
      'user-task-prompt',
      'assistant-start',
      'assistant-start::tool_results',
      'native-read',
      'native-read::tool_results',
      'native-bash',
      'native-bash::tool_results',
      'assistant-comment',
      'assistant-comment::tool_results',
    ]);
  });

  it('can include native OpenCode work shortly before a comment-only task marker', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            taskMarkerLogMessage({
              uuid: 'native-read',
              timestamp: '2026-04-21T10:02:00.000Z',
              toolName: 'read',
              input: { filePath: '/tmp/app.ts' },
            }),
            toolResultLogMessage({
              uuid: 'native-read::tool_results',
              parentUuid: 'native-read',
              timestamp: '2026-04-21T10:02:01.000Z',
              sourceToolAssistantUUID: 'native-read',
            }),
            taskMarkerLogMessage({
              uuid: 'assistant-comment',
              parentUuid: 'native-read::tool_results',
              timestamp: '2026-04-21T10:04:00.000Z',
              toolName: 'mcp__agent-teams__task_add_comment',
              input: { teamName: 'team-a', taskId: 'task-a', text: 'Found the issue' },
            }),
            toolResultLogMessage({
              uuid: 'assistant-comment::tool_results',
              parentUuid: 'assistant-comment',
              timestamp: '2026-04-21T10:04:01.000Z',
              sourceToolAssistantUUID: 'assistant-comment',
            }),
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-comment-only-native',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask()],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 4,
      boardMcpToolCount: 1,
      nativeToolCount: 1,
      fallbackReason: 'task_tool_markers',
      markerMatchCount: 1,
      markerSpanCount: 1,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual([
      'native-read',
      'native-read::tool_results',
      'assistant-comment',
      'assistant-comment::tool_results',
    ]);
  });

  it('ignores OpenCode task markers that explicitly belong to another team', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            textLogMessage({
              uuid: 'other-team-prompt',
              type: 'user',
              role: 'user',
              timestamp: '2026-04-21T10:01:00.000Z',
            }),
            taskMarkerLogMessage({
              uuid: 'other-team-start',
              parentUuid: 'other-team-prompt',
              timestamp: '2026-04-21T10:02:00.000Z',
              toolName: 'mcp__agent-teams__task_start',
              input: { teamName: 'other-team', taskId: 'task-a' },
            }),
            toolResultLogMessage({
              uuid: 'other-team-start::tool_results',
              parentUuid: 'other-team-start',
              timestamp: '2026-04-21T10:02:01.000Z',
              sourceToolAssistantUUID: 'other-team-start',
            }),
            textLogMessage({
              uuid: 'team-a-prompt',
              type: 'user',
              role: 'user',
              timestamp: '2026-04-21T10:03:00.000Z',
            }),
            taskMarkerLogMessage({
              uuid: 'team-a-start',
              parentUuid: 'team-a-prompt',
              timestamp: '2026-04-21T10:04:00.000Z',
              toolName: 'mcp__agent-teams__task_start',
              input: { teamName: 'team-a', taskId: 'task-a' },
            }),
            toolResultLogMessage({
              uuid: 'team-a-start::tool_results',
              parentUuid: 'team-a-start',
              timestamp: '2026-04-21T10:04:01.000Z',
              sourceToolAssistantUUID: 'team-a-start',
            }),
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-team-marker',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask()],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 3,
      boardMcpToolCount: 1,
      nativeToolCount: 0,
      fallbackReason: 'task_tool_markers',
      markerMatchCount: 1,
      markerSpanCount: 1,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual(['team-a-prompt', 'team-a-start', 'team-a-start::tool_results']);
  });

  it('keeps separate marker spans for repeated task work cycles without including unrelated gaps', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            textLogMessage({
              uuid: 'cycle-1-prompt',
              type: 'user',
              role: 'user',
              timestamp: '2026-04-21T10:01:00.000Z',
            }),
            taskMarkerLogMessage({
              uuid: 'cycle-1-start',
              parentUuid: 'cycle-1-prompt',
              timestamp: '2026-04-21T10:02:00.000Z',
              toolName: 'mcp__agent-teams__task_start',
              input: { teamName: 'team-a', taskId: 'task-a' },
            }),
            toolResultLogMessage({
              uuid: 'cycle-1-start::tool_results',
              parentUuid: 'cycle-1-start',
              timestamp: '2026-04-21T10:02:01.000Z',
              sourceToolAssistantUUID: 'cycle-1-start',
            }),
            textLogMessage({
              uuid: 'cycle-1-work',
              timestamp: '2026-04-21T10:04:00.000Z',
            }),
            taskMarkerLogMessage({
              uuid: 'cycle-1-complete',
              parentUuid: 'cycle-1-work',
              timestamp: '2026-04-21T10:08:00.000Z',
              toolName: 'mcp__agent-teams__task_complete',
              input: { teamName: 'team-a', taskId: 'task-a' },
            }),
            toolResultLogMessage({
              uuid: 'cycle-1-complete::tool_results',
              parentUuid: 'cycle-1-complete',
              timestamp: '2026-04-21T10:08:01.000Z',
              sourceToolAssistantUUID: 'cycle-1-complete',
            }),
            textLogMessage({
              uuid: 'unrelated-between-cycles',
              timestamp: '2026-04-21T12:00:00.000Z',
            }),
            textLogMessage({
              uuid: 'cycle-2-prompt',
              type: 'user',
              role: 'user',
              timestamp: '2026-04-21T14:01:00.000Z',
            }),
            taskMarkerLogMessage({
              uuid: 'cycle-2-start',
              parentUuid: 'cycle-2-prompt',
              timestamp: '2026-04-21T14:02:00.000Z',
              toolName: 'mcp__agent-teams__task_start',
              input: { teamName: 'team-a', taskId: 'task-a' },
            }),
            toolResultLogMessage({
              uuid: 'cycle-2-start::tool_results',
              parentUuid: 'cycle-2-start',
              timestamp: '2026-04-21T14:02:01.000Z',
              sourceToolAssistantUUID: 'cycle-2-start',
            }),
            textLogMessage({
              uuid: 'cycle-2-work-after-open-marker',
              timestamp: '2026-04-21T14:04:00.000Z',
            }),
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-marker-cycles',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [
          createTask({
            updatedAt: '2026-04-21T14:10:00.000Z',
            workIntervals: [
              {
                startedAt: '2026-04-21T10:00:00.000Z',
                completedAt: '2026-04-21T10:10:00.000Z',
              },
              {
                startedAt: '2026-04-21T14:00:00.000Z',
                completedAt: '2026-04-21T14:10:00.000Z',
              },
            ],
          }),
        ],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 10,
      boardMcpToolCount: 3,
      nativeToolCount: 0,
      fallbackReason: 'task_tool_markers',
      markerMatchCount: 3,
      markerSpanCount: 2,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual([
      'cycle-1-prompt',
      'cycle-1-start',
      'cycle-1-start::tool_results',
      'cycle-1-work',
      'cycle-1-complete',
      'cycle-1-complete::tool_results',
      'cycle-2-prompt',
      'cycle-2-start',
      'cycle-2-start::tool_results',
      'cycle-2-work-after-open-marker',
    ]);
  });

  it('ignores stale task markers outside current task windows before falling back to time-window logs', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            taskMarkerLogMessage({
              uuid: 'stale-start-marker',
              timestamp: '2026-04-21T08:00:00.000Z',
              toolName: 'mcp__agent-teams__task_start',
              input: { teamName: 'team-a', taskId: 'task-a' },
            }),
            textLogMessage({
              uuid: 'current-window-work',
              timestamp: '2026-04-21T10:05:00.000Z',
            }),
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-stale-marker',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask()],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 1,
      boardMcpToolCount: 0,
      nativeToolCount: 0,
      fallbackReason: 'no_attribution_records',
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual(['current-window-work']);
  });

  it('matches hash-prefixed display task refs in OpenCode task tool markers', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-opencode',
        logProjection: {
          messages: [
            taskMarkerLogMessage({
              uuid: 'display-ref-start',
              timestamp: '2026-04-21T10:03:00.000Z',
              toolName: 'mcp__agent-teams__task_start',
              input: { teamName: 'team-a', taskId: '#short123' },
            }),
            toolResultLogMessage({
              uuid: 'display-ref-start::tool_results',
              parentUuid: 'display-ref-start',
              timestamp: '2026-04-21T10:03:01.000Z',
              sourceToolAssistantUUID: 'display-ref-start',
            }),
          ],
        },
      })),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-display-ref-marker',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask({ id: 'task-canonical', displayId: 'short123' })],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => []) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-canonical');

    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      projectedMessageCount: 2,
      boardMcpToolCount: 1,
      nativeToolCount: 0,
      fallbackReason: 'task_tool_markers',
      markerMatchCount: 1,
      markerSpanCount: 1,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual(['display-ref-start', 'display-ref-start::tool_results']);
  });

  it('prefers explicit OpenCode attribution over owner/time-window heuristic', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async (_binaryPath, params: { memberName: string }) => {
        if (params.memberName !== 'bob') {
          throw new Error(`unexpected member ${params.memberName}`);
        }
        return {
          sessionId: 'session-bob',
          logProjection: {
            messages: [
              {
                uuid: 'bob-outside',
                parentUuid: undefined,
                type: 'assistant',
                timestamp: '2026-04-21T11:50:00.000Z',
                role: 'assistant',
                content: [{ type: 'text', text: 'Before attributed window' }],
                isMeta: false,
                sessionId: 'session-bob',
                toolCalls: [],
                toolResults: [],
              },
              {
                uuid: 'bob-inside',
                parentUuid: undefined,
                type: 'assistant',
                timestamp: '2026-04-21T12:05:00.000Z',
                role: 'assistant',
                content: [{ type: 'text', text: 'Explicitly attributed OpenCode work' }],
                isMeta: false,
                sessionId: 'session-bob',
                toolCalls: [],
                toolResults: [],
              },
            ],
          },
        };
      }),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-attributed',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const taskReader = {
      getTasks: vi.fn(async () => [createTask()]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const attributionRecords: OpenCodeTaskLogAttributionRecord[] = [
      {
        taskId: 'task-a',
        memberName: 'bob',
        scope: 'member_session_window',
        sessionId: 'session-bob',
        since: '2026-04-21T12:00:00.000Z',
        until: '2026-04-21T12:10:00.000Z',
        source: 'launch_runtime',
      },
    ];

    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      taskReader as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => attributionRecords) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.source).toBe('opencode_runtime_attribution');
    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'attribution',
      attributionRecordCount: 1,
      projectedMessageCount: 1,
      boardMcpToolCount: 0,
      nativeToolCount: 0,
    });
    expect(response?.participants).toEqual([
      {
        key: 'member:bob',
        label: 'bob',
        role: 'member',
        isLead: false,
        isSidechain: true,
      },
    ]);
    expect(response?.defaultFilter).toBe('member:bob');
    expect(response?.segments[0]?.actor).toEqual({
      memberName: 'bob',
      role: 'member',
      sessionId: 'session-bob',
      isSidechain: true,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls[0]?.[0].map(
        (message: { uuid: string }) => message.uuid
      )
    ).toEqual(['bob-inside']);
    expect(bridge.getOpenCodeTranscript).toHaveBeenCalledWith('/tmp/claude', {
      teamId: 'team-a',
      memberName: 'bob',
      limit: 500,
    });
  });

  it('falls back to owner heuristic when explicit attribution is stale', async () => {
    const bridge = {
      getOpenCodeTranscript: vi.fn(async (_binaryPath, params: { memberName: string }) => {
        if (params.memberName === 'bob') {
          return {
            sessionId: 'stale-session',
            logProjection: {
              messages: [
                {
                  uuid: 'stale-bob',
                  parentUuid: undefined,
                  type: 'assistant',
                  timestamp: '2026-04-21T10:05:00.000Z',
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Wrong session' }],
                  isMeta: false,
                  sessionId: 'stale-session',
                  toolCalls: [],
                  toolResults: [],
                },
              ],
            },
          };
        }
        return {
          sessionId: 'session-alice',
          logProjection: {
            messages: [
              {
                uuid: 'alice-inside',
                parentUuid: undefined,
                type: 'assistant',
                timestamp: '2026-04-21T10:05:00.000Z',
                role: 'assistant',
                content: [{ type: 'text', text: 'Heuristic owner work' }],
                isMeta: false,
                sessionId: 'session-alice',
                toolCalls: [],
                toolResults: [],
              },
            ],
          },
        };
      }),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk-heuristic',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const attributionRecords: OpenCodeTaskLogAttributionRecord[] = [
      {
        taskId: 'task-a',
        memberName: 'bob',
        scope: 'member_session_window',
        sessionId: 'session-bob',
        since: '2026-04-21T10:00:00.000Z',
        until: '2026-04-21T10:10:00.000Z',
      },
    ];
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask()],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      { readTaskRecords: vi.fn(async () => attributionRecords) }
    );

    const response = await source.getTaskLogStream('team-a', 'task-a');

    expect(response?.source).toBe('opencode_runtime_fallback');
    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 1,
      projectedMessageCount: 1,
      boardMcpToolCount: 0,
      nativeToolCount: 0,
      fallbackReason: 'attribution_no_projected_messages',
    });
    expect(response?.participants[0]?.label).toBe('alice');
    expect(
      chunkBuilder.buildBundleChunks.mock.calls
        .at(-1)?.[0]
        .map((message: { uuid: string }) => message.uuid)
    ).toEqual(['alice-inside']);
    expect(bridge.getOpenCodeTranscript).toHaveBeenNthCalledWith(1, '/tmp/claude', {
      teamId: 'team-a',
      memberName: 'bob',
      limit: 500,
    });
    expect(bridge.getOpenCodeTranscript).toHaveBeenNthCalledWith(2, '/tmp/claude', {
      teamId: 'team-a',
      memberName: 'alice',
      limit: 200,
    });
  });

  it('keys the short cache by attribution records so new explicit attribution is visible immediately', async () => {
    const attributionRecords: OpenCodeTaskLogAttributionRecord[] = [
      {
        taskId: 'task-a',
        memberName: 'bob',
        scope: 'member_session_window',
        sessionId: 'session-bob',
        since: '2026-04-21T12:00:00.000Z',
        until: '2026-04-21T12:10:00.000Z',
      },
    ];
    const attributionStore = {
      readTaskRecords: vi
        .fn<() => Promise<OpenCodeTaskLogAttributionRecord[]>>()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(attributionRecords),
    };
    const bridge = {
      getOpenCodeTranscript: vi.fn(async (_binaryPath, params: { memberName: string }) => {
        const isBob = params.memberName === 'bob';
        return {
          sessionId: isBob ? 'session-bob' : 'session-alice',
          logProjection: {
            messages: [
              {
                uuid: isBob ? 'bob-new-attribution' : 'alice-old-heuristic',
                parentUuid: undefined,
                type: 'assistant',
                timestamp: isBob ? '2026-04-21T12:05:00.000Z' : '2026-04-21T10:05:00.000Z',
                role: 'assistant',
                content: [{ type: 'text', text: isBob ? 'new attribution' : 'old heuristic' }],
                isMeta: false,
                sessionId: isBob ? 'session-bob' : 'session-alice',
                toolCalls: [],
                toolResults: [],
              },
            ],
          },
        };
      }),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages) => [
        {
          id: 'chunk',
          kind: 'assistant',
          messages,
        },
      ]),
    };
    const source = new OpenCodeTaskLogStreamSource(
      bridge as never,
      { resolve: async () => '/tmp/claude' },
      {
        getTasks: async () => [createTask()],
        getDeletedTasks: async () => [],
      } as never,
      chunkBuilder as never,
      attributionStore
    );

    const first = await source.getTaskLogStream('team-a', 'task-a');
    const second = await source.getTaskLogStream('team-a', 'task-a');

    expect(first?.source).toBe('opencode_runtime_fallback');
    expect(second?.source).toBe('opencode_runtime_attribution');
    expect(second?.runtimeProjection).toMatchObject({
      provider: 'opencode',
      mode: 'attribution',
      attributionRecordCount: 1,
      projectedMessageCount: 1,
    });
    expect(bridge.getOpenCodeTranscript).toHaveBeenNthCalledWith(1, '/tmp/claude', {
      teamId: 'team-a',
      memberName: 'alice',
      limit: 200,
    });
    expect(bridge.getOpenCodeTranscript).toHaveBeenNthCalledWith(2, '/tmp/claude', {
      teamId: 'team-a',
      memberName: 'bob',
      limit: 500,
    });
    expect(
      chunkBuilder.buildBundleChunks.mock.calls
        .at(-1)?.[0]
        .map((message: { uuid: string }) => message.uuid)
    ).toEqual(['bob-new-attribution']);
  });
});
