import { describe, expect, it } from 'vitest';

import {
  getTaskChangeStateBucket,
  isTaskChangeSummaryCacheable,
} from '../../../src/shared/utils/taskChangeState';

describe('taskChangeState utils', () => {
  it('falls back to persisted legacy reviewState when history has no review signal', () => {
    const bucket = getTaskChangeStateBucket({
      status: 'completed',
      reviewState: 'approved',
      historyEvents: [
        {
          id: '1',
          timestamp: '2026-01-01T00:00:00Z',
          type: 'task_created',
          status: 'completed',
        },
      ],
    });

    expect(bucket).toBe('approved');
    expect(isTaskChangeSummaryCacheable(bucket)).toBe(true);
  });

  it('falls back to the kanban overlay when history has no review signal', () => {
    expect(
      getTaskChangeStateBucket({
        status: 'completed',
        kanbanColumn: 'review',
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'task_created',
            status: 'completed',
          },
        ],
      })
    ).toBe('review');
  });

  it('keeps explicit pending reopen as active after approval', () => {
    expect(
      getTaskChangeStateBucket({
        status: 'pending',
        reviewState: 'approved',
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'review_approved',
            from: 'review',
            to: 'approved',
            actor: 'alice',
          },
          {
            id: '2',
            timestamp: '2026-01-01T00:01:00Z',
            type: 'status_changed',
            from: 'completed',
            to: 'pending',
            actor: 'alice',
          },
        ],
      })
    ).toBe('active');
  });

  it('treats in-progress tasks approved through kanban overlay as approved', () => {
    const bucket = getTaskChangeStateBucket({
      status: 'in_progress',
      kanbanColumn: 'approved',
    });

    expect(bucket).toBe('approved');
    expect(isTaskChangeSummaryCacheable(bucket)).toBe(true);
  });

  it('does not treat pending tasks with stale approved kanban overlay as approved', () => {
    expect(
      getTaskChangeStateBucket({
        status: 'pending',
        kanbanColumn: 'approved',
      })
    ).toBe('active');
  });

  it('does not treat pending tasks with stale review kanban overlay as review', () => {
    expect(
      getTaskChangeStateBucket({
        status: 'pending',
        kanbanColumn: 'review',
      })
    ).toBe('active');
  });

  it('lets current kanban review overlay win over stale approved review state', () => {
    expect(
      getTaskChangeStateBucket({
        status: 'completed',
        reviewState: 'approved',
        kanbanColumn: 'review',
      })
    ).toBe('review');
  });

  it('does not cache completed tasks that still need fixes', () => {
    const bucket = getTaskChangeStateBucket({
      status: 'completed',
      reviewState: 'needsFix',
    });

    expect(bucket).toBe('active');
    expect(isTaskChangeSummaryCacheable(bucket)).toBe(false);
  });

  it('lets current approved overlay win over stale needsFix for change summary caching', () => {
    const bucket = getTaskChangeStateBucket({
      status: 'completed',
      reviewState: 'needsFix',
      kanbanColumn: 'approved',
    });

    expect(bucket).toBe('approved');
    expect(isTaskChangeSummaryCacheable(bucket)).toBe(true);
  });
});
