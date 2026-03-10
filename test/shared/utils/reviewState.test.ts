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
});
