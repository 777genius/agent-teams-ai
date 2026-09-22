import { describe, expect, it } from 'vitest';

import {
  formatTaskUpdatedRelativeTime,
  getMeaningfulTaskUpdatedAt,
} from '../../../../src/renderer/components/sidebar/sidebarTaskTime';

const NOW_MS = Date.parse('2026-04-18T12:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

describe('sidebar task relative time', () => {
  it.each([
    { elapsedMs: -HOUR_MS, expected: 'now' },
    { elapsedMs: 0, expected: 'now' },
    { elapsedMs: MINUTE_MS - 1, expected: 'now' },
    { elapsedMs: MINUTE_MS, expected: '1 min. ago' },
    { elapsedMs: 2 * MINUTE_MS, expected: '2 min. ago' },
    { elapsedMs: HOUR_MS - 1, expected: '59 min. ago' },
    { elapsedMs: HOUR_MS, expected: '1 hr. ago' },
    { elapsedMs: 24 * HOUR_MS - 1, expected: '23 hr. ago' },
    { elapsedMs: 24 * HOUR_MS, expected: '1 day ago' },
    { elapsedMs: 48 * HOUR_MS - 1, expected: '1 day ago' },
    { elapsedMs: 48 * HOUR_MS, expected: '2 days ago' },
  ])('formats the $elapsedMs ms boundary as $expected', ({ elapsedMs, expected }) => {
    const updated = new Date(NOW_MS - elapsedMs);
    expect(formatTaskUpdatedRelativeTime(updated, 'en', NOW_MS)).toBe(expected);
  });

  it('uses locale-native relative phrases without concatenating an update prefix', () => {
    const updated = new Date(NOW_MS - 5 * MINUTE_MS);

    expect(formatTaskUpdatedRelativeTime(updated, 'ru', NOW_MS)).toBe('5 мин. назад');
    expect(formatTaskUpdatedRelativeTime(updated, 'ja', NOW_MS)).toBe('5 分前');
  });

  it('suppresses creation-time churn but accepts a meaningful update at 60 seconds', () => {
    const createdAt = '2026-04-18T10:00:00.000Z';

    expect(
      getMeaningfulTaskUpdatedAt({
        createdAt,
        updatedAt: '2026-04-18T10:00:59.999Z',
      })
    ).toBeNull();
    expect(
      getMeaningfulTaskUpdatedAt({
        createdAt,
        updatedAt: '2026-04-18T10:01:00.000Z',
      })?.toISOString()
    ).toBe('2026-04-18T10:01:00.000Z');
  });

  it('ignores missing and invalid update timestamps', () => {
    expect(getMeaningfulTaskUpdatedAt({ createdAt: undefined, updatedAt: undefined })).toBeNull();
    expect(getMeaningfulTaskUpdatedAt({ createdAt: undefined, updatedAt: 'invalid' })).toBeNull();
  });
});
