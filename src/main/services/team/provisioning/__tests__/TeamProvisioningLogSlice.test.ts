import { describe, expect, it } from 'vitest';

import { extractLogsTail, sliceClaudeLogs } from '../TeamProvisioningLogSlice';

describe('TeamProvisioningLogSlice', () => {
  describe('extractLogsTail', () => {
    it('returns undefined when there is no combined output', () => {
      expect(extractLogsTail(undefined, undefined)).toBeUndefined();
      expect(extractLogsTail('', '   ')).toBeUndefined();
    });

    it('returns the combined trimmed output', () => {
      const tail = extractLogsTail('out line', 'err line');
      expect(tail).toContain('out line');
      expect(tail).toContain('err line');
    });

    it('caps the tail to the requested max chars (keeps the newest bytes)', () => {
      const big = 'x'.repeat(500);
      const tail = extractLogsTail(big, undefined, 100);
      expect(tail).toBe('x'.repeat(100));
    });
  });

  describe('sliceClaudeLogs', () => {
    const lines = ['l1', 'l2', 'l3', 'l4', 'l5'];

    it('returns an empty page for empty input', () => {
      expect(sliceClaudeLogs([], '2026-01-01T00:00:00.000Z')).toEqual({
        lines: [],
        total: 0,
        hasMore: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('returns newest-first with hasMore when older lines remain', () => {
      const result = sliceClaudeLogs(lines, undefined, { offset: 0, limit: 2 });
      expect(result).toEqual({
        lines: ['l5', 'l4'],
        total: 5,
        hasMore: true,
        updatedAt: undefined,
      });
    });

    it('applies offset counting back from newest', () => {
      const result = sliceClaudeLogs(lines, undefined, { offset: 2, limit: 2 });
      expect(result.lines).toEqual(['l3', 'l2']);
      expect(result.hasMore).toBe(true);
    });

    it('clears hasMore once the oldest line is included', () => {
      const result = sliceClaudeLogs(lines, undefined, { offset: 3, limit: 10 });
      expect(result.lines).toEqual(['l2', 'l1']);
      expect(result.hasMore).toBe(false);
    });

    it('strips legacy [stdout]/[stderr] line prefixes', () => {
      const result = sliceClaudeLogs(['[stdout] hi', '[stderr] oops'], undefined, {
        offset: 0,
        limit: 10,
      });
      expect(result.lines).toEqual(['oops', 'hi']);
    });

    it('clamps invalid offset/limit to safe defaults', () => {
      const result = sliceClaudeLogs(lines, undefined, {
        offset: Number.NaN,
        limit: Number.NaN,
      });
      expect(result.lines).toEqual(['l5', 'l4', 'l3', 'l2', 'l1']);
      expect(result.total).toBe(5);
    });
  });
});
