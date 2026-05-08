import { describe, expect, it } from 'vitest';

import {
  getTeamTaskWorkflowColumn,
  isTeamTaskActivelyWorked,
  isTeamTaskFinalForCompletionNotification,
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
  isTeamTaskTerminalForActionableWork,
  selectCurrentActiveTeamTask,
} from '../../../../src/main/services/team/teamTaskActiveState';

import type { TeamTaskWithKanban } from '../../../../src/shared/types';

describe('isTeamTaskActivelyWorked', () => {
  it('accepts only canonical active work', () => {
    expect(
      isTeamTaskActivelyWorked({
        status: 'in_progress',
        reviewState: 'none',
      })
    ).toBe(true);
  });

  it('rejects terminal and approved task states', () => {
    expect(
      isTeamTaskActivelyWorked({
        status: 'completed',
        reviewState: 'none',
      })
    ).toBe(false);
    expect(
      isTeamTaskActivelyWorked({
        status: 'deleted',
        reviewState: 'none',
        deletedAt: '2026-05-06T00:00:00.000Z',
      })
    ).toBe(false);
    expect(
      isTeamTaskActivelyWorked({
        status: 'deleted',
        reviewState: 'approved',
        deletedAt: '2026-05-06T00:00:00.000Z',
      })
    ).toBe(false);
    expect(
      isTeamTaskActivelyWorked({
        status: 'in_progress',
        reviewState: 'approved',
      })
    ).toBe(false);
    expect(
      isTeamTaskActivelyWorked({
        status: 'in_progress',
        reviewState: 'none',
        kanbanColumn: 'approved',
      })
    ).toBe(false);
    expect(
      isTeamTaskActivelyWorked({
        status: 'in_progress',
        reviewState: 'none',
        kanbanColumn: 'review',
      })
    ).toBe(false);
  });

  it('does not treat current kanban review as terminal even with stale approved review state', () => {
    const task = {
      status: 'in_progress',
      reviewState: 'approved',
      kanbanColumn: 'review',
    };

    expect(isTeamTaskFinishedForDependency(task)).toBe(false);
    expect(isTeamTaskTerminalForActionableWork(task)).toBe(false);
  });

  it('does not treat completed review workflow as dependency-finished', () => {
    const task = {
      status: 'completed',
      reviewState: 'review',
      kanbanColumn: 'review',
    };

    expect(isTeamTaskFinishedForDependency(task)).toBe(false);
    expect(isTeamTaskTerminalForActionableWork(task)).toBe(false);
  });

  it('does not treat needsFix tasks as dependency-finished or actionable-terminal', () => {
    const task = {
      status: 'completed',
      reviewState: 'needsFix',
    };

    expect(isTeamTaskFinishedForDependency(task)).toBe(false);
    expect(isTeamTaskTerminalForActionableWork(task)).toBe(false);
  });

  it('lets current approved overlay win over stale needsFix for dependency and actionable terminal checks', () => {
    const task = {
      status: 'in_progress',
      reviewState: 'needsFix',
      kanbanColumn: 'approved',
    };

    expect(isTeamTaskFinishedForDependency(task)).toBe(true);
    expect(isTeamTaskTerminalForActionableWork(task)).toBe(true);
  });
});

describe('getTeamTaskWorkflowColumn', () => {
  it('keeps stale in-progress approved overlay visible as approved', () => {
    expect(
      getTeamTaskWorkflowColumn({
        status: 'in_progress',
        reviewState: 'none',
        kanbanColumn: 'approved',
      })
    ).toBe('approved');
  });

  it('does not treat reopened pending tasks as approved from stale kanban overlay', () => {
    expect(
      getTeamTaskWorkflowColumn({
        status: 'pending',
        reviewState: 'none',
        kanbanColumn: 'approved',
      })
    ).toBeUndefined();
  });

  it('does not treat reopened pending tasks as review or approved from stale review state', () => {
    expect(
      getTeamTaskWorkflowColumn({
        status: 'pending',
        reviewState: 'review',
      })
    ).toBeUndefined();
    expect(
      getTeamTaskWorkflowColumn({
        status: 'pending',
        reviewState: 'approved',
      })
    ).toBeUndefined();
  });

  it('prefers current kanban approved over stale review state', () => {
    expect(
      getTeamTaskWorkflowColumn({
        status: 'in_progress',
        reviewState: 'review',
        kanbanColumn: 'approved',
      })
    ).toBe('approved');
  });

  it('prefers current kanban review over stale approved review state', () => {
    expect(
      getTeamTaskWorkflowColumn({
        status: 'in_progress',
        reviewState: 'approved',
        kanbanColumn: 'review',
      })
    ).toBe('review');
  });

  it('does not treat deleted tasks as approved from stale review state', () => {
    expect(
      getTeamTaskWorkflowColumn({
        status: 'deleted',
        reviewState: 'approved',
        deletedAt: '2026-05-06T00:00:00.000Z',
      })
    ).toBeUndefined();
  });
});

describe('isTeamTaskNeedsFixActionable', () => {
  it('treats needsFix as actionable only when no current workflow overlay wins', () => {
    expect(
      isTeamTaskNeedsFixActionable({
        status: 'completed',
        reviewState: 'needsFix',
      })
    ).toBe(true);
    expect(
      isTeamTaskNeedsFixActionable({
        status: 'in_progress',
        reviewState: 'needsFix',
        kanbanColumn: 'approved',
      })
    ).toBe(false);
    expect(
      isTeamTaskNeedsFixActionable({
        status: 'completed',
        reviewState: 'needsFix',
        kanbanColumn: 'review',
      })
    ).toBe(false);
  });
});

describe('isTeamTaskFinalForCompletionNotification', () => {
  it('does not notify all-completed while a completed task is still in review', () => {
    expect(
      isTeamTaskFinalForCompletionNotification({
        status: 'completed',
        reviewState: 'review',
        kanbanColumn: 'review',
      })
    ).toBe(false);
  });

  it('does not notify all-completed while a task needs fixes', () => {
    expect(
      isTeamTaskFinalForCompletionNotification({
        status: 'completed',
        reviewState: 'needsFix',
      })
    ).toBe(false);
  });

  it('treats approved overlay and plain completed tasks as final for completion notifications', () => {
    expect(
      isTeamTaskFinalForCompletionNotification({
        status: 'in_progress',
        reviewState: 'needsFix',
        kanbanColumn: 'approved',
      })
    ).toBe(true);
    expect(
      isTeamTaskFinalForCompletionNotification({
        status: 'completed',
        reviewState: 'none',
      })
    ).toBe(true);
    expect(
      isTeamTaskFinalForCompletionNotification({
        status: 'deleted',
        reviewState: 'needsFix',
        deletedAt: '2026-05-06T00:00:00.000Z',
      })
    ).toBe(true);
  });
});

describe('selectCurrentActiveTeamTask', () => {
  it('selects the latest active work interval instead of the first display id', () => {
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 'task-a',
        displayId: '1',
        subject: 'Older active task',
        status: 'in_progress',
        workIntervals: [{ startedAt: '2026-05-06T10:00:00.000Z' }],
      },
      {
        id: 'task-b',
        displayId: '2',
        subject: 'Newer active task',
        status: 'in_progress',
        workIntervals: [{ startedAt: '2026-05-06T11:00:00.000Z' }],
      },
    ];

    const selected = selectCurrentActiveTeamTask(tasks);

    expect(selected?.id).toBe('task-b');
  });

  it('ignores approved active-looking tasks when selecting current work', () => {
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 'task-approved',
        displayId: '1',
        subject: 'Approved stale task',
        status: 'in_progress',
        reviewState: 'none',
        kanbanColumn: 'approved',
        workIntervals: [{ startedAt: '2026-05-06T12:00:00.000Z' }],
      },
      {
        id: 'task-active',
        displayId: '2',
        subject: 'Active task',
        status: 'in_progress',
        reviewState: 'none',
        workIntervals: [{ startedAt: '2026-05-06T10:00:00.000Z' }],
      },
    ];

    const selected = selectCurrentActiveTeamTask(tasks);

    expect(selected?.id).toBe('task-active');
  });

  it('falls back to history when the open work interval timestamp is invalid', () => {
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 'task-a',
        displayId: '1',
        subject: 'Corrupt interval but newer history',
        status: 'in_progress',
        workIntervals: [{ startedAt: 'not-a-date' }],
        historyEvents: [
          {
            id: 'event-a',
            type: 'status_changed',
            from: 'pending',
            to: 'in_progress',
            timestamp: '2026-05-06T12:00:00.000Z',
          },
        ],
      },
      {
        id: 'task-b',
        displayId: '2',
        subject: 'Older active task',
        status: 'in_progress',
        workIntervals: [{ startedAt: '2026-05-06T11:00:00.000Z' }],
      },
    ];

    const selected = selectCurrentActiveTeamTask(tasks);

    expect(selected?.id).toBe('task-a');
  });

  it('does not treat malformed empty completedAt as an open work interval', () => {
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 'task-a',
        displayId: '1',
        subject: 'Malformed closed interval',
        status: 'in_progress',
        workIntervals: [{ startedAt: '2026-05-06T13:00:00.000Z', completedAt: '' }],
        historyEvents: [
          {
            id: 'event-a',
            type: 'status_changed',
            from: 'pending',
            to: 'in_progress',
            timestamp: '2026-05-06T10:00:00.000Z',
          },
        ],
      },
      {
        id: 'task-b',
        displayId: '2',
        subject: 'Real active task',
        status: 'in_progress',
        workIntervals: [{ startedAt: '2026-05-06T11:00:00.000Z' }],
      },
    ];

    const selected = selectCurrentActiveTeamTask(tasks);

    expect(selected?.id).toBe('task-b');
  });
});
