import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type TaskLifecycleAnalyticsReporter,
  TaskLifecycleAnalyticsTracker,
} from '../../../../../src/features/team-task-board/core/application/TaskLifecycleAnalyticsTracker';

import type {
  CreateTaskRequest,
  TeamTask,
  TeamViewSnapshot,
} from '../../../../../src/shared/types';

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    subject: 'Task',
    status: 'in_progress',
    owner: 'alice',
    createdAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:05.000Z',
    comments: [],
    attachments: [],
    historyEvents: [],
    ...overrides,
  } as TeamTask;
}

function createSnapshot(task: TeamTask): TeamViewSnapshot {
  return {
    teamName: 'team-a',
    config: { name: 'Team A' },
    tasks: [task],
    members: [{ name: 'alice', providerId: 'xai' }],
    messages: [],
    processes: [],
    kanbanState: { teamName: 'team-a', reviewers: [], tasks: {} },
  } as unknown as TeamViewSnapshot;
}

function createReporter(): TaskLifecycleAnalyticsReporter {
  return {
    recordTaskCreate: vi.fn(),
    recordTaskEnd: vi.fn(),
    recordTaskFirstOutput: vi.fn(),
  };
}

describe('TaskLifecycleAnalyticsTracker', () => {
  let reporter: TaskLifecycleAnalyticsReporter;
  let now: ReturnType<typeof vi.fn>;
  let tracker: TaskLifecycleAnalyticsTracker;

  beforeEach(() => {
    reporter = createReporter();
    now = vi.fn(() => 1_500);
    tracker = new TaskLifecycleAnalyticsTracker(reporter, { now });
  });

  it('records only derived creation metadata and tracks the first-output context', () => {
    const task = createTask();
    const request: CreateTaskRequest = {
      subject: 'secret subject',
      prompt: 'secret prompt',
      owner: 'alice',
      promptTaskRefs: [{ taskId: '0', displayId: '0', teamName: 'team-a' }],
    };

    tracker.recordCreatedTask('team-a', task, request, createSnapshot(task), 1_000);

    expect(reporter.recordTaskCreate).toHaveBeenCalledWith({
      source: 'dialog',
      targetType: 'member',
      hasAttachments: false,
      hasTaskRefs: true,
      promptLength: 13,
      teamSize: 1,
    });
    expect(JSON.stringify(vi.mocked(reporter.recordTaskCreate).mock.calls)).not.toContain('secret');
  });

  it('records a teammate first output once and does not leak comment text', () => {
    const initialTask = createTask();
    tracker.recordCreatedTask(
      'team-a',
      initialTask,
      { subject: 'Task', owner: 'alice' },
      createSnapshot(initialTask),
      1_000
    );
    const taskWithOutput = createTask({
      comments: [
        {
          id: 'comment-1',
          author: 'alice',
          text: 'private response',
          createdAt: '2026-07-23T10:00:06.000Z',
          type: 'regular',
        },
      ],
    });
    const next = createSnapshot(taskWithOutput);

    tracker.recordSnapshotTransitions('team-a', createSnapshot(initialTask), next);
    tracker.recordSnapshotTransitions('team-a', next, next);

    expect(reporter.recordTaskFirstOutput).toHaveBeenCalledTimes(1);
    expect(reporter.recordTaskFirstOutput).toHaveBeenCalledWith({
      targetType: 'member',
      durationMs: 500,
      provider: 'xai',
      teamSize: 1,
      hasAttachments: false,
      hasTaskRefs: false,
    });
    expect(JSON.stringify(vi.mocked(reporter.recordTaskFirstOutput).mock.calls)).not.toContain(
      'private response'
    );
  });

  it('ignores user and lead comments as teammate first output', () => {
    const initialTask = createTask();
    tracker.recordCreatedTask(
      'team-a',
      initialTask,
      { subject: 'Task', owner: 'alice' },
      createSnapshot(initialTask),
      1_000
    );
    const next = createSnapshot(
      createTask({
        comments: [
          {
            id: 'comment-user',
            author: 'user',
            text: 'user comment',
            createdAt: '2026-07-23T10:00:06.000Z',
            type: 'regular',
          },
          {
            id: 'comment-lead',
            author: 'team-lead',
            text: 'lead comment',
            createdAt: '2026-07-23T10:00:07.000Z',
            type: 'regular',
          },
        ],
      })
    );

    tracker.recordSnapshotTransitions('team-a', createSnapshot(initialTask), next);

    expect(reporter.recordTaskFirstOutput).not.toHaveBeenCalled();
  });

  it('records a completed transition once with review and duration metadata', () => {
    const previous = createSnapshot(createTask());
    const completed = createSnapshot(
      createTask({
        status: 'completed',
        reviewState: 'review',
        workIntervals: [
          {
            startedAt: '2026-07-23T10:00:00.000Z',
            completedAt: '2026-07-23T10:10:00.000Z',
          },
        ],
      })
    );

    tracker.recordSnapshotTransitions('team-a', previous, completed);
    tracker.recordSnapshotTransitions('team-a', previous, completed);

    expect(reporter.recordTaskEnd).toHaveBeenCalledTimes(1);
    expect(reporter.recordTaskEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'completed',
        provider: 'xai',
        reviewRequired: true,
        errorClass: 'none',
      })
    );
  });

  it('clears pending first-output context for a deleted team', () => {
    const task = createTask();
    tracker.recordCreatedTask(
      'team-a',
      task,
      { subject: 'Task', owner: 'alice' },
      createSnapshot(task),
      1_000
    );
    tracker.clearTeam('team-a');

    tracker.recordSnapshotTransitions(
      'team-a',
      createSnapshot(task),
      createSnapshot(
        createTask({
          comments: [
            {
              id: 'comment-1',
              author: 'alice',
              text: 'output',
              createdAt: '2026-07-23T10:00:06.000Z',
              type: 'regular',
            },
          ],
        })
      )
    );

    expect(reporter.recordTaskFirstOutput).not.toHaveBeenCalled();
  });
});
