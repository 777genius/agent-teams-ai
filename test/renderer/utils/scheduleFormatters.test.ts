import { formatNextRun } from '@renderer/utils/scheduleFormatters';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('localized schedule relative times', () => {
  afterEach(() => vi.useRealTimers());

  it('never reports an overdue 61-second run as two minutes late', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const overdue = new Date(Date.now() - 61_000).toISOString();
    expect(formatNextRun(overdue, 'en')).toMatch(/1\s*min/i);
    expect(formatNextRun(overdue, 'en')).not.toMatch(/2\s*min/i);
  });

  it('uses the selected locale for the next run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(formatNextRun(future, 'ru')).toMatch(/через\s+5\b/i);
  });
});
