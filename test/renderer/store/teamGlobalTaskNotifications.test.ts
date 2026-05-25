import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeFirstGlobalTasksFetchFlag,
  processGlobalTaskNotifications,
  resetGlobalTaskNotificationTrackerForTests,
} from '../../../src/renderer/store/team/teamGlobalTaskNotifications';

import type { AppConfig } from '../../../src/renderer/types/data';
import type {
  GlobalTask,
  TaskComment,
  TeamMessageNotificationData,
  TeamSummary,
} from '../../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  showMessageNotification: vi.fn(async (_data: unknown) => undefined),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      showMessageNotification: hoisted.showMessageNotification,
    },
  },
}));

function createTask(overrides: Partial<GlobalTask> = {}): GlobalTask {
  return {
    id: 'task-1',
    teamName: 'team-a',
    teamDisplayName: 'Team A',
    subject: 'Ship refactor',
    description: 'Refactor safely',
    status: 'pending',
    owner: 'alice',
    comments: [],
    blockedBy: [],
    updatedAt: '2026-05-22T10:00:00.000Z',
    ...overrides,
  } as GlobalTask;
}

function createComment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: 'c1',
    author: 'bob',
    text: 'Looks good',
    type: 'comment',
    createdAt: '2026-05-22T10:00:00.000Z',
    ...overrides,
  } as TaskComment;
}

function createConfig(
  notifications: Partial<NonNullable<AppConfig['notifications']>> = {}
): AppConfig {
  return {
    notifications: {
      enabled: true,
      notifyOnClarifications: true,
      notifyOnStatusChange: true,
      notifyOnTaskComments: true,
      notifyOnTaskCreated: true,
      notifyOnAllTasksCompleted: true,
      statusChangeStatuses: ['in_progress', 'completed'],
      statusChangeOnlySolo: true,
      ...notifications,
    },
  } as AppConfig;
}

function teamSummary(memberCount = 0): TeamSummary {
  return {
    teamName: 'team-a',
    displayName: 'Team A',
    memberCount,
  } as TeamSummary;
}

function sentNotifications(): TeamMessageNotificationData[] {
  return hoisted.showMessageNotification.mock.calls.map(
    ([payload]) => payload as TeamMessageNotificationData
  );
}

describe('teamGlobalTaskNotifications', () => {
  afterEach(() => {
    hoisted.showMessageNotification.mockClear();
    resetGlobalTaskNotificationTrackerForTests();
  });

  it('tracks the first global tasks fetch as a resettable module flag', () => {
    expect(consumeFirstGlobalTasksFetchFlag()).toBe(true);
    expect(consumeFirstGlobalTasksFetchFlag()).toBe(false);

    resetGlobalTaskNotificationTrackerForTests();

    expect(consumeFirstGlobalTasksFetchFlag()).toBe(true);
  });

  it('seeds initial tasks without sending notifications', () => {
    processGlobalTaskNotifications({
      oldTasks: [],
      newTasks: [
        createTask({
          needsClarification: 'user',
          blockedBy: ['task-2'],
          comments: [createComment({ text: 'Needs review' })],
          status: 'completed',
        }),
      ],
      appConfig: createConfig(),
      teamByName: { 'team-a': teamSummary() },
      isInitialFetch: true,
    });

    expect(hoisted.showMessageNotification).not.toHaveBeenCalled();
  });

  it('emits clarification notifications and respects the per-type toast toggle', () => {
    processGlobalTaskNotifications({
      oldTasks: [createTask()],
      newTasks: [
        createTask({
          needsClarification: 'user',
          comments: [createComment({ text: 'Please clarify' })],
        }),
      ],
      appConfig: createConfig({ notifyOnClarifications: false }),
      teamByName: { 'team-a': teamSummary() },
      isInitialFetch: false,
    });

    expect(sentNotifications()).toMatchObject([
      {
        teamEventType: 'task_clarification',
        from: 'bob',
        body: 'Please clarify',
        suppressToast: true,
        target: {
          kind: 'task',
          teamName: 'team-a',
          taskId: 'task-1',
          commentId: 'c1',
          focus: 'comments',
        },
      },
      {
        teamEventType: 'task_comment',
        from: 'bob',
        body: 'Please clarify',
        suppressToast: false,
        target: {
          kind: 'task',
          teamName: 'team-a',
          taskId: 'task-1',
          commentId: 'c1',
          focus: 'comments',
        },
      },
    ]);
  });

  it('emits status changes only for solo teams when solo filtering is enabled', () => {
    const oldTask = createTask({ status: 'pending' });
    const newTask = createTask({ status: 'in_progress' });

    processGlobalTaskNotifications({
      oldTasks: [oldTask],
      newTasks: [newTask],
      appConfig: createConfig(),
      teamByName: { 'team-a': teamSummary(2) },
      isInitialFetch: false,
    });
    expect(hoisted.showMessageNotification).not.toHaveBeenCalled();

    processGlobalTaskNotifications({
      oldTasks: [oldTask],
      newTasks: [newTask],
      appConfig: createConfig(),
      teamByName: { 'team-a': teamSummary(0) },
      isInitialFetch: false,
    });

    expect(sentNotifications()).toMatchObject([
      {
        teamEventType: 'task_status_change',
        from: 'alice',
        body: 'Ship refactor',
        suppressToast: false,
        target: { kind: 'task', teamName: 'team-a', taskId: 'task-1', focus: 'status' },
      },
    ]);
  });

  it('emits only actionable teammate comments and review requests', () => {
    processGlobalTaskNotifications({
      oldTasks: [createTask({ comments: [] })],
      newTasks: [
        createTask({
          comments: [
            createComment({ id: 'c1', author: 'bob', text: 'Looks blocked' }),
            createComment({ id: 'c2', author: 'user', text: 'My own note' }),
            createComment({
              id: 'c3',
              author: 'reviewer',
              text: 'Review this',
              type: 'review_request',
            }),
          ],
        }),
      ],
      appConfig: createConfig(),
      teamByName: { 'team-a': teamSummary() },
      isInitialFetch: false,
    });

    expect(sentNotifications()).toMatchObject([
      {
        teamEventType: 'task_comment',
        from: 'bob',
        body: 'Looks blocked',
        target: { kind: 'task', teamName: 'team-a', taskId: 'task-1', commentId: 'c1' },
      },
      {
        teamEventType: 'task_review_requested',
        from: 'reviewer',
        body: 'Review this',
        target: { kind: 'task', teamName: 'team-a', taskId: 'task-1', commentId: 'c3' },
      },
    ]);
  });

  it('emits blocked and created task notifications on non-initial updates', () => {
    const existingTask = createTask();
    const newTask = createTask({ id: 'task-3', subject: 'New work' });

    processGlobalTaskNotifications({
      oldTasks: [existingTask],
      newTasks: [createTask({ blockedBy: ['task-2'] }), newTask],
      appConfig: createConfig({ statusChangeStatuses: [] }),
      teamByName: { 'team-a': teamSummary() },
      isInitialFetch: false,
    });

    expect(sentNotifications()).toMatchObject([
      {
        teamEventType: 'task_blocked',
        body: 'Blocked by #task-2',
        target: { kind: 'task', teamName: 'team-a', taskId: 'task-1', focus: 'detail' },
      },
      {
        teamEventType: 'task_created',
        body: 'Refactor safely',
        target: { kind: 'task', teamName: 'team-a', taskId: 'task-3', focus: 'detail' },
      },
    ]);
  });

  it('emits all-completed once when a team transitions into final tasks', () => {
    const oldTasks = [
      createTask({ id: 'task-1', status: 'completed' }),
      createTask({ id: 'task-2', status: 'in_progress' }),
    ];
    const newTasks = [
      createTask({ id: 'task-1', status: 'completed' }),
      createTask({ id: 'task-2', status: 'completed' }),
    ];

    processGlobalTaskNotifications({
      oldTasks,
      newTasks,
      appConfig: createConfig({ statusChangeStatuses: [] }),
      teamByName: { 'team-a': teamSummary() },
      isInitialFetch: false,
    });
    processGlobalTaskNotifications({
      oldTasks,
      newTasks,
      appConfig: createConfig({ statusChangeStatuses: [] }),
      teamByName: { 'team-a': teamSummary() },
      isInitialFetch: false,
    });

    expect(sentNotifications()).toMatchObject([
      {
        teamEventType: 'all_tasks_completed',
        from: 'system',
        to: 'user',
        summary: 'All 2 tasks completed',
        target: { kind: 'team', teamName: 'team-a', section: 'tasks' },
      },
    ]);
  });
});
