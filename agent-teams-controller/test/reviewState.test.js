const { getEffectiveReviewState, getReviewStateFromHistory } = require('../src/internal/reviewState.js');

describe('controller review-state adapter', () => {
  it('preserves the completed needsFix correction even without history', () => {
    expect(getEffectiveReviewState({ status: 'completed', reviewState: 'needsFix' }, null)).toEqual({
      state: 'needsFix',
      source: 'task_review_state',
    });
  });

  it('honors a persisted review reset over older approval and placement', () => {
    const task = {
      status: 'completed',
      reviewState: 'approved',
      historyEvents: [
        { type: 'review_approved', to: 'approved' },
        { type: 'review_reset', from: 'approved', to: 'none' },
      ],
    };
    expect(getReviewStateFromHistory(task)).toEqual({ state: 'none', source: 'history_review_reset' });
    expect(getEffectiveReviewState(task, { column: 'approved' })).toEqual({
      state: 'none',
      source: 'history_review_reset',
    });
  });
});
