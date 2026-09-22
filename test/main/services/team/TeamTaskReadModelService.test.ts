import { describe, expect, it, vi } from 'vitest';

import { buildTaskChangePresenceDescriptor } from '../../../../src/main/services/team/taskChangePresenceUtils';
import {
  type TeamTaskReadModelConfigReaderPort,
  type TeamTaskReadModelKanbanReaderPort,
  type TeamTaskReadModelReaderPort,
  TeamTaskReadModelService,
} from '../../../../src/main/services/team/TeamTaskReadModelService';

import type {
  KanbanState,
  TeamConfig,
  TeamSummary,
  TeamTask,
} from '../../../../src/shared/types/team';

function buildTeamSummary(overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    teamName: 'my-team',
    displayName: 'My team',
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity: null,
    projectPath: '/repo',
    ...overrides,
  };
}

function buildTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    subject: 'Read the task',
    status: 'pending',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:05:00.000Z',
    ...overrides,
  };
}

interface ReadModelHarnessOptions {
  taskReader?: TeamTaskReadModelReaderPort;
  configReader?: TeamTaskReadModelConfigReaderPort;
  kanbanReader?: TeamTaskReadModelKanbanReaderPort;
  readTask?: (teamName: string, taskId: string) => TeamTask | null | undefined;
}

function createHarness(options: ReadModelHarnessOptions = {}) {
  const invalidateGlobalTaskProjectionCache = vi.fn();
  const logDebug = vi.fn();
  const taskReader: TeamTaskReadModelReaderPort = options.taskReader ?? {
    getTasks: vi.fn(async () => []),
    getAllTasks: vi.fn(async () => []),
    getDeletedTasks: vi.fn(async () => []),
  };
  const configReader: TeamTaskReadModelConfigReaderPort = options.configReader ?? {
    listTeams: vi.fn(async () => [buildTeamSummary()]),
    getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
  };
  const kanbanReader: TeamTaskReadModelKanbanReaderPort = options.kanbanReader ?? {
    getState: vi.fn(async (teamName) => ({ teamName, reviewers: [], tasks: {} })),
  };
  const readTask = vi.fn(options.readTask ?? (() => null));
  const service = new TeamTaskReadModelService({
    taskReader,
    configReader,
    kanbanReader,
    readTask,
    invalidateGlobalTaskProjectionCache,
    logDebug,
  });
  return {
    configReader,
    invalidateGlobalTaskProjectionCache,
    kanbanReader,
    logDebug,
    readTask,
    service,
    taskReader,
  };
}

describe('TeamTaskReadModelService', () => {
  it('prefers task projection snapshots, preserves the fallback reader, and delegates deleted reads', async () => {
    const projectionTask = buildTask({ id: 'projection' });
    const fallbackTask = buildTask({ id: 'fallback' });
    const getTasksProjectionSnapshot = vi.fn(async () => [projectionTask]);
    const getTasks = vi.fn(async () => [fallbackTask]);
    const getDeletedTasks = vi.fn(async () => [buildTask({ id: 'deleted', status: 'deleted' })]);
    const harness = createHarness({
      taskReader: {
        getTasks,
        getTasksProjectionSnapshot,
        getAllTasks: vi.fn(async () => []),
        getDeletedTasks,
      },
    });

    await expect(harness.service.readTasksForUiSnapshot('my-team')).resolves.toEqual([
      projectionTask,
    ]);
    await expect(harness.service.getDeletedTasks('my-team')).resolves.toEqual([
      expect.objectContaining({ id: 'deleted' }),
    ]);
    expect(getTasksProjectionSnapshot).toHaveBeenCalledWith('my-team');
    expect(getTasks).not.toHaveBeenCalled();
    expect(getDeletedTasks).toHaveBeenCalledWith('my-team');

    const fallbackHarness = createHarness({
      taskReader: {
        getTasks,
        getAllTasks: vi.fn(async () => []),
        getDeletedTasks,
      },
    });
    await expect(fallbackHarness.service.readTasksForUiSnapshot('my-team')).resolves.toEqual([
      fallbackTask,
    ]);
  });

  it('invokes the injected global projection invalidator exactly once per request', () => {
    const harness = createHarness();

    harness.service.invalidateGlobalTaskProjectionCache();

    expect(harness.invalidateGlobalTaskProjectionCache).toHaveBeenCalledTimes(1);
  });

  it('reads full task details through the callback and preserves kanban review compatibility', async () => {
    const task = buildTask({
      status: 'completed',
      reviewState: 'none',
      historyEvents: [
        {
          id: 'created',
          type: 'task_created',
          status: 'completed',
          timestamp: '2026-06-01T10:00:00.000Z',
        },
      ],
    });
    const getState = vi.fn(
      async (): Promise<KanbanState> => ({
        teamName: 'my-team',
        reviewers: ['carol'],
        tasks: {
          'task-1': {
            column: 'review',
            reviewer: ' carol ',
            movedAt: '2026-06-01T10:10:00.000Z',
          },
        },
      })
    );
    const harness = createHarness({
      readTask: (_teamName, taskId) => (taskId === task.id ? task : null),
      kanbanReader: { getState },
    });

    await expect(harness.service.getTask('my-team', task.id)).resolves.toMatchObject({
      id: task.id,
      reviewState: 'review',
      kanbanColumn: 'review',
      reviewer: 'carol',
    });
    await expect(harness.service.getTask('my-team', 'missing')).resolves.toBeNull();
    expect(harness.readTask).toHaveBeenNthCalledWith(1, 'my-team', task.id);
    expect(harness.readTask).toHaveBeenNthCalledWith(2, 'my-team', 'missing');
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('keeps task details available when kanban state is temporarily unreadable', async () => {
    const task = buildTask({
      status: 'completed',
      reviewState: 'approved',
      historyEvents: [
        {
          id: 'approved',
          type: 'review_approved',
          timestamp: '2026-06-01T10:10:00.000Z',
          from: 'review',
          to: 'approved',
          actor: 'carol',
        },
      ],
    });
    const harness = createHarness({
      readTask: () => task,
      kanbanReader: {
        getState: vi.fn(async () => {
          throw new Error('kanban unavailable');
        }),
      },
    });

    await expect(harness.service.getTask('my-team', task.id)).resolves.toMatchObject({
      id: task.id,
      reviewState: 'approved',
      kanbanColumn: 'approved',
      reviewer: null,
    });
  });

  it('uses current kanban state ahead of stale persisted review state', () => {
    const harness = createHarness();
    const task = buildTask({
      status: 'completed',
      reviewState: 'approved',
    });

    expect(
      harness.service.attachKanbanCompatibility(task, {
        column: 'review',
        reviewer: 'carol',
        movedAt: '2026-06-01T10:11:00.000Z',
      })
    ).toMatchObject({
      reviewState: 'review',
      kanbanColumn: 'review',
      reviewer: 'carol',
    });
  });

  it('builds global projections from snapshot ports with lightweight comments and config metadata', async () => {
    const listTeams = vi.fn(async () => [buildTeamSummary()]);
    const getConfigSnapshot = vi.fn(
      async (): Promise<TeamConfig> => ({
        name: ' Config display name ',
        members: [{ name: 'team-lead', cwd: '/lead-repo' }],
        deletedAt: '2026-06-01T11:00:00.000Z',
      })
    );
    const rawTask = {
      ...buildTask({
        subject: 'S'.repeat(400),
        status: 'completed',
        reviewState: 'none',
        comments: [
          {
            id: 'comment-1',
            author: 'alice',
            text: 'C'.repeat(200),
            createdAt: '2026-06-01T10:06:00.000Z',
            type: 'regular',
          },
        ],
      }),
      teamName: 'my-team',
    };
    const getAllTasksProjectionSnapshot = vi.fn(async () => [rawTask]);
    const getAllTasks = vi.fn(async () => []);
    const harness = createHarness({
      configReader: {
        listTeams,
        getConfigSnapshot,
      },
      taskReader: {
        getTasks: vi.fn(async () => []),
        getAllTasks,
        getAllTasksProjectionSnapshot,
        getDeletedTasks: vi.fn(async () => []),
      },
      kanbanReader: {
        getState: vi.fn(
          async (): Promise<KanbanState> => ({
            teamName: 'my-team',
            reviewers: [],
            tasks: {
              'task-1': {
                column: 'review',
                reviewer: 'carol',
                movedAt: '2026-06-01T10:10:00.000Z',
              },
            },
          })
        ),
      },
    });

    const tasks = await harness.service.getAllTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'task-1',
      subject: 'S'.repeat(300),
      projectPath: '/lead-repo',
      reviewState: 'review',
      kanbanColumn: 'review',
      teamDisplayName: 'Config display name',
      teamDeleted: true,
      comments: [
        {
          id: 'comment-1',
          text: 'C'.repeat(120),
        },
      ],
    });
    expect(getAllTasksProjectionSnapshot).toHaveBeenCalledTimes(1);
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(getConfigSnapshot).toHaveBeenCalledWith('my-team');
    expect(listTeams).not.toHaveBeenCalled();
  });

  it('falls back atomically to team summaries when any direct team config is unavailable', async () => {
    const listTeams = vi.fn(async () => [
      buildTeamSummary({
        teamName: 'team-a',
        displayName: 'Team A from list',
        projectPath: '/team-a-list',
      }),
      buildTeamSummary({
        teamName: 'team-b',
        displayName: 'Team B from list',
        projectPath: '/team-b-list',
      }),
    ]);
    const getConfigSnapshot = vi.fn(async (teamName: string) =>
      teamName === 'team-a'
        ? ({ name: 'Team A from config', projectPath: '/team-a-config' } as TeamConfig)
        : null
    );
    const harness = createHarness({
      configReader: { listTeams, getConfigSnapshot },
      taskReader: {
        getTasks: vi.fn(async () => []),
        getAllTasks: vi.fn(async () => [
          { ...buildTask({ id: 'a' }), teamName: 'team-a' },
          { ...buildTask({ id: 'b' }), teamName: 'team-b' },
        ]),
        getDeletedTasks: vi.fn(async () => []),
      },
    });

    const tasks = await harness.service.getAllTasks();

    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'a',
          teamDisplayName: 'Team A from list',
          projectPath: '/team-a-list',
        }),
        expect.objectContaining({
          id: 'b',
          teamDisplayName: 'Team B from list',
          projectPath: '/team-b-list',
        }),
      ])
    );
    expect(getConfigSnapshot).toHaveBeenCalledTimes(2);
    expect(listTeams).toHaveBeenCalledTimes(1);
  });

  it('caps global task work before kanban reads and retains the newest 500 tasks', async () => {
    const rawTasks = Array.from({ length: 501 }, (_, index) => ({
      ...buildTask({
        id: `task-${index}`,
        updatedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, index)).toISOString(),
      }),
      teamName: index === 0 ? 'old-team' : 'my-team',
    }));
    const getState = vi.fn(async (teamName: string) => ({
      teamName,
      reviewers: [],
      tasks: {},
    }));
    const harness = createHarness({
      configReader: {
        listTeams: vi.fn(async () => [
          buildTeamSummary(),
          buildTeamSummary({ teamName: 'old-team', displayName: 'Old team' }),
        ]),
      },
      taskReader: {
        getTasks: vi.fn(async () => []),
        getAllTasks: vi.fn(async () => rawTasks),
        getDeletedTasks: vi.fn(async () => []),
      },
      kanbanReader: { getState },
    });

    const tasks = await harness.service.getAllTasks();

    expect(tasks).toHaveLength(500);
    expect(tasks.some((task) => task.id === 'task-0')).toBe(false);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledWith('my-team');
  });

  it('loads matching change presence and rejects stale signatures or generations', () => {
    const harness = createHarness();
    const task = harness.service.attachKanbanCompatibility(
      buildTask({
        status: 'completed',
        owner: 'alice',
        workIntervals: [{ startedAt: '2026-06-01T10:01:00.000Z' }],
        historyEvents: [],
      })
    );
    const descriptor = buildTaskChangePresenceDescriptor({
      createdAt: task.createdAt,
      owner: task.owner,
      status: task.status,
      intervals: task.workIntervals,
      reviewState: task.reviewState,
      historyEvents: task.historyEvents,
      kanbanColumn: task.kanbanColumn,
    });
    const snapshot = {
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'generation-1',
    };
    const matchingIndex = {
      version: 2 as const,
      teamName: 'my-team',
      projectFingerprint: snapshot.projectFingerprint,
      logSourceGeneration: snapshot.logSourceGeneration,
      writtenAt: '2026-06-01T10:10:00.000Z',
      entries: {
        [task.id]: {
          taskId: task.id,
          taskSignature: descriptor.taskSignature,
          presence: 'has_changes' as const,
          writtenAt: '2026-06-01T10:10:00.000Z',
          logSourceGeneration: snapshot.logSourceGeneration,
        },
      },
    };

    expect(
      harness.service.resolveTaskChangePresenceMap([task], true, matchingIndex, snapshot)
    ).toEqual({ 'task-1': 'has_changes' });
    expect(
      harness.service.resolveTaskChangePresenceMap(
        [task],
        true,
        {
          ...matchingIndex,
          entries: {
            [task.id]: {
              ...matchingIndex.entries[task.id],
              taskSignature: 'stale-signature',
            },
          },
        },
        snapshot
      )
    ).toEqual({ 'task-1': 'unknown' });
    expect(
      harness.service.resolveTaskChangePresenceMap(
        [task],
        true,
        { ...matchingIndex, logSourceGeneration: 'stale-generation' },
        snapshot
      )
    ).toEqual({ 'task-1': 'unknown' });
  });

  it('keeps presence cache loading lazy until a complete tracker snapshot exists', async () => {
    const load = vi.fn(async () => null);
    const harness = createHarness();
    harness.service.setTaskChangePresenceServices(
      { load },
      {
        getSnapshot: vi.fn(() => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: null,
        })),
        enableTracking: vi.fn(async () => undefined),
        disableTracking: vi.fn(async () => undefined),
      }
    );

    const read = harness.service.startTaskChangePresenceRead('my-team');

    expect(read.enabled).toBe(true);
    await expect(read.presenceIndex).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('returns lightweight presence without unrelated reads and tolerates task and kanban failures', async () => {
    const load = vi.fn(async () => ({
      version: 2 as const,
      teamName: 'my-team',
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'generation-1',
      writtenAt: '2026-06-01T10:10:00.000Z',
      entries: {},
    }));
    const taskReader = {
      getTasks: vi.fn(async () => {
        throw new Error('task read failed');
      }),
      getAllTasks: vi.fn(async () => []),
      getDeletedTasks: vi.fn(async () => []),
    };
    const harness = createHarness({
      taskReader,
      kanbanReader: {
        getState: vi.fn(async () => {
          throw new Error('kanban read failed');
        }),
      },
    });
    harness.service.setTaskChangePresenceServices(
      { load },
      {
        getSnapshot: vi.fn(() => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'generation-1',
        })),
        enableTracking: vi.fn(async () => undefined),
        disableTracking: vi.fn(async () => undefined),
      }
    );

    await expect(harness.service.getTaskChangePresence('my-team')).resolves.toEqual({});
    expect(load).toHaveBeenCalledWith('my-team');
    expect(taskReader.getAllTasks).not.toHaveBeenCalled();
  });

  it('rejects presence reads for a missing team before loading tasks or kanban', async () => {
    const getTasks = vi.fn(async () => []);
    const getState = vi.fn(async () => ({ teamName: 'missing', reviewers: [], tasks: {} }));
    const harness = createHarness({
      configReader: {
        listTeams: vi.fn(async () => []),
        getConfig: vi.fn(async () => null),
      },
      taskReader: {
        getTasks,
        getAllTasks: vi.fn(async () => []),
        getDeletedTasks: vi.fn(async () => []),
      },
      kanbanReader: { getState },
    });

    await expect(harness.service.getTaskChangePresence('missing')).rejects.toThrow(
      'Team not found: missing'
    );
    expect(getTasks).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it('delegates tracking enable and disable and keeps failures best-effort', async () => {
    const enableTracking = vi.fn(async () => {
      throw new Error('enable failed');
    });
    const disableTracking = vi.fn(async () => {
      throw new Error('disable failed');
    });
    const harness = createHarness();
    harness.service.setTaskChangePresenceServices(
      { load: vi.fn(async () => null) },
      {
        enableTracking,
        disableTracking,
      }
    );

    harness.service.setTaskChangePresenceTracking('my-team', true);
    harness.service.setTaskChangePresenceTracking('my-team', false);
    await vi.waitFor(() => expect(harness.logDebug).toHaveBeenCalledTimes(2));

    expect(enableTracking).toHaveBeenCalledWith('my-team', 'change_presence');
    expect(disableTracking).toHaveBeenCalledWith('my-team', 'change_presence');
    expect(harness.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start change-presence tracking for my-team')
    );
    expect(harness.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Failed to stop change-presence tracking for my-team')
    );
  });
});
