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
});
