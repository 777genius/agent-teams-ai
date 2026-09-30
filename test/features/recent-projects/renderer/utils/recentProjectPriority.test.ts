import { sortRecentProjectPriority } from '@features/recent-projects/renderer/utils/recentProjectPriority';
import { describe, expect, it } from 'vitest';

describe('sortRecentProjectPriority', () => {
  it('keeps the 48-hour open priority and bounds invalid or future activity', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const rows = [
      { name: 'old-open', activityAt: now, openedAt: now - 49 * 60 * 60 * 1000 },
      { name: 'recent-open', activityAt: now - 20 * 60 * 60 * 1000, openedAt: now - 60 * 60 * 1000 },
      { name: 'future', activityAt: now + 10 * 365 * 24 * 60 * 60 * 1000, openedAt: 0 },
      { name: 'invalid', activityAt: Number.NaN, openedAt: 0 },
    ];

    expect(sortRecentProjectPriority(rows, (row) => row, now).map((row) => row.name)).toEqual([
      'recent-open', 'old-open', 'future', 'invalid',
    ]);
    expect(rows.map((row) => row.name)).toEqual([
      'old-open', 'recent-open', 'future', 'invalid',
    ]);
  });
});
