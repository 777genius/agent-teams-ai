import { afterEach, describe, expect, it, vi } from 'vitest';

import { filterChunksByWorkIntervals } from '@renderer/components/team/members/MemberLogsTab';

function makeChunk(id: string, start: string, end: string) {
  return {
    id,
    startTime: new Date(start),
    endTime: new Date(end),
  } as never;
}

describe('MemberLogsTab work interval filtering', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not treat malformed empty completedAt as an open interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T11:00:00.000Z'));
    const chunks = [
      makeChunk('near-start', '2026-05-08T09:59:50.000Z', '2026-05-08T10:00:05.000Z'),
      makeChunk('late', '2026-05-08T10:30:00.000Z', '2026-05-08T10:30:05.000Z'),
    ];

    const filtered = filterChunksByWorkIntervals(chunks, [
      { startedAt: '2026-05-08T10:00:00.000Z', completedAt: '' },
    ]);

    expect(filtered?.map((chunk) => chunk.id)).toEqual(['near-start']);
  });

  it('clamps completedAt before startedAt to a closed start window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T11:00:00.000Z'));
    const chunks = [
      makeChunk('near-start', '2026-05-08T09:59:50.000Z', '2026-05-08T10:00:05.000Z'),
      makeChunk('late', '2026-05-08T10:30:00.000Z', '2026-05-08T10:30:05.000Z'),
    ];

    const filtered = filterChunksByWorkIntervals(chunks, [
      {
        startedAt: '2026-05-08T10:00:00.000Z',
        completedAt: '2026-05-08T09:59:00.000Z',
      },
    ]);

    expect(filtered?.map((chunk) => chunk.id)).toEqual(['near-start']);
  });

  it('keeps undefined completedAt as the only open interval shape', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T11:00:00.000Z'));
    const chunks = [
      makeChunk('near-start', '2026-05-08T09:59:50.000Z', '2026-05-08T10:00:05.000Z'),
      makeChunk('late', '2026-05-08T10:30:00.000Z', '2026-05-08T10:30:05.000Z'),
    ];

    const filtered = filterChunksByWorkIntervals(chunks, [
      { startedAt: '2026-05-08T10:00:00.000Z' },
    ]);

    expect(filtered?.map((chunk) => chunk.id)).toEqual(['near-start', 'late']);
  });
});
