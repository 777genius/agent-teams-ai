import { describe, expect, it } from 'vitest';

import {
  formatCompactRelativeTime,
  formatDuration,
  formatTokensCompact,
} from '../../../src/renderer/utils/formatters';

describe('formatters', () => {
  describe('formatCompactRelativeTime', () => {
    const now = new Date('2026-04-09T10:00:00.000Z');

    it.each([
      ['2026-04-09T09:59:54.000Z', '6s'],
      ['2026-04-09T09:56:00.000Z', '4m'],
      ['2026-04-09T08:00:00.000Z', '2h'],
      ['2026-04-08T10:00:00.000Z', '1d'],
    ])('formats %s as %s', (value, expected) => {
      expect(formatCompactRelativeTime(new Date(value), now)).toBe(expected);
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('should format seconds with one decimal', () => {
      expect(formatDuration(1500)).toBe('1.5s');
    });

    it('should format whole seconds', () => {
      expect(formatDuration(3000)).toBe('3.0s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
    });

    it('should format multiple minutes', () => {
      expect(formatDuration(180000)).toBe('3m 0s');
    });

    it('should round milliseconds', () => {
      expect(formatDuration(499.7)).toBe('500ms');
    });

    it('should handle zero', () => {
      expect(formatDuration(0)).toBe('0ms');
    });

    it('should handle exactly 1000ms', () => {
      expect(formatDuration(1000)).toBe('1.0s');
    });

    it('should handle exactly 60000ms', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
    });

    it('should handle large values', () => {
      expect(formatDuration(3661000)).toBe('61m 1s');
    });

    it('should round remaining seconds', () => {
      expect(formatDuration(61500)).toBe('1m 2s');
    });
  });

  describe('formatTokensCompact', () => {
    it('should format small numbers as-is', () => {
      expect(formatTokensCompact(500)).toBe('500');
    });

    it('should format thousands with k suffix', () => {
      expect(formatTokensCompact(1500)).toBe('1.5k');
    });

    it('should format exact thousands', () => {
      expect(formatTokensCompact(1000)).toBe('1.0k');
    });

    it('should format large thousands', () => {
      expect(formatTokensCompact(50000)).toBe('50.0k');
    });

    it('should format millions with M suffix', () => {
      expect(formatTokensCompact(1500000)).toBe('1.5M');
    });

    it('should format exact millions', () => {
      expect(formatTokensCompact(1000000)).toBe('1.0M');
    });

    it('should handle zero', () => {
      expect(formatTokensCompact(0)).toBe('0');
    });

    it('should handle just under thousand', () => {
      expect(formatTokensCompact(999)).toBe('999');
    });
  });
});
