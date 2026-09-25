import {
  isDecisionlessReviewRecoveryKind,
  parseReviewHistoryRestoreTarget,
} from '@features/review-mutations/main';
import { describe, expect, it } from 'vitest';

describe('review history Restore target policy', () => {
  it('accepts the stable start and exact-action target shapes', () => {
    expect(parseReviewHistoryRestoreTarget({ kind: 'start' })).toEqual({ kind: 'start' });
    expect(
      parseReviewHistoryRestoreTarget({
        kind: 'after-action',
        stack: 'redo',
        actionId: 'action-1',
      })
    ).toEqual({ kind: 'after-action', stack: 'redo', actionId: 'action-1' });
  });

  it.each([
    null,
    [],
    { kind: 'after-action', stack: 'other', actionId: 'action-1' },
    { kind: 'after-action', stack: 'undo', actionId: '' },
    { kind: 'after-action', stack: 'undo', actionId: 'x'.repeat(257) },
  ])('rejects invalid target %j', (value) => {
    expect(() => parseReviewHistoryRestoreTarget(value)).toThrow(
      'Invalid review history restore target'
    );
  });

  it('identifies only decisionless history mutation kinds', () => {
    expect(
      ['undo', 'redo', 'reload-external', 'restore-history'].map(isDecisionlessReviewRecoveryKind)
    ).toEqual([true, true, true, true]);
    expect(isDecisionlessReviewRecoveryKind('restore')).toBe(false);
  });
});
