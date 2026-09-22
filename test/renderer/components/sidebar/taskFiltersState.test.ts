import { describe, expect, it } from 'vitest';

import { taskMatchesStatus } from '../../../../src/renderer/components/sidebar/taskFiltersState';

describe('taskFiltersState', () => {
  it('treats needsFix as distinct from normal todo/done buckets', () => {
    const pendingNeedsFixTask = { status: 'pending', reviewState: 'needsFix' as const };
    const completedNeedsFixTask = { status: 'completed', reviewState: 'needsFix' as const };
    const activeNeedsFixTask = { status: 'in_progress', reviewState: 'needsFix' as const };
    const normalPendingTask = { status: 'pending', reviewState: 'none' as const };

    expect(taskMatchesStatus(pendingNeedsFixTask, new Set(['needs_fix']))).toBe(true);
    expect(taskMatchesStatus(completedNeedsFixTask, new Set(['needs_fix']))).toBe(true);
    expect(taskMatchesStatus(activeNeedsFixTask, new Set(['needs_fix']))).toBe(true);
    expect(taskMatchesStatus(pendingNeedsFixTask, new Set(['todo']))).toBe(false);
    expect(taskMatchesStatus(completedNeedsFixTask, new Set(['done']))).toBe(false);
    expect(taskMatchesStatus(activeNeedsFixTask, new Set(['in_progress']))).toBe(false);
    expect(taskMatchesStatus(normalPendingTask, new Set(['todo']))).toBe(true);
  });

  it('treats completed review workflow as review, not done', () => {
    const completedReviewTask = {
      status: 'completed',
      reviewState: 'review' as const,
      kanbanColumn: 'review' as const,
    };

    expect(taskMatchesStatus(completedReviewTask, new Set(['review']))).toBe(true);
    expect(taskMatchesStatus(completedReviewTask, new Set(['done']))).toBe(false);
  });

  it('lets current workflow overlay win over stale needsFix in filters', () => {
    const approvedTask = {
      status: 'in_progress',
      reviewState: 'needsFix' as const,
      kanbanColumn: 'approved' as const,
    };
    const reviewTask = {
      status: 'completed',
      reviewState: 'needsFix' as const,
      kanbanColumn: 'review' as const,
    };

    expect(taskMatchesStatus(approvedTask, new Set(['approved']))).toBe(true);
    expect(taskMatchesStatus(approvedTask, new Set(['needs_fix']))).toBe(false);
    expect(taskMatchesStatus(reviewTask, new Set(['review']))).toBe(true);
    expect(taskMatchesStatus(reviewTask, new Set(['needs_fix']))).toBe(false);
  });
});
