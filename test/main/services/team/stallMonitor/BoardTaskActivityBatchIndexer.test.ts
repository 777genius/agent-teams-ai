import { describe, expect, it, vi } from 'vitest';

import { BoardTaskActivityBatchIndexer } from '../../../../../src/main/services/team/stallMonitor/BoardTaskActivityBatchIndexer';
import { BoardTaskActivityRecordBuilder } from '../../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordBuilder';

import type { RawTaskActivityMessage } from '../../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';
import type { TeamTask } from '../../../../../src/shared/types';

describe('BoardTaskActivityBatchIndexer', () => {
  it('delegates one batched build through buildForTasks', () => {
    const built = new Map([['task-a', [{ id: 'r1' }]]]);
    const builder = {
      buildForTasks: vi.fn(() => built),
    };

    const indexer = new BoardTaskActivityBatchIndexer(builder as never);
    const result = indexer.buildIndex({
      teamName: 'demo',
      tasks: [{ id: 'task-a', subject: 'A', status: 'in_progress' } as TeamTask],
      messages: [{ uuid: 'm1' } as RawTaskActivityMessage],
    });

    expect(result).toBe(built);
    expect(builder.buildForTasks).toHaveBeenCalledTimes(1);
  });

  it('keeps buildForTask behavior consistent with batched build', () => {
    const builder = new BoardTaskActivityRecordBuilder();
    const taskA: TeamTask = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      status: 'in_progress',
    };
    const taskB: TeamTask = {
      id: 'task-b',
      displayId: 'deadbeef',
      subject: 'Task B',
      status: 'pending',
    };
    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/session.jsonl',
        uuid: 'msg-1',
        timestamp: '2026-04-19T12:00:00.000Z',
        sessionId: 'session-a',
        agentName: 'alice',
        isSidechain: true,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-1',
            task: {
              ref: 'task-a',
              refKind: 'canonical',
              canonicalId: 'task-a',
            },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: {
              relation: 'same_task',
            },
          },
          {
            schemaVersion: 1,
            toolUseId: 'tool-2',
            task: {
              ref: 'task-b',
              refKind: 'canonical',
              canonicalId: 'task-b',
            },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: {
              relation: 'same_task',
            },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-1',
            canonicalToolName: 'task_start',
          },
          {
            schemaVersion: 1,
            toolUseId: 'tool-2',
            canonicalToolName: 'task_add_comment',
          },
        ],
      },
    ];

    const recordsByTaskId = builder.buildForTasks({
      teamName: 'demo',
      tasks: [taskA, taskB],
      messages,
    });

    expect(recordsByTaskId.get('task-a')).toEqual(
      builder.buildForTask({
        teamName: 'demo',
        targetTask: taskA,
        tasks: [taskA, taskB],
        messages,
      })
    );
    expect(recordsByTaskId.get('task-b')).toEqual(
      builder.buildForTask({
        teamName: 'demo',
        targetTask: taskB,
        tasks: [taskA, taskB],
        messages,
      })
    );
  });
});
