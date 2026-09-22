import { describe, expect, it, vi } from 'vitest';

import { CodexNativeTaskLogStreamSource } from '../../../../src/main/services/team/taskLogs/stream/CodexNativeTaskLogStreamSource';

import type { CodexNativeTraceRun } from '../../../../src/main/services/team/taskLogs/stream/CodexNativeTraceReader';
import type { ParsedMessage } from '../../../../src/main/types';
import type { TeamTask } from '../../../../src/shared/types';

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: '8421e1bb-2f3b-4656-9983-6e0fd4b15963',
    displayId: '8421e1bb',
    subject: 'Investigate Codex tools',
    owner: 'atlas',
    status: 'in_progress',
    createdAt: '2026-05-01T17:10:00.000Z',
    updatedAt: '2026-05-01T17:20:00.000Z',
    ...overrides,
  } as TeamTask;
}

function message(uuid: string, timestamp: string, toolName: string): ParsedMessage {
  const toolUseId = `${uuid}-tool`;
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    role: 'assistant',
    timestamp: new Date(timestamp),
    content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: { command: 'pwd' } } as never],
    toolCalls: [{ id: toolUseId, name: toolName, input: { command: 'pwd' }, isTask: false }],
    toolResults: [],
    sessionId: 'run-1',
    isSidechain: false,
    isMeta: false,
  };
}

describe('CodexNativeTaskLogStreamSource', () => {
  it('resolves short task refs and keeps config Codex owner when runtime meta has stale model only', async () => {
    const taskReader = {
      getTasks: vi.fn(async () => [task()]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const membersMetaStore = {
      getMembers: vi.fn(async () => [
        { name: 'atlas', role: 'developer', model: 'opencode/openai/gpt-oss' },
      ]),
    };
    const configReader = {
      getConfig: vi.fn(async () => ({
        name: 'vector-room-131313',
        members: [
          {
            name: 'atlas',
            providerBackendId: 'codex-native',
            model: 'opencode/openai/gpt-oss',
          },
        ],
      })),
    };
    const traceRuns: CodexNativeTraceRun[] = [
      {
        filePath: '/trace/run-1.jsonl',
        runId: 'run-1',
        teamName: 'vector-room-131313',
        taskId: '8421e1bb-2f3b-4656-9983-6e0fd4b15963',
        ownerName: 'atlas',
        cwd: '/repo',
        startedAt: '2026-05-01T17:10:00.000Z',
        mtimeMs: Date.parse('2026-05-01T17:10:00.000Z'),
        size: 100,
        events: [],
        partial: false,
      },
    ];
    const traceReader = {
      readTaskRuns: vi.fn(async () => traceRuns),
    };
    const projector = {
      project: vi.fn(() => [message('bash-start', '2026-05-01T17:10:02.000Z', 'Bash')]),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn((messages: ParsedMessage[]) => [{ id: 'chunk-1', messages }]),
    };

    const source = new CodexNativeTaskLogStreamSource(
      taskReader as never,
      membersMetaStore as never,
      configReader as never,
      traceReader as never,
      projector as never,
      chunkBuilder as never
    );

    const response = await source.getTaskLogStream('vector-room-131313', '#8421e1bb');

    expect(traceReader.readTaskRuns).toHaveBeenCalledWith({
      teamName: 'vector-room-131313',
      taskIds: [
        '8421e1bb-2f3b-4656-9983-6e0fd4b15963',
        '8421e1bb',
      ],
      includeIncoming: true,
    });
    expect(response).toMatchObject({
      defaultFilter: 'member:atlas',
      source: 'codex_native_trace_fallback',
      runtimeProjection: {
        provider: 'codex_native',
        mode: 'trace',
        nativeToolCount: 1,
        traceFileCount: 1,
        traceRunCount: 1,
      },
    });
    expect(response?.participants.map((participant) => participant.key)).toEqual(['member:atlas']);
    expect(response?.segments[0]?.participantKey).toBe('member:atlas');
  });

  it('does not expose traces for non-Codex task owners', async () => {
    const traceReader = {
      readTaskRuns: vi.fn(async () => {
        throw new Error('should not read traces for non-Codex owners');
      }),
    };
    const source = new CodexNativeTaskLogStreamSource(
      {
        getTasks: vi.fn(async () => [task({ owner: 'alice' })]),
        getDeletedTasks: vi.fn(async () => []),
      } as never,
      {
        getMembers: vi.fn(async () => [{ name: 'alice', providerId: 'anthropic' }]),
      } as never,
      {
        getConfig: vi.fn(async () => ({
          name: 'vector-room-131313',
          members: [{ name: 'alice', providerId: 'codex' }],
        })),
      } as never,
      traceReader as never
    );

    await expect(source.getTaskLogStream('vector-room-131313', '8421e1bb')).resolves.toBeNull();
    expect(traceReader.readTaskRuns).not.toHaveBeenCalled();
  });
});
