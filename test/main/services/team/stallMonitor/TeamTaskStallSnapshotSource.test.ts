import { describe, expect, it, vi } from 'vitest';

import { OpenCodeLaneTurnActivityRegistry } from '../../../../../src/main/services/team/opencode/delivery/OpenCodeLaneTurnActivityRegistry';
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
      { id: 'task-approved', subject: 'Approved', status: 'in_progress' },
      { id: 'task-reopened', subject: 'Reopened', status: 'pending', reviewState: 'approved' },
    ];
    const deletedTasks = [{ id: 'task-deleted', subject: 'D', status: 'deleted' }];
    const transcriptContext = {
      projectDir: '/tmp/project',
      projectId: 'project-id',
      config: {
        members: [
          { name: 'team-lead', role: 'team lead', providerId: 'codex' },
          { name: 'alice', role: 'Developer', model: 'qwen/qwen3-coder' },
        ],
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
      [
        'task-a',
        { taskId: 'task-a', updatedAt: '2026-04-19T12:00:00.000Z', filePath: '/tmp/fresh.json' },
      ],
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
          'task-approved': {
            column: 'approved',
            movedAt: '2026-04-19T12:05:00.000Z',
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
    const membersMetaStore = {
      getMembers: vi.fn(async () => [{ name: 'alice', providerId: 'opencode' }]),
    };
    const openCodeEvidenceSource = {
      readEvidence: vi.fn(async () => ({
        recordsByTaskId: new Map(),
        exactRowsByFilePath: new Map(),
      })),
    };

    const source = new TeamTaskStallSnapshotSource(
      locator as never,
      taskReader as never,
      kanbanManager as never,
      transcriptReader as never,
      batchIndexer as never,
      freshnessReader as never,
      exactRowReader as never,
      membersMetaStore as never,
      openCodeEvidenceSource as never
    );

    const snapshot = await source.getSnapshot('demo');
    const expectedWorkflowActiveTasks = [
      activeTasks[0],
      activeTasks[1],
      { ...activeTasks[2], reviewState: 'approved' },
      { ...activeTasks[3], reviewState: 'none' },
    ];

    expect(snapshot).not.toBeNull();
    expect(batchIndexer.buildIndex).toHaveBeenCalledWith({
      teamName: 'demo',
      tasks: [...expectedWorkflowActiveTasks, ...deletedTasks],
      messages: rawMessages,
    });
    expect(freshnessReader.readSignals).toHaveBeenCalledWith('/tmp/project', ['task-a', 'task-b'], {
      teamName: 'demo',
    });
    expect(exactRowReader.parseFiles).toHaveBeenCalledWith([
      '/tmp/project/session-a.jsonl',
      '/tmp/project/session-b.jsonl',
    ]);
    expect(openCodeEvidenceSource.readEvidence).toHaveBeenCalledWith({
      teamName: 'demo',
      tasks: [expectedWorkflowActiveTasks[0], expectedWorkflowActiveTasks[1]],
      providerByMemberName: new Map([
        ['team-lead', 'codex'],
        ['alice', 'opencode'],
      ]),
    });
    expect(snapshot?.activeTasks).toEqual(expectedWorkflowActiveTasks);
    expect(snapshot?.inProgressTasks.map((task) => task.id)).toEqual(['task-a']);
    expect(snapshot?.reviewOpenTasks.map((task) => task.id)).toEqual(['task-b']);
    expect(snapshot?.leadName).toBe('team-lead');
    expect(snapshot?.providerByMemberName).toEqual(
      new Map([
        ['team-lead', 'codex'],
        ['alice', 'opencode'],
      ])
    );
    expect(snapshot?.resolvedReviewersByTaskId.get('task-b')).toEqual({
      reviewer: 'alice',
      source: 'kanban_state',
    });
    expect(snapshot?.recordsByTaskId).toBe(recordsByTaskId);
  });

  it('merges OpenCode runtime evidence even when no Claude transcript files are available', async () => {
    const task = {
      id: 'task-open',
      displayId: 'opencode1',
      subject: 'OpenCode task',
      status: 'in_progress',
      owner: 'bob',
    };
    const openCodeRecord = {
      id: 'opencode-rec',
      timestamp: '2026-04-19T12:00:00.000Z',
      source: {
        filePath: 'opencode-runtime:demo:bob',
        sourceOrder: 1,
      },
    };
    const openCodeRows = [
      {
        filePath: 'opencode-runtime:demo:bob',
        sourceOrder: 1,
        messageUuid: 'msg-open',
        timestamp: '2026-04-19T12:00:00.000Z',
        parsedMessage: {
          uuid: 'msg-open',
          parentUuid: null,
          type: 'assistant',
          timestamp: new Date('2026-04-19T12:00:00.000Z'),
          content: '',
          isSidechain: true,
          isMeta: false,
          toolCalls: [],
          toolResults: [],
        },
        toolUseIds: [],
        toolResultIds: [],
      },
    ];
    const source = new TeamTaskStallSnapshotSource(
      {
        getContext: vi.fn(async () => ({
          projectDir: '/tmp/project',
          projectId: 'project-id',
          config: {
            members: [
              { name: 'team-lead', role: 'team lead', providerId: 'codex' },
              { name: 'bob', role: 'Developer', providerId: 'opencode' },
            ],
          },
          sessionIds: [],
          transcriptFiles: [],
        })),
      } as never,
      {
        getTasks: vi.fn(async () => [task]),
        getDeletedTasks: vi.fn(async () => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'demo', tasks: {} })),
      } as never,
      {
        readFiles: vi.fn(async () => {
          throw new Error('transcript reader should not be called');
        }),
      } as never,
      {
        buildIndex: vi.fn(() => new Map()),
      } as never,
      {
        readSignals: vi.fn(async () => new Map()),
      } as never,
      {
        parseFiles: vi.fn(async () => new Map()),
      } as never,
      {
        getMembers: vi.fn(async () => []),
      } as never,
      {
        readEvidence: vi.fn(async () => ({
          recordsByTaskId: new Map([['task-open', [openCodeRecord]]]),
          exactRowsByFilePath: new Map([['opencode-runtime:demo:bob', openCodeRows]]),
        })),
      } as never
    );

    const snapshot = await source.getSnapshot('demo');

    expect(snapshot?.recordsByTaskId.get('task-open')).toEqual([openCodeRecord]);
    expect(snapshot?.exactRowsByFilePath.get('opencode-runtime:demo:bob')).toEqual(openCodeRows);
    expect(snapshot?.transcriptFiles).toEqual([]);
  });

  it('splits the recorded OpenCode lane turn samples into idle-since and active sets', async () => {
    const laneTurnActivity = new OpenCodeLaneTurnActivityRegistry();
    laneTurnActivity.note({
      teamName: 'demo',
      memberName: 'Bob',
      laneId: 'secondary:opencode:bob',
      state: 'idle',
      observedAt: '2026-04-19T12:00:30.000Z',
    });
    laneTurnActivity.note({
      teamName: 'demo',
      memberName: 'Carol',
      laneId: 'secondary:opencode:carol',
      state: 'active',
      observedAt: '2026-04-19T12:01:00.000Z',
    });
    laneTurnActivity.note({
      teamName: 'other-team',
      memberName: 'Dave',
      laneId: 'secondary:opencode:dave',
      state: 'active',
      observedAt: '2026-04-19T12:02:00.000Z',
    });

    const snapshot = await snapshotSourceWithLaneTurnActivity(laneTurnActivity).getSnapshot('demo');

    expect([...(snapshot?.openCodeLaneIdleSinceByMemberName ?? new Map())]).toEqual([
      ['bob', '2026-04-19T12:00:30.000Z'],
    ]);
    expect([...(snapshot?.openCodeLaneActiveMemberNames ?? new Set())]).toEqual(['carol']);
  });
});

function snapshotSourceWithLaneTurnActivity(
  laneTurnActivity: OpenCodeLaneTurnActivityRegistry
): TeamTaskStallSnapshotSource {
  return new TeamTaskStallSnapshotSource(
    {
      getContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/repo/project',
          projectId: 'project-id',
          config: { members: [] },
          sessionIds: [],
          transcriptFiles: [],
        })
      ),
    } as never,
    {
      getTasks: vi.fn(() => Promise.resolve([])),
      getDeletedTasks: vi.fn(() => Promise.resolve([])),
    } as never,
    { getState: vi.fn(() => Promise.resolve({ teamName: 'demo', tasks: {} })) } as never,
    { readFiles: vi.fn(() => Promise.resolve(new Map())) } as never,
    { buildIndex: vi.fn(() => new Map()) } as never,
    { readSignals: vi.fn(() => Promise.resolve(new Map())) } as never,
    { parseFiles: vi.fn(() => Promise.resolve(new Map())) } as never,
    { getMembers: vi.fn(() => Promise.resolve([])) } as never,
    {
      readEvidence: vi.fn(() =>
        Promise.resolve({
          recordsByTaskId: new Map(),
          exactRowsByFilePath: new Map(),
        })
      ),
    } as never,
    laneTurnActivity
  );
}
