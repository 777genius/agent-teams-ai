import { describe, expect, it } from 'vitest';

import {
  createCustomTokenUsageDateRange,
  createDefaultTokenUsageDateRange,
  createPresetTokenUsageDateRange,
  tokenUsageDateKeyFromDate,
  tokenUsageDateRangeToCalendarRange,
  tokenUsageSnapshotRequestForDateRange,
} from '../tokenUsageDateRange';

const NOW = new Date(2026, 5, 30, 12, 0, 0);

describe('tokenUsageDateRange', () => {
  it('defaults to all-time usage', () => {
    const range = createDefaultTokenUsageDateRange(NOW);

    expect(range.presetId).toBe('all-time');
    expect(range.fromDateKey).toBeUndefined();
    expect(range.toDateKey).toBeUndefined();
    expect(tokenUsageSnapshotRequestForDateRange(range)).toBeUndefined();
  });

  it('builds last month and all-time ranges', () => {
    const lastMonth = createPresetTokenUsageDateRange('last-month', NOW);
    const allTime = createPresetTokenUsageDateRange('all-time', NOW);

    expect(lastMonth.fromDateKey).toBe('2026-05-01');
    expect(lastMonth.toDateKey).toBe('2026-05-31');
    expect(tokenUsageSnapshotRequestForDateRange(allTime)).toBeUndefined();
  });

  it('sorts custom range boundaries', () => {
    const range = createCustomTokenUsageDateRange('2026-07-05', '2026-06-29');

    expect(range.fromDateKey).toBe('2026-06-29');
    expect(range.toDateKey).toBe('2026-07-05');
    expect(range.label).toBe('Custom range');
  });

  it('converts values for calendar range selection', () => {
    const range = createCustomTokenUsageDateRange('2026-06-29', '2026-07-05');
    const calendarRange = tokenUsageDateRangeToCalendarRange(range);

    expect(calendarRange?.from).toBeInstanceOf(Date);
    expect(calendarRange?.to).toBeInstanceOf(Date);
    expect(tokenUsageDateKeyFromDate(calendarRange?.from ?? NOW)).toBe('2026-06-29');
    expect(tokenUsageDateKeyFromDate(calendarRange?.to ?? NOW)).toBe('2026-07-05');
  });
});
