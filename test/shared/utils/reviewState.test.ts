import { describe, expect, it } from 'vitest';

import {
  getKanbanColumnFromReviewState,
  getReviewStateFromTask,
  isNeedsFixTask,
  normalizeReviewState,
} from '../../../src/shared/utils/reviewState';

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
});
