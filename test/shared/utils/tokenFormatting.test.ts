import { describe, expect, it } from 'vitest';

import {
  estimateContentTokens,
  estimateTokens,
  formatTokens,
  formatTokensCompact,
  formatTokensDetailed,
} from '../../../src/shared/utils/tokenFormatting';

describe('tokenFormatting', () => {
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

    it('should format millions with M suffix', () => {
      expect(formatTokensCompact(1500000)).toBe('1.5M');
    });

    it('should format exact millions', () => {
      expect(formatTokensCompact(1000000)).toBe('1.0M');
    });

    it('should handle zero', () => {
      expect(formatTokensCompact(0)).toBe('0');
    });
  });

  describe('formatTokens', () => {
    it('should format small numbers as-is', () => {
      expect(formatTokens(500)).toBe('500');
    });

    it('should format 1k-10k with one decimal', () => {
      expect(formatTokens(1500)).toBe('1.5k');
      expect(formatTokens(9999)).toBe('10.0k');
    });

    it('should format 10k+ as whole numbers', () => {
      expect(formatTokens(15000)).toBe('15k');
      expect(formatTokens(50000)).toBe('50k');
    });

    it('should handle exact thousands', () => {
      expect(formatTokens(1000)).toBe('1.0k');
      expect(formatTokens(10000)).toBe('10k');
    });
  });

  describe('formatTokensDetailed', () => {
    it('should format with locale separators', () => {
      // Note: This test may vary by locale
      const result = formatTokensDetailed(1000);
      expect(result).toContain('1');
      expect(result.length).toBeGreaterThan(3);
    });

    it('should format large numbers', () => {
      const result = formatTokensDetailed(1000000);
      expect(result).toContain('1');
      expect(result.length).toBeGreaterThan(6);
    });
  });

  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should return 0 for null', () => {
      expect(estimateTokens(null)).toBe(0);
    });

    it('should return 0 for undefined', () => {
      expect(estimateTokens(undefined)).toBe(0);
    });

    it('should estimate tokens by dividing length by 4', () => {
      // 12 chars / 4 = 3 tokens
      expect(estimateTokens('Hello World!')).toBe(3);
    });

    it('should ceil the result', () => {
      // 5 chars / 4 = 1.25, ceil to 2
      expect(estimateTokens('Hello')).toBe(2);
    });
  });

  describe('estimateContentTokens', () => {
    it('should handle string content', () => {
      expect(estimateContentTokens('Hello World!')).toBe(3);
    });

    it('should handle array content by stringifying', () => {
      const content = [{ type: 'text', text: 'Hello' }];
      const stringified = JSON.stringify(content);
      expect(estimateContentTokens(content)).toBe(Math.ceil(stringified.length / 4));
    });

    it('should handle object content by stringifying', () => {
      const content = { type: 'text', text: 'Hello' };
      const stringified = JSON.stringify(content);
      expect(estimateContentTokens(content)).toBe(Math.ceil(stringified.length / 4));
    });

    it('should return 0 for null', () => {
      expect(estimateContentTokens(null)).toBe(0);
    });

    it('should return 0 for undefined', () => {
      expect(estimateContentTokens(undefined)).toBe(0);
    });
  });
});
