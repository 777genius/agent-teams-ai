import { describe, expect, it } from 'vitest';

import { countContentTokens, countTokens } from '../../../src/main/utils/tokenizer';

describe('tokenizer', () => {
  describe('countTokens', () => {
    it('should return 0 for empty string', () => {
      expect(countTokens('')).toBe(0);
    });

    it('should return 0 for null', () => {
      expect(countTokens(null)).toBe(0);
    });

    it('should return 0 for undefined', () => {
      expect(countTokens(undefined)).toBe(0);
    });

    it('should estimate tokens by dividing length by 4', () => {
      // 12 chars / 4 = 3 tokens
      expect(countTokens('Hello World!')).toBe(3);
    });

    it('should ceil the result', () => {
      // 5 chars / 4 = 1.25, ceil to 2
      expect(countTokens('Hello')).toBe(2);
    });

    it('should handle long text', () => {
      const longText = 'a'.repeat(1000);
      expect(countTokens(longText)).toBe(250); // 1000 / 4
    });

    it('should handle single character', () => {
      expect(countTokens('a')).toBe(1); // 1 / 4 = 0.25, ceil to 1
    });
  });

  describe('countContentTokens', () => {
    it('should handle string content', () => {
      expect(countContentTokens('Hello World!')).toBe(3);
    });

    it('should handle array content by stringifying', () => {
      const content = [{ type: 'text', text: 'Hello' }];
      const stringified = JSON.stringify(content);
      expect(countContentTokens(content)).toBe(Math.ceil(stringified.length / 4));
    });

    it('should return 0 for null', () => {
      expect(countContentTokens(null)).toBe(0);
    });

    it('should return 0 for undefined', () => {
      expect(countContentTokens(undefined)).toBe(0);
    });

    it('should handle empty array', () => {
      const content: unknown[] = [];
      expect(countContentTokens(content)).toBe(1); // "[]" is 2 chars, ceil(2/4) = 1
    });
  });
});
