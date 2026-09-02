import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskStallPolicy } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallPolicy';

import type { TeamTaskStallSnapshot } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';
import type { TeamTask } from '../../../../../src/shared/types';

const UNBLOCKED_AT = '2026-04-19T12:00:00.000Z';
const PAST_THRESHOLD_AT = '2026-04-19T12:08:00.000Z';

const BLOCKER: TeamTask = {
  id: 'task-blocker',
  displayId: 'b10c1234',
  subject: 'Resolved dependency',
  status: 'completed',
};

function createSnapshot(overrides: Partial<TeamTaskStallSnapshot> = {}): TeamTaskStallSnapshot {
  return {
    teamName: 'demo',
    scannedAt: PAST_THRESHOLD_AT,
    projectDir: 'projects/demo',
    projectId: 'project-id',
    leadName: 'team-lead',
    transcriptFiles: [],
    activityReadsEnabled: true,
    exactReadsEnabled: true,
    activeTasks: [],
    deletedTasks: [],
    allTasksById: new Map(),
    inProgressTasks: [],
    reviewOpenTasks: [],
    pendingPickupTasks: [],
    resolvedReviewersByTaskId: new Map(),
    recordsByTaskId: new Map(),
    freshnessByTaskId: new Map(),
    exactRowsByFilePath: new Map(),
    providerByMemberName: new Map([['scout', 'opencode' as const]]),
    ...overrides,
  };
}

function createPendingTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-pickup',
    displayId: 'feed9999',
    subject: 'Summarize the top-3 risks',
    owner: 'Scout',
    status: 'pending',
    blockedBy: ['task-blocker'],
    comments: [
      {
        id: 'dep-resolved-task-blocker-task-pickup',
        author: 'system',
        text: 'Dependency resolved - all blockers for #feed9999 are resolved.',
        createdAt: UNBLOCKED_AT,
        type: 'regular',
      },
    ],
    ...overrides,
  };
}

function snapshotFor(task: TeamTask, overrides: Partial<TeamTaskStallSnapshot> = {}) {
  return createSnapshot({
    activeTasks: [task],
    pendingPickupTasks: [task],
    allTasksById: new Map([
      [task.id, task],
      [BLOCKER.id, BLOCKER],
    ]),
    ...overrides,
  });
}

describe('TeamTaskStallPolicy.evaluatePendingPickup', () => {
  const policy = new TeamTaskStallPolicy();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('alerts once an idle OpenCode owner leaves an unblocked task pending past the threshold', () => {
    const task = createPendingTask();

    const evaluation = policy.evaluatePendingPickup({
      now: new Date(PAST_THRESHOLD_AT),
      task,
      snapshot: snapshotFor(task),
    });

    expect(evaluation).toMatchObject({
      status: 'alert',
      taskId: 'task-pickup',
      memberName: 'Scout',
      branch: 'work',
      signal: 'pending_pickup_after_unblock',
      remediationKind: 'pending_pickup',
      readyAt: UNBLOCKED_AT,
      epochKey: `task-pickup:work:pending_pickup_after_unblock:Scout:${UNBLOCKED_AT}`,
    });
    expect(evaluation.reason).toContain(`all blockers resolved at ${UNBLOCKED_AT}`);
  });

  it('holds the alert until the threshold elapses, to the millisecond', () => {
    const task = createPendingTask();
    const snapshot = snapshotFor(task);

    expect(
      policy.evaluatePendingPickup({
        now: new Date('2026-04-19T12:04:59.999Z'),
        task,
        snapshot,
      })
    ).toMatchObject({ status: 'skip', skipReason: 'below_threshold' });
    expect(
      policy.evaluatePendingPickup({
        now: new Date('2026-04-19T12:05:00.000Z'),
        task,
        snapshot,
      })
    ).toMatchObject({
      status: 'alert',
      signal: 'pending_pickup_after_unblock',
      remediationKind: 'pending_pickup',
    });
  });

  it('restarts the clock when the task was reassigned after the unblock', () => {
    const task = createPendingTask({
      historyEvents: [
        {
          id: 'evt-owner',
          type: 'owner_changed',
          timestamp: '2026-04-19T12:05:00.000Z',
          from: 'Builder',
          to: 'Scout',
        },
      ],
    });

    expect(
      policy.evaluatePendingPickup({
        now: new Date(PAST_THRESHOLD_AT),
        task,
        snapshot: snapshotFor(task),
      })
    ).toMatchObject({ status: 'skip', skipReason: 'below_threshold' });
  });

  it('produces no evaluation traffic when the owner starts the task in time', () => {
    const task = createPendingTask({ status: 'in_progress' });

    expect(
      policy.evaluatePendingPickup({
        now: new Date(PAST_THRESHOLD_AT),
        task,
        snapshot: snapshotFor(task),
      })
    ).toMatchObject({ status: 'skip', taskId: 'task-pickup', skipReason: 'task_not_pending' });
  });

  it('never escalates while a blocker is unfinished, no matter how long it waits', () => {
    const secondBlocker: TeamTask = {
      id: 'task-blocker-2',
      displayId: 'b10c5678',
      subject: 'Still running',
      status: 'in_progress',
    };
    const task = createPendingTask({ blockedBy: ['task-blocker', 'b10c5678'] });
    const snapshot = snapshotFor(task, {
      allTasksById: new Map([
        [task.id, task],
        [BLOCKER.id, BLOCKER],
        [secondBlocker.id, secondBlocker],
      ]),
    });

    // An hour past the threshold, and a day past it: the unfinished blocker is
    // not a timeout, it is a hard gate.
    for (const now of ['2026-04-19T13:08:00.000Z', '2026-04-20T12:08:00.000Z']) {
      expect(policy.evaluatePendingPickup({ now: new Date(now), task, snapshot })).toMatchObject({
        status: 'skip',
        skipReason: 'task_blocked',
      });
    }
  });

  it('resumes escalating once that same blocker completes', () => {
    const secondBlocker: TeamTask = {
      id: 'task-blocker-2',
      displayId: 'b10c5678',
      subject: 'Now finished',
      status: 'completed',
    };
    const task = createPendingTask({ blockedBy: ['task-blocker', 'b10c5678'] });

    expect(
      policy.evaluatePendingPickup({
        now: new Date(PAST_THRESHOLD_AT),
        task,
        snapshot: snapshotFor(task, {
          allTasksById: new Map([
            [task.id, task],
            [BLOCKER.id, BLOCKER],
            [secondBlocker.id, secondBlocker],
          ]),
        }),
      })
    ).toMatchObject({ status: 'alert', signal: 'pending_pickup_after_unblock' });
  });

  describe('tasks that never had a blocker', () => {
    function createNeverBlockedTask(overrides: Partial<TeamTask> = {}): TeamTask {
      return createPendingTask({ blockedBy: [], comments: [], ...overrides });
    }

    it('starts the pickup clock at creation, so the launch shape is covered too', () => {
      const task = createNeverBlockedTask({ createdAt: UNBLOCKED_AT });

      const evaluation = policy.evaluatePendingPickup({
        now: new Date(PAST_THRESHOLD_AT),
        task,
        snapshot: snapshotFor(task),
      });

      expect(evaluation).toMatchObject({
        status: 'alert',
        taskId: 'task-pickup',
        signal: 'pending_pickup_after_unblock',
        remediationKind: 'pending_pickup',
        readyAt: UNBLOCKED_AT,
        epochKey: `task-pickup:work:pending_pickup_after_unblock:Scout:${UNBLOCKED_AT}`,
      });
      expect(evaluation.reason).toContain(`owner has had it since ${UNBLOCKED_AT}`);
    });

    it('does not alert a board created seconds ago', () => {
      const task = createNeverBlockedTask({ createdAt: '2026-04-19T12:07:30.000Z' });

      expect(
        policy.evaluatePendingPickup({
          now: new Date(PAST_THRESHOLD_AT),
          task,
          snapshot: snapshotFor(task),
        })
      ).toMatchObject({ status: 'skip', skipReason: 'below_threshold' });
    });

    it('restarts the clock at the assignment that handed the task to this owner', () => {
      const task = createNeverBlockedTask({
        createdAt: '2026-04-19T11:00:00.000Z',
        historyEvents: [
          {
            id: 'evt-owner',
            type: 'owner_changed',
            timestamp: '2026-04-19T12:05:00.000Z',
            from: 'Builder',
            to: 'Scout',
          },
        ],
      });

      expect(
        policy.evaluatePendingPickup({
          now: new Date(PAST_THRESHOLD_AT),
          task,
          snapshot: snapshotFor(task),
        })
      ).toMatchObject({ status: 'skip', skipReason: 'below_threshold' });
    });

    it('still refuses a clock for a task whose listed blocker never reported resolved', () => {
      const task = createPendingTask({ comments: [], createdAt: '2026-04-19T11:00:00.000Z' });

      expect(
        policy.evaluatePendingPickup({
          now: new Date(PAST_THRESHOLD_AT),
          task,
          snapshot: snapshotFor(task),
        })
      ).toMatchObject({ status: 'skip', skipReason: 'no_unblock_evidence' });
    });
  });

  describe('owner already working', () => {
    const otherTask: TeamTask = {
      id: 'task-other',
      displayId: 'a11ce123',
      subject: 'Already running',
      owner: 'Scout',
      status: 'in_progress',
    };

    it('suppresses the pickup alert while the owner runs another task', () => {
      const task = createPendingTask();

      expect(
        policy.evaluatePendingPickup({
          now: new Date(PAST_THRESHOLD_AT),
          task,
          snapshot: snapshotFor(task, { inProgressTasks: [otherTask] }),
        })
      ).toMatchObject({ status: 'skip', skipReason: 'owner_busy_on_other_task' });
    });

    it('still alerts when the running task belongs to a different member', () => {
      const task = createPendingTask();

      expect(
        policy.evaluatePendingPickup({
          now: new Date(PAST_THRESHOLD_AT),
          task,
          snapshot: snapshotFor(task, {
            inProgressTasks: [{ ...otherTask, owner: 'Builder' }],
          }),
        })
      ).toMatchObject({ status: 'alert', signal: 'pending_pickup_after_unblock' });
    });
  });

  it.each([
    [
      'no dependency-resolved comment at all',
      [
        {
          id: 'comment-owner',
          author: 'Scout',
          text: 'Looking into it.',
          createdAt: UNBLOCKED_AT,
          type: 'regular' as const,
        },
      ],
    ],
    [
      'a dependency-resolved id forged by the owner',
      [
        {
          id: 'dep-resolved-task-blocker-task-pickup',
          author: 'Scout',
          text: 'Dependency resolved.',
          createdAt: UNBLOCKED_AT,
          type: 'regular' as const,
        },
      ],
    ],
    [
      'a dependency-resolved comment for a different task',
      [
        {
          id: 'dep-resolved-task-blocker-task-other',
          author: 'system',
          text: 'Dependency resolved.',
          createdAt: UNBLOCKED_AT,
          type: 'regular' as const,
        },
      ],
    ],
  ])('has no unblock evidence with %s', (_label, comments) => {
    const task = createPendingTask({ comments });

    expect(
      policy.evaluatePendingPickup({
        now: new Date(PAST_THRESHOLD_AT),
        task,
        snapshot: snapshotFor(task),
      })
    ).toMatchObject({ status: 'skip', skipReason: 'no_unblock_evidence' });
  });

  it.each([
    [
      'owner_not_opencode',
      { owner: 'Worker' },
      { providerByMemberName: new Map([['worker', 'anthropic' as const]]) },
    ],
    ['owner_is_lead', { owner: 'team-lead' }, {}],
    ['owner_missing', { owner: '  ' }, {}],
    ['needs_clarification', { needsClarification: 'lead' }, {}],
  ] as const)('skips with %s', (skipReason, taskOverrides, snapshotOverrides) => {
    const task = createPendingTask(taskOverrides);

    expect(
      policy.evaluatePendingPickup({
        now: new Date(PAST_THRESHOLD_AT),
        task,
        snapshot: snapshotFor(task, snapshotOverrides),
      })
    ).toMatchObject({ status: 'skip', skipReason });
  });

  it('is disabled by its env gate', () => {
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_REMEDIATION_ENABLED', '0');
    const task = createPendingTask();

    expect(
      policy.evaluatePendingPickup({
        now: new Date(PAST_THRESHOLD_AT),
        task,
        snapshot: snapshotFor(task),
      })
    ).toMatchObject({ status: 'skip', skipReason: 'pickup_remediation_disabled' });
  });

  it('keeps the epoch key stable across unrelated task churn', () => {
    const task = createPendingTask({ updatedAt: '2026-04-19T12:03:00.000Z' });
    const first = policy.evaluatePendingPickup({
      now: new Date(PAST_THRESHOLD_AT),
      task,
      snapshot: snapshotFor(task),
    });

    const churned = createPendingTask({
      updatedAt: '2026-04-19T12:07:30.000Z',
      comments: [
        ...(task.comments ?? []),
        {
          id: 'comment-noise',
          author: 'Builder',
          text: 'FYI I touched a neighbouring file.',
          createdAt: '2026-04-19T12:07:30.000Z',
          type: 'regular',
        },
      ],
    });
    const second = policy.evaluatePendingPickup({
      now: new Date(PAST_THRESHOLD_AT),
      task: churned,
      snapshot: snapshotFor(churned),
    });

    expect(first.status).toBe('alert');
    expect(second.epochKey).toBe(first.epochKey);
  });
});
