import { describe, expect, it } from 'vitest';

import {
  buildTaskChangePresenceKey,
  buildTaskChangeRequestOptions,
  deriveTaskSince,
} from '@renderer/utils/taskChangeRequest';

describe('taskChangeRequest', () => {
  it('derives since from the earliest known task timestamp with grace window', () => {
    const since = deriveTaskSince({
      id: 't1',
      owner: 'alice',
      status: 'completed',
      createdAt: '2026-03-01T10:05:00.000Z',
      updatedAt: '2026-03-01T12:00:00.000Z',
      workIntervals: [{ startedAt: '2026-03-01T10:10:00.000Z' }],
      historyEvents: [
        {
          id: 'evt-1',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-03-01T10:00:00.000Z',
        },
      ],
    });

    expect(since).toBe('2026-03-01T09:58:00.000Z');
  });

  it('builds canonical task change request options', () => {
    const options = buildTaskChangeRequestOptions(
      {
        id: 't1',
        owner: 'alice',
        status: 'completed',
        createdAt: '2026-03-01T10:05:00.000Z',
        updatedAt: '2026-03-01T12:00:00.000Z',
        workIntervals: [{ startedAt: '2026-03-01T10:10:00.000Z' }],
        historyEvents: [],
      },
      { summaryOnly: true }
    );

    expect(options).toEqual({
      owner: 'alice',
      status: 'completed',
      intervals: [{ startedAt: '2026-03-01T10:10:00.000Z' }],
      since: '2026-03-01T10:03:00.000Z',
      stateBucket: 'completed',
      summaryOnly: true,
    });
  });

  it('uses scope inputs for presence keys', () => {
    const base = {
      owner: 'alice',
      status: 'completed',
      intervals: [{ startedAt: '2026-03-01T10:10:00.000Z' }],
      since: '2026-03-01T10:03:00.000Z',
      stateBucket: 'completed' as const,
    };

    expect(buildTaskChangePresenceKey('team-a', '1', base)).not.toBe(
      buildTaskChangePresenceKey('team-a', '1', { ...base, owner: 'bob' })
    );
    expect(buildTaskChangePresenceKey('team-a', '1', base)).not.toBe(
      buildTaskChangePresenceKey('team-a', '1', { ...base, stateBucket: 'review' })
    );
  });
});
