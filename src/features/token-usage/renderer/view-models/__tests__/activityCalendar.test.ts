import { describe, expect, it } from 'vitest';

import { buildActivityHeatmapYears, buildActivityStreak } from '../activityCalendar';

import type { TokenUsageActivityDayViewModel } from '../tokenUsageViewModel';

const day = (id: string, tokenValue = 1): TokenUsageActivityDayViewModel => ({
  id,
  label: id,
  tokens: String(tokenValue),
  cost: '$0',
  tokenValue,
  intensity: tokenValue > 0 ? 1 : 0,
  title: id,
});
const now = Date.parse('2026-10-03T12:00:00Z');

describe('current UTC activity streak', () => {
  it('does not present a historical run of active days as a current streak', () => {
    expect(buildActivityStreak([day('2026-06-29'), day('2026-06-30')], now)).toBe(0);
  });

  it('counts backwards from today, ignoring later future buckets and stopping at a gap', () => {
    expect(
      buildActivityStreak(
        [
          day('2026-10-04'),
          day('2026-10-03'),
          day('2026-10-02'),
          day('2026-10-01', 0),
          day('2026-09-30'),
        ],
        now
      )
    ).toBe(2);
  });

  it('allows yesterday until today has activity, including across a year boundary', () => {
    expect(
      buildActivityStreak(
        [day('2025-12-30'), day('2025-12-31'), day('2026-01-01', 0)],
        Date.parse('2026-01-01T01:30:00+02:00')
      )
    ).toBe(2);
    expect(
      buildActivityStreak(
        [day('2025-12-30'), day('2025-12-31'), day('2026-01-01', 0)],
        Date.parse('2026-01-01T12:00:00Z')
      )
    ).toBe(2);
  });

  it('does not count a future-only bucket or an empty calendar', () => {
    expect(buildActivityStreak([day('2026-10-04')], now)).toBe(0);
    expect(buildActivityStreak([], now)).toBe(0);
  });
});

describe('UTC calendar placement', () => {
  it('keeps missing days in their weekday positions and preserves a bounded custom range', () => {
    const [calendar] = buildActivityHeatmapYears([day('2026-10-04'), day('2026-09-30')]);
    expect(calendar.weekCount).toBe(1);
    expect(calendar.cells.map((cell) => cell?.id ?? null)).toEqual([
      null,
      null,
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(calendar.days).toHaveLength(5);
    expect(calendar.days[1].usage).toBeNull();
    expect(calendar.days[4].usage?.tokenValue).toBe(1);
  });

  it('aligns each year with Monday first and pads the final incomplete week', () => {
    const years = buildActivityHeatmapYears([day('2026-01-02'), day('2025-12-30')]);
    expect(years.map((year) => year.year)).toEqual(['2025', '2026']);
    expect(years[0].cells.map((cell) => cell?.id ?? null)).toEqual([
      null,
      '2025-12-30',
      '2025-12-31',
      null,
      null,
      null,
      null,
    ]);
    expect(years[1].cells.map((cell) => cell?.id ?? null)).toEqual([
      null,
      null,
      null,
      '2026-01-01',
      '2026-01-02',
      null,
      null,
    ]);
  });

  it('keeps the leap day between February and March without rebucketing UTC IDs', () => {
    const [year] = buildActivityHeatmapYears([day('2024-02-28'), day('2024-03-01')]);
    expect(year.days.map((entry) => entry.id)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    expect(year.cells[2]?.id).toBe('2024-02-28');
    expect(year.cells[3]?.id).toBe('2024-02-29');
    expect(year.cells[4]?.id).toBe('2024-03-01');
  });
});
