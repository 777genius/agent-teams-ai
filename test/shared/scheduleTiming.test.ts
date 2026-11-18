import { getValidScheduleNextRuns } from '@shared/utils/scheduleTiming';
import { describe, expect, it } from 'vitest';

describe('schedule timing shared across UI and service', () => {
  it('returns future Croner occurrences in a non-preset IANA timezone', () => {
    const next = getValidScheduleNextRuns('0 9 * * 1-5', 'Europe/Chisinau', 3);
    expect(next).toHaveLength(3);
    expect(next.every((date) => date.getTime() > Date.now())).toBe(true);
    expect(next[0].getTime()).toBeLessThan(next[1].getTime());
  });

  it('rejects empty expressions before persistence', () => {
    expect(() => getValidScheduleNextRuns(' ', 'UTC')).toThrow('Cron expression is required');
  });

  it('rejects malformed cron before persistence', () => {
    expect(() => getValidScheduleNextRuns('this is not cron', 'UTC')).toThrow();
  });

  it('rejects invalid and missing IANA timezones', () => {
    expect(() => getValidScheduleNextRuns('0 9 * * *', 'Mars/Olympus')).toThrow(
      'Invalid schedule timezone'
    );
    expect(() => getValidScheduleNextRuns('0 9 * * *', ' ')).toThrow(
      'Schedule timezone is required'
    );
  });
});
