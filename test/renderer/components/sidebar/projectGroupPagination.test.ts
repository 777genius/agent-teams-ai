import {
  PROJECT_GROUP_PAGE_SIZE,
  canProjectGroupShowLess,
  canProjectGroupShowMore,
  getNextProjectGroupVisibleCount,
  getPreviousProjectGroupVisibleCount,
  getProjectGroupVisibleCount,
  syncProjectGroupVisibleCountByKey,
} from '../../../../src/renderer/components/sidebar/projectGroupPagination';
import { describe, expect, it } from 'vitest';

describe('projectGroupPagination', () => {
  it('defaults to the first page and respects small groups', () => {
    expect(getProjectGroupVisibleCount(undefined, 0)).toBe(0);
    expect(getProjectGroupVisibleCount(undefined, 3)).toBe(3);
    expect(getProjectGroupVisibleCount(undefined, 12)).toBe(PROJECT_GROUP_PAGE_SIZE);
  });

  it('expands in steps of five and clamps to the group size', () => {
    let visibleCount = getProjectGroupVisibleCount(undefined, 17);
    expect(visibleCount).toBe(5);

    visibleCount = getNextProjectGroupVisibleCount(visibleCount, 17);
    expect(visibleCount).toBe(10);

    visibleCount = getNextProjectGroupVisibleCount(visibleCount, 17);
    expect(visibleCount).toBe(15);

    visibleCount = getNextProjectGroupVisibleCount(visibleCount, 17);
    expect(visibleCount).toBe(17);

    expect(canProjectGroupShowMore(visibleCount, 17)).toBe(false);
  });

  it('collapses in steps of five and never goes below the first page', () => {
    expect(getPreviousProjectGroupVisibleCount(15, 17)).toBe(10);
    expect(getPreviousProjectGroupVisibleCount(10, 17)).toBe(5);
    expect(getPreviousProjectGroupVisibleCount(5, 17)).toBe(5);

    expect(canProjectGroupShowLess(5, 17)).toBe(false);
    expect(canProjectGroupShowLess(10, 17)).toBe(true);
  });

  it('clamps existing counts when the group shrinks and removes missing groups', () => {
    const previousVisibleCounts = {
      active: 15,
      compact: 7,
      removed: 10,
    };

    expect(
      syncProjectGroupVisibleCountByKey(previousVisibleCounts, [
        { projectKey: 'active', taskCount: 9 },
        { projectKey: 'compact', taskCount: 4 },
      ])
    ).toEqual({
      active: 9,
      compact: 4,
    });
  });

  it('returns the same object when nothing changes', () => {
    const previousVisibleCounts = {
      active: 10,
      compact: 4,
    };

    const nextVisibleCounts = syncProjectGroupVisibleCountByKey(previousVisibleCounts, [
      { projectKey: 'active', taskCount: 12 },
      { projectKey: 'compact', taskCount: 4 },
    ]);

    expect(nextVisibleCounts).toBe(previousVisibleCounts);
  });
});
