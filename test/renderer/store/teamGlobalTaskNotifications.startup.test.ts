import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeFirstGlobalTasksFetchFlag,
  processGlobalTaskNotifications,
  resetGlobalTaskNotificationTrackerForTests,
} from '../../../src/renderer/store/team/teamGlobalTaskNotifications';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type {
  GlobalTask,
  TaskComment,
  TeamMessageNotificationData,
} from '../../../src/shared/types';

const { notify } = vi.hoisted(() => ({
  notify: vi.fn(async (_data: TeamMessageNotificationData) => undefined),
}));
vi.mock('@renderer/api', () => ({ api: { teams: { showMessageNotification: notify } } }));

const START = '2026-09-09T10:00:00.000Z';

function comment(id: string, createdAt = '2026-09-09T08:00:00.000Z'): TaskComment {
  return { id, author: 'removed-teammate', text: id, createdAt, type: 'regular' };
}

function task(comments: TaskComment[] = []): GlobalTask {
  return {
    id: 'test-task',
    teamName: 'sandbox-team',
    teamDisplayName: 'Sandbox Team',
    subject: 'Test task',
    status: 'pending',
    createdAt: '2026-09-09T07:00:00.000Z',
    comments,
  } as GlobalTask;
}

function refresh(oldTasks: GlobalTask[], newTasks: GlobalTask[], isInitialFetch = false): void {
  processGlobalTaskNotifications({
    oldTasks,
    newTasks,
    isInitialFetch,
    appConfig: null,
    teamByName: {},
  });
}

function commentToasts(): TeamMessageNotificationData[] {
  return notify.mock.calls
    .map(([notification]) => notification)
    .filter((notification) => notification.teamEventType === 'task_comment');
}

describe('task comment startup history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    resetGlobalTaskNotificationTrackerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    notify.mockClear();
    resetGlobalTaskNotificationTrackerForTests();
  });

  it('does not toast hours-old comments discovered after an empty startup snapshot', () => {
    refresh([], [], true);
    const historicalTask = task(Array.from({ length: 125 }, (_, i) => comment(`old-${i}`)));
    refresh([], [historicalTask]);
    expect(commentToasts()).toEqual([]);

    vi.setSystemTime('2026-09-09T10:01:00.000Z');
    const updated = task([...historicalTask.comments!, comment('new', new Date().toISOString())]);
    refresh([historicalTask], [updated]);
    expect(commentToasts().map((notification) => notification.target)).toEqual([
      expect.objectContaining({ commentId: 'new' }),
    ]);
  });

  it('silently hydrates old comments on an already visible task', () => {
    const thin = task();
    refresh([], [thin], true);
    const full = task([comment('old')]);
    refresh([thin], [full]);
    expect(commentToasts()).toEqual([]);
  });

  it('keeps fresh comments when an old task first appears with mixed history', () => {
    refresh([], [], true);
    vi.setSystemTime('2026-09-09T10:01:00.000Z');
    refresh([], [task([comment('old'), comment('new', new Date().toISOString())])]);
    expect(commentToasts().map((notification) => notification.target)).toEqual([
      expect.objectContaining({ commentId: 'new' }),
    ]);
  });

  it('detects new comment IDs even when a stale snapshot has the same comment count', () => {
    const before = task([comment('old')]);
    refresh([], [before], true);
    vi.setSystemTime('2026-09-09T10:01:00.000Z');
    const after = task([comment('new', new Date().toISOString())]);
    refresh([before], [after]);
    refresh([after], [before]);
    refresh([before], [after]);
    expect(commentToasts().map((notification) => notification.target)).toEqual([
      expect.objectContaining({ commentId: 'new' }),
    ]);
  });

  it('does not replay history when the renderer notification tracker restarts', () => {
    refresh([], [], true);
    vi.setSystemTime('2026-09-09T10:01:00.000Z');
    const created = task([comment('new', new Date().toISOString())]);
    refresh([], [created]);
    expect(commentToasts()).toHaveLength(1);

    vi.setSystemTime('2026-09-09T11:00:00.000Z');
    resetGlobalTaskNotificationTrackerForTests();
    notify.mockClear();
    refresh([], [], true);
    refresh([], [created]);
    expect(commentToasts()).toEqual([]);
  });

  it('resets the baseline on context changes before either projection or global refresh', () => {
    expect(consumeFirstGlobalTasksFetchFlag()).toBe(true);
    refresh([], [], true);
    const otherContextTask = task([comment('other-context', '2026-09-09T10:30:00.000Z')]);
    vi.setSystemTime('2026-09-09T11:00:00.000Z');
    invalidateContextScopedRequestEpoch();
    refresh([], [otherContextTask]);
    expect(commentToasts()).toEqual([]);
    expect(consumeFirstGlobalTasksFetchFlag()).toBe(true);
    expect(consumeFirstGlobalTasksFetchFlag()).toBe(false);
  });

  it('does not treat malformed history timestamps or old review requests as new events', () => {
    refresh([], [], true);
    refresh(
      [],
      [task([comment('invalid', 'invalid'), { ...comment('review'), type: 'review_request' }])]
    );
    expect(notify.mock.calls.map(([notification]) => notification.teamEventType)).not.toContain(
      'task_review_requested'
    );
    expect(commentToasts()).toEqual([]);
  });

  it('keeps comments created while the first context snapshot is still loading', () => {
    refresh([], [], consumeFirstGlobalTasksFetchFlag());
    vi.setSystemTime('2026-09-09T10:30:00.000Z');
    invalidateContextScopedRequestEpoch();
    const duringLoad = task([comment('during-load', '2026-09-09T10:31:00.000Z')]);

    vi.setSystemTime('2026-09-09T10:32:00.000Z');
    refresh([], [], consumeFirstGlobalTasksFetchFlag());
    vi.setSystemTime('2026-09-09T10:33:00.000Z');
    refresh([], [duringLoad]);
    expect(commentToasts()).toMatchObject([{ target: { commentId: 'during-load' } }]);
  });
});
