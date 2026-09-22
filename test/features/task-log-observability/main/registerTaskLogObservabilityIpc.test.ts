import {
  TEAM_GET_TASK_ACTIVITY,
  TEAM_GET_TASK_ACTIVITY_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
  TEAM_GET_TASK_LOG_STREAM,
  TEAM_GET_TASK_LOG_STREAM_SUMMARY,
} from '@features/task-log-observability/contracts';
import {
  registerTaskLogObservabilityIpc,
  removeTaskLogObservabilityIpc,
} from '@features/task-log-observability/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskLogObservabilityIpcDependencies } from '@features/task-log-observability/main';
import type { BoardTaskExactLogDetailResult } from '@shared/types';

type Handler = (...args: unknown[]) => unknown;

const CHANNELS = [
  TEAM_GET_TASK_ACTIVITY,
  TEAM_GET_TASK_ACTIVITY_DETAIL,
  TEAM_GET_TASK_LOG_STREAM_SUMMARY,
  TEAM_GET_TASK_LOG_STREAM,
  TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
  TEAM_GET_TASK_EXACT_LOG_DETAIL,
];

describe('task log observability IPC', () => {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      if (handlers.has(channel)) {
        throw new Error(`Duplicate IPC registration: ${channel}`);
      }
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const activity = {
    getTaskActivity: vi.fn(async function (this: typeof activity) {
      expect(this).toBe(activity);
      return [
        {
          id: 'activity-1',
          timestamp: '2026-04-12T10:00:00.000Z',
          task: {
            locator: { ref: 'abcd1234', refKind: 'display' as const },
            resolution: 'resolved' as const,
          },
          linkKind: 'lifecycle' as const,
          targetRole: 'subject' as const,
          actor: { role: 'lead' as const, sessionId: 'session-1', isSidechain: false },
          actorContext: { relation: 'idle' as const },
          source: { messageUuid: 'message-1', filePath: '/tmp/task.jsonl', sourceOrder: 1 },
        },
      ];
    }),
  };
  const activityDetail = {
    getTaskActivityDetail: vi.fn(async function (this: typeof activityDetail) {
      expect(this).toBe(activityDetail);
      return {
        status: 'ok' as const,
        detail: {
          entryId: 'activity-1',
          summaryLabel: 'Added a comment',
          actorLabel: 'bob',
          timestamp: '2026-04-13T10:35:00.000Z',
          contextLines: ['while working on #peer12345'],
          metadataRows: [{ label: 'Comment', value: '42' }],
        },
      };
    }),
  };
  const stream = {
    getTaskLogStream: vi.fn(async function (this: typeof stream) {
      expect(this).toBe(stream);
      return {
        participants: [
          {
            key: 'member:alice',
            label: 'alice',
            role: 'member' as const,
            isLead: false,
            isSidechain: true,
          },
        ],
        defaultFilter: 'all',
        segments: [],
      };
    }),
    getTaskLogStreamSummary: vi.fn(async function (this: typeof stream) {
      expect(this).toBe(stream);
      return { segmentCount: 3 };
    }),
  };
  const exactLogSummaries = {
    getTaskExactLogSummaries: vi.fn(async function (this: typeof exactLogSummaries) {
      expect(this).toBe(exactLogSummaries);
      return {
        items: [
          {
            id: 'tool:/tmp/task.jsonl:tool-1',
            timestamp: '2026-04-12T16:00:00.000Z',
            actor: {
              memberName: 'alice',
              role: 'member' as const,
              sessionId: 'session-1',
              agentId: 'agent-1',
              isSidechain: true,
            },
            source: {
              filePath: '/tmp/task.jsonl',
              messageUuid: 'msg-1',
              toolUseId: 'tool-1',
              sourceOrder: 1,
            },
            anchorKind: 'tool' as const,
            actionLabel: 'Added a comment',
            actionCategory: 'comment' as const,
            canonicalToolName: 'task_add_comment',
            linkKinds: ['board_action' as const],
            canLoadDetail: true as const,
            sourceGeneration: 'gen-1',
          },
        ],
      };
    }),
  };
  const exactLogDetail = {
    getTaskExactLogDetail: vi.fn(async function (
      this: typeof exactLogDetail
    ): Promise<BoardTaskExactLogDetailResult> {
      expect(this).toBe(exactLogDetail);
      return {
        status: 'ok',
        detail: { id: 'tool:/tmp/task.jsonl:tool-1', chunks: [] },
      };
    }),
  };
  const logger = { error: vi.fn() };
  const dependencies: TaskLogObservabilityIpcDependencies = {
    readers: { activity, activityDetail, stream, exactLogSummaries, exactLogDetail },
    logger,
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerTaskLogObservabilityIpc(ipcMain as never, dependencies);
  });

  it('owns the exact six stable channels', () => {
    expect(CHANNELS).toEqual([
      'team:getTaskActivity',
      'team:getTaskActivityDetail',
      'team:getTaskLogStreamSummary',
      'team:getTaskLogStream',
      'team:getTaskExactLogSummaries',
      'team:getTaskExactLogDetail',
    ]);
    expect(ipcMain.handle).toHaveBeenCalledTimes(CHANNELS.length);
    expect([...handlers.keys()]).toEqual(CHANNELS);
  });

  it('removes every owned channel', () => {
    removeTaskLogObservabilityIpc(ipcMain as never);

    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(CHANNELS.length);
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(CHANNELS);
    expect(handlers.size).toBe(0);
  });

  it('delegates all query variants through their object ports', async () => {
    const event = {};

    await expect(
      handlers.get(TEAM_GET_TASK_ACTIVITY)!(event, ' team-one ', ' task-1 ')
    ).resolves.toMatchObject({ success: true, data: [{ id: 'activity-1' }] });
    await expect(
      handlers.get(TEAM_GET_TASK_ACTIVITY_DETAIL)!(event, ' team-one ', ' task-1 ', ' activity-1 ')
    ).resolves.toMatchObject({ success: true, data: { status: 'ok' } });
    await expect(
      handlers.get(TEAM_GET_TASK_LOG_STREAM_SUMMARY)!(event, ' team-one ', ' task-1 ')
    ).resolves.toEqual({ success: true, data: { segmentCount: 3 } });
    await expect(
      handlers.get(TEAM_GET_TASK_LOG_STREAM)!(event, ' team-one ', ' task-1 ')
    ).resolves.toMatchObject({
      success: true,
      data: { participants: [{ key: 'member:alice' }], defaultFilter: 'all', segments: [] },
    });
    await expect(
      handlers.get(TEAM_GET_TASK_EXACT_LOG_SUMMARIES)!(event, ' team-one ', ' task-1 ')
    ).resolves.toMatchObject({
      success: true,
      data: { items: [{ id: 'tool:/tmp/task.jsonl:tool-1' }] },
    });
    await expect(
      handlers.get(TEAM_GET_TASK_EXACT_LOG_DETAIL)!(
        event,
        ' team-one ',
        ' task-1 ',
        ' exact-1 ',
        ' generation-1 '
      )
    ).resolves.toMatchObject({ success: true, data: { status: 'ok' } });

    expect(activity.getTaskActivity).toHaveBeenCalledWith('team-one', 'task-1');
    expect(activityDetail.getTaskActivityDetail).toHaveBeenCalledWith(
      'team-one',
      'task-1',
      'activity-1'
    );
    expect(stream.getTaskLogStreamSummary).toHaveBeenCalledWith('team-one', 'task-1');
    expect(stream.getTaskLogStream).toHaveBeenCalledWith('team-one', 'task-1');
    expect(exactLogSummaries.getTaskExactLogSummaries).toHaveBeenCalledWith('team-one', 'task-1');
    expect(exactLogDetail.getTaskExactLogDetail).toHaveBeenCalledWith(
      'team-one',
      'task-1',
      'exact-1',
      'generation-1'
    );
  });

  it.each(CHANNELS)('rejects invalid team and task locators for %s', async (channel) => {
    const handler = handlers.get(channel)!;

    await expect(handler({}, '../bad', 'task-1')).resolves.toEqual({
      success: false,
      error: 'teamName contains invalid characters',
    });
    await expect(handler({}, 'team-one', 'bad/task')).resolves.toEqual({
      success: false,
      error: 'taskId contains invalid characters',
    });
    expect(activity.getTaskActivity).not.toHaveBeenCalled();
    expect(activityDetail.getTaskActivityDetail).not.toHaveBeenCalled();
    expect(stream.getTaskLogStreamSummary).not.toHaveBeenCalled();
    expect(stream.getTaskLogStream).not.toHaveBeenCalled();
    expect(exactLogSummaries.getTaskExactLogSummaries).not.toHaveBeenCalled();
    expect(exactLogDetail.getTaskExactLogDetail).not.toHaveBeenCalled();
  });

  it('rejects blank detail identifiers before calling readers', async () => {
    await expect(
      handlers.get(TEAM_GET_TASK_ACTIVITY_DETAIL)!({}, 'team-one', 'task-1', '  ')
    ).resolves.toEqual({
      success: false,
      error: 'activityId must be a non-empty string',
    });
    await expect(
      handlers.get(TEAM_GET_TASK_EXACT_LOG_DETAIL)!({}, 'team-one', 'task-1', ' ', 'generation-1')
    ).resolves.toEqual({ success: false, error: 'exactLogId must be a non-empty string' });
    await expect(
      handlers.get(TEAM_GET_TASK_EXACT_LOG_DETAIL)!({}, 'team-one', 'task-1', 'exact-1', ' ')
    ).resolves.toEqual({
      success: false,
      error: 'expectedSourceGeneration must be a non-empty string',
    });

    expect(activityDetail.getTaskActivityDetail).not.toHaveBeenCalled();
    expect(exactLogDetail.getTaskExactLogDetail).not.toHaveBeenCalled();
  });

  it('preserves service rejection as the legacy IPC error envelope', async () => {
    stream.getTaskLogStream.mockRejectedValueOnce(new Error('stream unavailable'));

    await expect(
      handlers.get(TEAM_GET_TASK_LOG_STREAM)!({}, 'team-one', 'task-1')
    ).resolves.toEqual({ success: false, error: 'stream unavailable' });
    expect(logger.error).toHaveBeenCalledWith('[teams:getTaskLogStream] stream unavailable');
  });

  it('passes stale exact-log results through unchanged', async () => {
    exactLogDetail.getTaskExactLogDetail.mockResolvedValueOnce({ status: 'stale' });

    await expect(
      handlers.get(TEAM_GET_TASK_EXACT_LOG_DETAIL)!(
        {},
        'team-one',
        'task-1',
        'exact-1',
        'generation-1'
      )
    ).resolves.toEqual({ success: true, data: { status: 'stale' } });
  });
});
