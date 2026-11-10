import { describe, expect, it } from 'vitest';

import { isNearBottom } from '../../../src/renderer/hooks/useAutoScrollBottom';

describe('useAutoScrollBottom helpers', () => {
  it('returns true when distance from bottom is within threshold', () => {
    expect(isNearBottom(850, 1000, 100, 50)).toBe(true);
  });

  it('returns false when distance from bottom exceeds threshold', () => {
    expect(isNearBottom(700, 1000, 100, 50)).toBe(false);
  });
});
