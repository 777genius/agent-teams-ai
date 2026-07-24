import {
  sanitizeTaskChangeOptions,
  sanitizeTeamTaskChangeSummaryRequests,
} from '@features/change-review/main';
import { describe, expect, it } from 'vitest';

describe('review query policy', () => {
  it('rejects malformed task options without inventing defaults', () => {
    expect(sanitizeTaskChangeOptions()).toBeUndefined();
    expect(sanitizeTaskChangeOptions(null)).toBeUndefined();
    expect(sanitizeTaskChangeOptions('owner')).toBeUndefined();
  });

  it('keeps only supported task option fields and valid intervals', () => {
    expect(
      sanitizeTaskChangeOptions({
        owner: 'worker',
        status: 'completed',
        since: '2026-07-24T10:00:00.000Z',
        intervals: [
          { startedAt: '2026-07-24T10:00:00.000Z' },
          {
            startedAt: '2026-07-24T11:00:00.000Z',
            completedAt: '2026-07-24T12:00:00.000Z',
          },
          { startedAt: 123 },
          { startedAt: 'valid', completedAt: false },
          null,
        ],
        stateBucket: 'approved',
        summaryOnly: true,
        forceFresh: 'yes',
        ignored: 'value',
      })
    ).toEqual({
      owner: 'worker',
      status: 'completed',
      since: '2026-07-24T10:00:00.000Z',
      intervals: [
        { startedAt: '2026-07-24T10:00:00.000Z' },
        {
          startedAt: '2026-07-24T11:00:00.000Z',
          completedAt: '2026-07-24T12:00:00.000Z',
        },
      ],
      stateBucket: 'approved',
      summaryOnly: true,
      forceFresh: false,
    });
  });

  it('trims, de-duplicates, and bounds team summary requests exactly', () => {
    const requests = [
      null,
      { taskId: 42 },
      { taskId: '   ' },
      { taskId: ' task-1 ', options: { summaryOnly: true } },
      { taskId: 'task-1', options: { forceFresh: true } },
      ...Array.from({ length: 205 }, (_, index) => ({
        taskId: `task-${index + 2}`,
      })),
    ];

    const sanitized = sanitizeTeamTaskChangeSummaryRequests(requests);

    expect(sanitized).toHaveLength(201);
    expect(sanitized[0]).toEqual({
      taskId: 'task-1',
      options: {
        owner: undefined,
        status: undefined,
        since: undefined,
        intervals: undefined,
        stateBucket: undefined,
        summaryOnly: true,
        forceFresh: false,
      },
    });
    expect(sanitized.at(-1)).toEqual({
      taskId: 'task-201',
      options: undefined,
    });
  });

  it('inspects no more than the first 1,000 raw summary requests', () => {
    const requests = [
      ...Array.from({ length: 1_000 }, () => null),
      { taskId: 'outside-raw-limit' },
    ];

    expect(sanitizeTeamTaskChangeSummaryRequests(requests)).toEqual([]);
  });
});
