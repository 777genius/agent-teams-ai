import { describe, expect, it } from 'vitest';

import {
  getKanbanColumnFromReviewState,
  getReviewStateFromTask,
  isNeedsFixTask,
  normalizeReviewState,
} from '../../../src/shared/utils/reviewState';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskApproved,
} from '../../../src/shared/utils/teamTaskState';

describe('reviewState utils', () => {
  it('normalizes needsFix as a first-class review state', () => {
    expect(normalizeReviewState('needsFix')).toBe('needsFix');
    expect(getReviewStateFromTask({ reviewState: 'needsFix' })).toBe('needsFix');
    expect(isNeedsFixTask({ reviewState: 'needsFix' })).toBe(true);
  });

  it('does not map needsFix to a kanban column', () => {
    expect(getKanbanColumnFromReviewState('needsFix')).toBeUndefined();
  });

  it('derives review state from review_started history event', () => {
    expect(
      getReviewStateFromTask({
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'review_started',
            from: 'none',
            to: 'review',
            actor: 'alice',
          },
        ],
      })
    ).toBe('review');
  });

  it('resets derived review state after work resumes following requested changes', () => {
    expect(
      getReviewStateFromTask({
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'review_changes_requested',
            from: 'review',
            to: 'needsFix',
            actor: 'reviewer',
          },
          {
            id: '2',
            timestamp: '2026-01-01T00:01:00Z',
            type: 'status_changed',
            from: 'pending',
            to: 'in_progress',
            actor: 'owner',
          },
        ],
      })
    ).toBe('none');
  });

  it('keeps needsFix across the pending status written by review_request_changes', () => {
    expect(
      getReviewStateFromTask({
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'review_changes_requested',
            from: 'review',
            to: 'needsFix',
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
    ).toBe('needsFix');
  });

  it('clears approved state when a task is explicitly reopened to pending', () => {
    expect(
      getReviewStateFromTask({
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
    ).toBe('none');
  });

  it('lets canonical pending status clear stale review history when no reopen event exists', () => {
    expect(
      getReviewStateFromTask({
        status: 'pending',
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'review_approved',
            from: 'review',
            to: 'approved',
            actor: 'alice',
          },
        ],
      })
    ).toBe('none');
    expect(
      getReviewStateFromTask({
        status: 'pending',
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'review_requested',
            from: 'none',
            to: 'review',
            reviewer: 'bob',
          },
        ],
      })
    ).toBe('none');
  });

  it('falls back to persisted legacy reviewState when history has no review signal', () => {
    expect(
      getReviewStateFromTask({
        reviewState: 'approved',
        status: 'completed',
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'task_created',
            status: 'completed',
          },
        ],
      })
    ).toBe('approved');
  });

  it('ignores stale terminal review fallback on active or deleted statuses', () => {
    expect(getReviewStateFromTask({ reviewState: 'approved', status: 'pending' })).toBe('none');
    expect(getReviewStateFromTask({ reviewState: 'review', status: 'in_progress' })).toBe('none');
    expect(getReviewStateFromTask({ kanbanColumn: 'approved', status: 'deleted' })).toBe('none');
  });

  it('keeps legacy pending needsFix as actionable fallback', () => {
    expect(getReviewStateFromTask({ reviewState: 'needsFix', status: 'pending' })).toBe('needsFix');
  });

  it('keeps completed needsFix as a non-final review correction state', () => {
    expect(getReviewStateFromTask({ reviewState: 'needsFix', status: 'completed' })).toBe(
      'needsFix'
    );
    expect(
      getReviewStateFromTask({
        status: 'completed',
        historyEvents: [
          {
            id: '1',
            timestamp: '2026-01-01T00:00:00Z',
            type: 'review_changes_requested',
            from: 'review',
            to: 'needsFix',
            actor: 'reviewer',
          },
        ],
      })
    ).toBe('needsFix');
  });

  it('uses persisted review reset as the current-cycle boundary despite stale fallback', () => {
    const task = {
      status: 'completed',
      reviewState: 'approved' as const,
      historyEvents: [
        {
          id: '1',
          timestamp: '2026-01-01T00:00:00Z',
          type: 'review_approved' as const,
          from: 'review' as const,
          to: 'approved' as const,
        },
        {
          id: '2',
          timestamp: '2026-01-01T00:01:00Z',
          type: 'review_reset' as const,
          from: 'approved' as const,
          to: 'none' as const,
          reason: 'move_back_to_done' as const,
        },
      ],
    };
    expect(getReviewStateFromTask(task)).toBe('none');
    expect(getTeamTaskWorkflowColumn(task)).toBeUndefined();
    expect(isTeamTaskApproved(task)).toBe(false);
  });

  it('does not promote malformed persisted lifecycle events into review decisions', () => {
    expect(
      getReviewStateFromTask({
        status: 'completed',
        reviewState: 'none',
        historyEvents: [
          { id: 'approval', type: 'review_approved', timestamp: '2026-01-01T00:00:00Z' },
        ],
      })
    ).toBe('none');
    expect(
      getReviewStateFromTask({
        status: 'completed',
        reviewState: 'none',
        historyEvents: [
          {
            id: 'request',
            type: 'review_requested',
            to: 'review',
            timestamp: '2026-01-01T00:00:00Z',
          },
          {
            id: 'invalid-changes',
            type: 'review_changes_requested',
            to: 'none',
            timestamp: '2026-01-01T00:01:00Z',
          },
        ],
      })
    ).toBe('review');
  });
});
