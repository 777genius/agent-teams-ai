import { describe, expect, it } from 'vitest';

import {
  calculateTaskImplementationEventDuration,
  calculateTaskImplementationDuration,
  formatTaskImplementationDuration,
  shouldShowTaskImplementationDuration,
} from '@shared/utils/taskWorkDuration';

describe('taskWorkDuration', () => {
  it('sums completed intervals and the current in-progress interval', () => {
    const duration = calculateTaskImplementationDuration(
      {
        status: 'in_progress',
        workIntervals: [
          {
            startedAt: '2026-05-08T10:00:00.000Z',
            completedAt: '2026-05-08T10:02:30.000Z',
          },
          { startedAt: '2026-05-08T10:05:00.000Z' },
        ],
      },
      Date.parse('2026-05-08T10:07:00.000Z')
    );

    expect(duration).toEqual({
      elapsedMs: 270_000,
      hasRunningInterval: true,
      countedIntervalCount: 2,
    });
    expect(shouldShowTaskImplementationDuration(duration)).toBe(true);
  });

  it('does not keep an open interval running after the task leaves in progress', () => {
    const duration = calculateTaskImplementationDuration(
      {
        status: 'completed',
        workIntervals: [
          {
            startedAt: '2026-05-08T10:00:00.000Z',
            completedAt: '2026-05-08T10:02:00.000Z',
          },
          { startedAt: '2026-05-08T10:05:00.000Z' },
        ],
      },
      Date.parse('2026-05-08T10:30:00.000Z')
    );

    expect(duration).toEqual({
      elapsedMs: 120_000,
      hasRunningInterval: false,
      countedIntervalCount: 1,
    });
  });

  it('does not treat empty completedAt strings as running implementation time', () => {
    const duration = calculateTaskImplementationDuration(
      {
        status: 'in_progress',
        workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z', completedAt: '' }],
      },
      Date.parse('2026-05-08T10:30:00.000Z')
    );

    expect(duration).toEqual({
      elapsedMs: 0,
      hasRunningInterval: false,
      countedIntervalCount: 0,
    });

    expect(
      calculateTaskImplementationEventDuration(
        {
          status: 'in_progress',
          workIntervals: [{ startedAt: '2026-05-08T10:00:00.000Z', completedAt: '' }],
        },
        {
          id: 'event-started',
          timestamp: '2026-05-08T10:00:00.000Z',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
        },
        Date.parse('2026-05-08T10:30:00.000Z')
      )
    ).toBeNull();
  });

  it('merges overlapping intervals to avoid double counting malformed data', () => {
    const duration = calculateTaskImplementationDuration(
      {
        status: 'completed',
        workIntervals: [
          {
            startedAt: '2026-05-08T10:00:00.000Z',
            completedAt: '2026-05-08T10:10:00.000Z',
          },
          {
            startedAt: '2026-05-08T10:05:00.000Z',
            completedAt: '2026-05-08T10:12:00.000Z',
          },
        ],
      },
      Date.parse('2026-05-08T10:30:00.000Z')
    );

    expect(duration.elapsedMs).toBe(720_000);
    expect(duration.countedIntervalCount).toBe(2);
  });

  it('matches a closed interval to the status transition that ended implementation', () => {
    const duration = calculateTaskImplementationEventDuration(
      {
        status: 'completed',
        workIntervals: [
          {
            startedAt: '2026-05-08T10:00:00.000Z',
            completedAt: '2026-05-08T10:02:30.000Z',
          },
        ],
      },
      {
        id: 'event-completed',
        timestamp: '2026-05-08T10:02:32.000Z',
        type: 'status_changed',
        from: 'in_progress',
        to: 'completed',
      }
    );

    expect(duration).toEqual({ elapsedMs: 150_000, running: false });
  });

  it('shows a running interval only on the event that started the active implementation', () => {
    const task = {
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-05-08T10:05:00.000Z' }],
    };

    expect(
      calculateTaskImplementationEventDuration(
        task,
        {
          id: 'event-started',
          timestamp: '2026-05-08T10:05:00.000Z',
          type: 'status_changed',
          from: 'completed',
          to: 'in_progress',
        },
        Date.parse('2026-05-08T10:07:30.000Z')
      )
    ).toEqual({ elapsedMs: 150_000, running: true });

    expect(
      calculateTaskImplementationEventDuration(
        task,
        {
          id: 'event-created',
          timestamp: '2026-05-08T10:00:00.000Z',
          type: 'task_created',
          status: 'pending',
        },
        Date.parse('2026-05-08T10:07:30.000Z')
      )
    ).toBeNull();
  });

  it('does not derive transition durations from history gaps without a matching work interval', () => {
    const duration = calculateTaskImplementationEventDuration(
      {
        status: 'completed',
        workIntervals: [
          {
            startedAt: '2026-05-08T10:00:00.000Z',
            completedAt: '2026-05-08T10:02:30.000Z',
          },
        ],
      },
      {
        id: 'event-comment',
        timestamp: '2026-05-08T10:20:00.000Z',
        type: 'status_changed',
        from: 'in_progress',
        to: 'completed',
      }
    );

    expect(duration).toBeNull();
  });

  it('formats seconds, minutes, and hours for compact UI labels', () => {
    expect(formatTaskImplementationDuration(42_900)).toBe('42s');
    expect(formatTaskImplementationDuration(65_000)).toBe('1m 05s');
    expect(formatTaskImplementationDuration(7_260_000)).toBe('2h 01m');
  });
});
