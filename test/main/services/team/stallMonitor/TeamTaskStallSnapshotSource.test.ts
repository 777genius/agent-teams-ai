import { describe, expect, it, vi } from 'vitest';

import { TeamTaskStallSnapshotSource } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallSnapshotSource';

describe('TeamTaskStallSnapshotSource', () => {
  it('returns null when transcript context is unavailable', async () => {
    const source = new TeamTaskStallSnapshotSource(
      { getContext: vi.fn(async () => null) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(source.getSnapshot('demo')).resolves.toBeNull();
  });

  it('builds one batched snapshot and narrows exact/freshness reads to work and started-review candidates', async () => {
    const activeTasks = [
      { id: 'task-a', subject: 'A', status: 'in_progress' },
      {
        id: 'task-b',
        subject: 'B',
        status: 'completed',
        reviewState: 'review',
        historyEvents: [
          {
            id: 'evt-review-requested',
            type: 'review_requested',
            timestamp: '2026-04-19T12:00:00.000Z',
            from: 'none',
            to: 'review',
            reviewer: 'alice',
          },
        ],
      },
    ];
    const deletedTasks = [{ id: 'task-deleted', subject: 'D', status: 'deleted' }];
    const transcriptContext = {
      projectDir: '/tmp/project',
      projectId: 'project-id',
      config: {
        members: [{ name: 'team-lead', role: 'team lead' }],
      } as never,
      sessionIds: ['session-a'],
      transcriptFiles: ['/tmp/project/session-a.jsonl', '/tmp/project/session-b.jsonl'],
    };
    const rawMessages = [{ uuid: 'm1' }];
    const recordsByTaskId = new Map([
      [
        'task-a',
        [
          {
            id: 'r1',
            source: {
              filePath: '/tmp/project/session-b.jsonl',
            },
          },
        ],
      ],
      [
        'task-b',
        [
          {
            id: 'r2',
            source: {
              filePath: '/tmp/project/session-a.jsonl',
            },
          },
        ],
      ],
    ]);
    const freshnessByTaskId = new Map([
      ['task-a', { taskId: 'task-a', updatedAt: '2026-04-19T12:00:00.000Z', filePath: '/tmp/fresh.json' }],
    ]);
    const exactRowsByFilePath = new Map([['/tmp/project/session-b.jsonl', []]]);

    const locator = {
      getContext: vi.fn(async () => transcriptContext),
    };
    const taskReader = {
      getTasks: vi.fn(async () => activeTasks),
      getDeletedTasks: vi.fn(async () => deletedTasks),
    };
    const kanbanManager = {
      getState: vi.fn(async () => ({
        teamName: 'demo',
        reviewers: ['alice'],
        tasks: {
          'task-b': {
            column: 'review',
            movedAt: '2026-04-19T12:00:00.000Z',
            reviewer: 'alice',
          },
        },
      })),
    };
    const transcriptReader = {
      readFiles: vi.fn(async () => rawMessages),
    };
    const batchIndexer = {
      buildIndex: vi.fn(() => recordsByTaskId),
    };
    const freshnessReader = {
      readSignals: vi.fn(async () => freshnessByTaskId),
    };
    const exactRowReader = {
      parseFiles: vi.fn(async () => exactRowsByFilePath),
    };

    const source = new TeamTaskStallSnapshotSource(
      locator as never,
      taskReader as never,
      kanbanManager as never,
      transcriptReader as never,
      batchIndexer as never,
      freshnessReader as never,
      exactRowReader as never
    );

    const snapshot = await source.getSnapshot('demo');

    expect(snapshot).not.toBeNull();
    expect(batchIndexer.buildIndex).toHaveBeenCalledWith({
      teamName: 'demo',
      tasks: [...activeTasks, ...deletedTasks],
      messages: rawMessages,
    });
    expect(freshnessReader.readSignals).toHaveBeenCalledWith('/tmp/project', ['task-a', 'task-b']);
    expect(exactRowReader.parseFiles).toHaveBeenCalledWith(['/tmp/project/session-a.jsonl', '/tmp/project/session-b.jsonl']);
    expect(snapshot?.inProgressTasks.map((task) => task.id)).toEqual(['task-a']);
    expect(snapshot?.reviewOpenTasks.map((task) => task.id)).toEqual(['task-b']);
    expect(snapshot?.leadName).toBe('team-lead');
    expect(snapshot?.resolvedReviewersByTaskId.get('task-b')).toEqual({
      reviewer: 'alice',
      source: 'kanban_state',
    });
    expect(snapshot?.recordsByTaskId).toBe(recordsByTaskId);
  });
});
