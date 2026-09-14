import { afterEach, describe, expect, it, vi } from 'vitest';

// The under-floor override below is reported through the shared logger, and the
// suite fails any test that reaches console.warn.
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { OpenCodeLaneTurnActivityRegistry } from '../../../../../src/main/services/team/opencode/delivery/OpenCodeLaneTurnActivityRegistry';
import { getOpenCodeLaneTurnActivityMaxAgeMs } from '../../../../../src/main/services/team/stallMonitor/featureGates';
import { TeamTaskStallSnapshotSource } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallSnapshotSource';

describe('TeamTaskStallSnapshotSource', () => {
  it('returns null when transcript context is unavailable', async () => {
    const source = new TeamTaskStallSnapshotSource({
      transcriptSourceLocator: { getContext: vi.fn(async () => null) } as never,
    });

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

    const source = new TeamTaskStallSnapshotSource({
      transcriptSourceLocator: locator as never,
      taskReader: taskReader as never,
      kanbanManager: kanbanManager as never,
      transcriptReader: transcriptReader as never,
      activityBatchIndexer: batchIndexer as never,
      freshnessReader: freshnessReader as never,
      exactRowReader: exactRowReader as never,
      membersMetaStore: membersMetaStore as never,
      openCodeEvidenceSource: openCodeEvidenceSource as never,
    });

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

  it('collects owned pending tasks without widening any evidence read', async () => {
    const activeTasks = [
      { id: 'task-owned-pending', subject: 'Owned pending', status: 'pending', owner: 'Scout' },
      { id: 'task-unowned-pending', subject: 'Unowned pending', status: 'pending' },
      {
        id: 'task-deleted-pending',
        subject: 'Deleted pending',
        status: 'pending',
        owner: 'Scout',
        deletedAt: '2026-04-19T12:00:00.000Z',
      },
      { id: 'task-active', subject: 'Active', status: 'in_progress', owner: 'Scout' },
    ];
    const freshnessReader = { readSignals: vi.fn(async () => new Map()) };
    const exactRowReader = { parseFiles: vi.fn(async () => new Map()) };
    const openCodeEvidenceSource = {
      readEvidence: vi.fn(async () => ({
        recordsByTaskId: new Map(),
        exactRowsByFilePath: new Map(),
      })),
    };
    const source = new TeamTaskStallSnapshotSource({
      transcriptSourceLocator: {
        getContext: vi.fn(async () => ({
          projectDir: '/tmp/project',
          projectId: 'project-id',
          config: {
            members: [
              { name: 'team-lead', role: 'team lead', providerId: 'codex' },
              { name: 'Scout', role: 'Developer', providerId: 'opencode' },
            ],
          },
          sessionIds: [],
          transcriptFiles: [],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => activeTasks),
        getDeletedTasks: vi.fn(async () => []),
      } as never,
      kanbanManager: { getState: vi.fn(async () => ({ teamName: 'demo', tasks: {} })) } as never,
      transcriptReader: { readFiles: vi.fn(async () => []) } as never,
      activityBatchIndexer: { buildIndex: vi.fn(() => new Map()) } as never,
      freshnessReader: freshnessReader as never,
      exactRowReader: exactRowReader as never,
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      openCodeEvidenceSource: openCodeEvidenceSource as never,
    });

    const snapshot = await source.getSnapshot('demo');

    expect(snapshot?.pendingPickupTasks?.map((task) => task.id)).toEqual(['task-owned-pending']);
    // Pickup candidates need no transcript evidence, so the per-scan IO stays
    // scoped to in-progress and started-review tasks.
    expect(freshnessReader.readSignals).toHaveBeenCalledWith('/tmp/project', ['task-active'], {
      teamName: 'demo',
    });
    expect(exactRowReader.parseFiles).toHaveBeenCalledWith([]);
    expect(openCodeEvidenceSource.readEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: 'task-active' })],
      })
    );
  });

  it('still yields a snapshot for a team with no session ids or transcripts', async () => {
    const source = new TeamTaskStallSnapshotSource({
      transcriptSourceLocator: {
        getContext: vi.fn(async () => ({
          projectDir: '/tmp/project',
          projectId: 'project-id',
          config: { members: [{ name: 'acp-lead', role: 'team lead', providerId: 'opencode' }] },
          sessionIds: [],
          transcriptFiles: [],
        })),
      } as never,
      taskReader: {
        getTasks: vi.fn(async () => []),
        getDeletedTasks: vi.fn(async () => []),
      } as never,
      kanbanManager: { getState: vi.fn(async () => ({ teamName: 'demo', tasks: {} })) } as never,
      transcriptReader: { readFiles: vi.fn(async () => []) } as never,
      activityBatchIndexer: { buildIndex: vi.fn(() => new Map()) } as never,
      freshnessReader: { readSignals: vi.fn(async () => new Map()) } as never,
      exactRowReader: { parseFiles: vi.fn(async () => new Map()) } as never,
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      openCodeEvidenceSource: {
        readEvidence: vi.fn(async () => ({
          recordsByTaskId: new Map(),
          exactRowsByFilePath: new Map(),
        })),
      } as never,
    });

    const snapshot = await source.getSnapshot('demo');

    expect(snapshot).not.toBeNull();
    expect(snapshot?.transcriptFiles).toEqual([]);
    expect(snapshot?.pendingPickupTasks).toEqual([]);
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
    const source = new TeamTaskStallSnapshotSource({
      transcriptSourceLocator: {
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
      taskReader: {
        getTasks: vi.fn(async () => [task]),
        getDeletedTasks: vi.fn(async () => []),
      } as never,
      kanbanManager: {
        getState: vi.fn(async () => ({ teamName: 'demo', tasks: {} })),
      } as never,
      transcriptReader: {
        readFiles: vi.fn(async () => {
          throw new Error('transcript reader should not be called');
        }),
      } as never,
      activityBatchIndexer: {
        buildIndex: vi.fn(() => new Map()),
      } as never,
      freshnessReader: {
        readSignals: vi.fn(async () => new Map()),
      } as never,
      exactRowReader: {
        parseFiles: vi.fn(async () => new Map()),
      } as never,
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      } as never,
      openCodeEvidenceSource: {
        readEvidence: vi.fn(async () => ({
          recordsByTaskId: new Map([['task-open', [openCodeRecord]]]),
          exactRowsByFilePath: new Map([['opencode-runtime:demo:bob', openCodeRows]]),
        })),
      } as never,
    });

    const snapshot = await source.getSnapshot('demo');

    expect(snapshot?.recordsByTaskId.get('task-open')).toEqual([openCodeRecord]);
    expect(snapshot?.exactRowsByFilePath.get('opencode-runtime:demo:bob')).toEqual(openCodeRows);
    expect(snapshot?.transcriptFiles).toEqual([]);
  });

  it('splits the recorded OpenCode lane turn samples into idle-since and active sets', async () => {
    const laneTurnActivity = new OpenCodeLaneTurnActivityRegistry();
    // An idle sample never expires, so it can be as old as the run itself; an
    // active one is evidence only while it is inside the max age.
    const bobIdleSince = isoAgo(6 * ONE_HOUR_MS);
    const carolActiveSince = isoAgo(ONE_MINUTE_MS);
    laneTurnActivity.note({
      teamName: 'demo',
      memberName: 'Bob',
      laneId: 'secondary:opencode:bob',
      state: 'idle',
      observedAt: bobIdleSince,
    });
    laneTurnActivity.note({
      teamName: 'demo',
      memberName: 'Carol',
      laneId: 'secondary:opencode:carol',
      state: 'active',
      observedAt: carolActiveSince,
    });
    laneTurnActivity.note({
      teamName: 'other-team',
      memberName: 'Dave',
      laneId: 'secondary:opencode:dave',
      state: 'active',
      observedAt: isoAgo(ONE_MINUTE_MS),
    });

    const snapshot = await snapshotSourceWithLaneTurnActivity(laneTurnActivity).getSnapshot('demo');

    expect([...(snapshot?.openCodeLaneIdleSinceByMemberName ?? new Map())]).toEqual([
      ['bob', bobIdleSince],
    ]);
    expect([...(snapshot?.openCodeLaneActiveMemberNames ?? new Set())]).toEqual(['carol']);
    expect([...(snapshot?.openCodeLaneActiveSinceByMemberName ?? new Map())]).toEqual([
      ['carol', carolActiveSince],
    ]);
    expect(snapshot?.openCodeLaneStaleActiveSinceByMemberName?.size).toBe(0);
  });

  it('demotes an active lane sample that has outlived the turn-activity max age', async () => {
    const staleActiveSince = isoAgo(getOpenCodeLaneTurnActivityMaxAgeMs() + ONE_MINUTE_MS);
    const laneTurnActivity = new OpenCodeLaneTurnActivityRegistry();
    laneTurnActivity.note({
      teamName: 'demo',
      memberName: 'Carol',
      laneId: 'secondary:opencode:carol',
      state: 'active',
      observedAt: staleActiveSince,
    });

    const snapshot = await snapshotSourceWithLaneTurnActivity(laneTurnActivity).getSnapshot('demo');

    expect([...(snapshot?.openCodeLaneActiveMemberNames ?? new Set())]).toEqual([]);
    // Backdated to the original observation, never to the scan time: demoting
    // to now would restart the pickup clock on every scan.
    expect(snapshot?.openCodeLaneIdleSinceByMemberName?.get('carol')).toBe(staleActiveSince);
    expect(snapshot?.openCodeLaneStaleActiveSinceByMemberName?.get('carol')).toBe(staleActiveSince);
    expect(snapshot?.openCodeLaneActiveSinceByMemberName?.get('carol')).toBeUndefined();
  });

  it('keeps a live lane active when the max-age override is below the ordering floor', async () => {
    // 60 s is a positive integer, so the gate reader accepts it. Applied
    // literally it would publish a member six minutes into an ordinary turn as
    // idle, and the weak-start branch would nudge mid-generation.
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_LANE_TURN_ACTIVITY_MAX_AGE_MS', '60000');
    const activeSince = isoAgo(6 * ONE_MINUTE_MS);
    const laneTurnActivity = new OpenCodeLaneTurnActivityRegistry();
    laneTurnActivity.note({
      teamName: 'demo',
      memberName: 'Carol',
      laneId: 'secondary:opencode:carol',
      state: 'active',
      observedAt: activeSince,
    });

    const snapshot = await snapshotSourceWithLaneTurnActivity(laneTurnActivity).getSnapshot('demo');

    expect([...(snapshot?.openCodeLaneActiveMemberNames ?? new Set())]).toEqual(['carol']);
    expect(snapshot?.openCodeLaneStaleActiveSinceByMemberName?.size).toBe(0);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

function isoAgo(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString();
}

function snapshotSourceWithLaneTurnActivity(
  laneTurnActivity: OpenCodeLaneTurnActivityRegistry
): TeamTaskStallSnapshotSource {
  return new TeamTaskStallSnapshotSource({
    transcriptSourceLocator: {
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
    taskReader: {
      getTasks: vi.fn(() => Promise.resolve([])),
      getDeletedTasks: vi.fn(() => Promise.resolve([])),
    } as never,
    kanbanManager: {
      getState: vi.fn(() => Promise.resolve({ teamName: 'demo', tasks: {} })),
    } as never,
    transcriptReader: { readFiles: vi.fn(() => Promise.resolve(new Map())) } as never,
    activityBatchIndexer: { buildIndex: vi.fn(() => new Map()) } as never,
    freshnessReader: { readSignals: vi.fn(() => Promise.resolve(new Map())) } as never,
    exactRowReader: { parseFiles: vi.fn(() => Promise.resolve(new Map())) } as never,
    membersMetaStore: { getMembers: vi.fn(() => Promise.resolve([])) } as never,
    openCodeEvidenceSource: {
      readEvidence: vi.fn(() =>
        Promise.resolve({
          recordsByTaskId: new Map(),
          exactRowsByFilePath: new Map(),
        })
      ),
    } as never,
    laneTurnActivity,
  });
}
