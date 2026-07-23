import { isDurableReviewEqual } from '@features/review-mutations';
import { describe, expect, it } from 'vitest';

describe('isDurableReviewEqual', () => {
  it('treats omitted and undefined object properties as the same durable value', () => {
    expect(
      isDurableReviewEqual(
        { decisions: { accepted: true, legacy: undefined } },
        { decisions: { accepted: true } }
      )
    ).toBe(true);
  });

  it('ignores object key order but preserves nested value differences', () => {
    expect(isDurableReviewEqual({ second: 2, first: 1 }, { first: 1, second: 2 })).toBe(true);
    expect(isDurableReviewEqual({ nested: { value: 1 } }, { nested: { value: 2 } })).toBe(false);
  });

  it('keeps array order and sparse entries significant', () => {
    expect(isDurableReviewEqual(['undo', 'redo'], ['redo', 'undo'])).toBe(false);
    expect(isDurableReviewEqual(new Array(1), [undefined])).toBe(false);
  });
});
