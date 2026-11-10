/**
 * Tests for regex validation utilities (ReDoS protection).
 */

import { describe, expect, it } from 'vitest';

import { createSafeRegExp, validateRegexPattern } from '../../../src/main/utils/regexValidation';

describe('regexValidation', () => {
  describe('validateRegexPattern', () => {
    describe('basic validation', () => {
      it('should reject empty pattern', () => {
        const result = validateRegexPattern('');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-empty string');
      });

      it('should accept valid simple patterns', () => {
        expect(validateRegexPattern('hello')).toEqual({ valid: true });
        expect(validateRegexPattern('error')).toEqual({ valid: true });
        expect(validateRegexPattern('[a-z]+')).toEqual({ valid: true });
      });

      it('should accept valid patterns with special chars', () => {
        expect(validateRegexPattern('foo\\.bar')).toEqual({ valid: true });
        expect(validateRegexPattern('\\d+\\.\\d+')).toEqual({ valid: true });
        expect(validateRegexPattern('^test$')).toEqual({ valid: true });
      });
    });

    describe('length validation', () => {
      it('should reject patterns over 100 chars', () => {
        const longPattern = 'a'.repeat(101);
        const result = validateRegexPattern(longPattern);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too long');
      });

      it('should accept patterns at 100 chars', () => {
        const maxPattern = 'a'.repeat(100);
        expect(validateRegexPattern(maxPattern).valid).toBe(true);
      });
    });

    describe('ReDoS protection', () => {
      it('should reject nested quantifiers (a+)+', () => {
        const result = validateRegexPattern('(a+)+');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('performance issues');
      });

      it('should reject nested quantifiers (a*)+', () => {
        const result = validateRegexPattern('(a*)+');
        expect(result.valid).toBe(false);
      });

      it('should reject nested quantifiers (a+)*', () => {
        const result = validateRegexPattern('(a+)*');
        expect(result.valid).toBe(false);
      });

      it('should reject overlapping alternation with quantifiers', () => {
        const result = validateRegexPattern('(a|a)+');
        expect(result.valid).toBe(false);
      });

      it('should reject backreferences with quantifiers', () => {
        const result = validateRegexPattern('(.)\\1+');
        expect(result.valid).toBe(false);
      });

      it('should accept safe quantifier patterns', () => {
        expect(validateRegexPattern('a+')).toEqual({ valid: true });
        expect(validateRegexPattern('a*b+')).toEqual({ valid: true });
        expect(validateRegexPattern('[a-z]+')).toEqual({ valid: true });
        expect(validateRegexPattern('\\d{1,3}')).toEqual({ valid: true });
      });
    });

    describe('bracket balance', () => {
      it('should reject unbalanced parentheses', () => {
        const result = validateRegexPattern('(abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('unbalanced');
      });

      it('should reject unbalanced brackets', () => {
        const result = validateRegexPattern('[abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('unbalanced');
      });

      it('should accept balanced patterns', () => {
        expect(validateRegexPattern('(abc)')).toEqual({ valid: true });
        expect(validateRegexPattern('[a-z]')).toEqual({ valid: true });
        expect(validateRegexPattern('((a)(b))')).toEqual({ valid: true });
      });

      it('should handle escaped brackets', () => {
        expect(validateRegexPattern('\\(abc\\)')).toEqual({ valid: true });
        expect(validateRegexPattern('\\[test\\]')).toEqual({ valid: true });
      });
    });

    describe('syntax validation', () => {
      it('should reject invalid regex syntax', () => {
        const result = validateRegexPattern('*invalid');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid regex syntax');
      });

      it('should reject invalid quantifier syntax', () => {
        // Note: 'a{abc}' is valid JS regex (matches 'a' followed by literal '{abc}')
        // We test actual invalid syntax
        const result = validateRegexPattern('a{2,1}'); // min > max is invalid
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid regex syntax');
      });
    });
  });

  describe('createSafeRegExp', () => {
    it('should return RegExp for valid pattern', () => {
      const regex = createSafeRegExp('test');
      expect(regex).toBeInstanceOf(RegExp);
      expect(regex?.test('test')).toBe(true);
    });

    it('should return null for invalid pattern', () => {
      expect(createSafeRegExp('')).toBeNull();
      expect(createSafeRegExp('(a+)+')).toBeNull();
      expect(createSafeRegExp('*invalid')).toBeNull();
    });

    it('should use default case-insensitive flag', () => {
      const regex = createSafeRegExp('test');
      expect(regex?.flags).toContain('i');
      expect(regex?.test('TEST')).toBe(true);
    });

    it('should use provided flags', () => {
      const regex = createSafeRegExp('test', 'g');
      expect(regex?.flags).toBe('g');
    });
  });
});
