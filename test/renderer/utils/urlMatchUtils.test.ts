import { describe, expect, it } from 'vitest';

import {
  findUrlBoundary,
  findUrlMatches,
  removeUrlMatchFromText,
} from '@renderer/utils/urlMatchUtils';

describe('urlMatchUtils', () => {
  describe('findUrlMatches URL_REGEX', () => {
    it('matches http and https URLs', () => {
      const m1 = findUrlMatches('see https://example.com');
      expect(m1).toHaveLength(1);
      expect(m1[0].value).toBe('https://example.com');

      const m2 = findUrlMatches('see http://foo.bar/path');
      expect(m2).toHaveLength(1);
      expect(m2[0].value).toBe('http://foo.bar/path');
    });

    it('matches URL with query and hash', () => {
      const m = findUrlMatches('https://x.com?a=1#anchor');
      expect(m).toHaveLength(1);
      expect(m[0].value).toBe('https://x.com?a=1#anchor');
    });

    it('returns empty for text without URLs', () => {
      expect(findUrlMatches('no url here')).toEqual([]);
      expect(findUrlMatches('')).toEqual([]);
    });

    it('matches multiple URLs', () => {
      const m = findUrlMatches('a https://a.com b https://b.com c');
      expect(m).toHaveLength(2);
      expect(m[0].value).toBe('https://a.com');
      expect(m[1].value).toBe('https://b.com');
    });
  });

  describe('trimUrlMatch trailing punctuation regex', () => {
    it('strips trailing ), . ! ? ; :', () => {
      const m = findUrlMatches('check (https://example.com).');
      expect(m).toHaveLength(1);
      expect(m[0].value).toBe('https://example.com');
    });

    it('strips trailing comma', () => {
      const m = findUrlMatches('see https://x.com, and more');
      expect(m).toHaveLength(1);
      expect(m[0].value).toBe('https://x.com');
    });

    it('strips multiple trailing punctuation', () => {
      const m = findUrlMatches('(https://x.com)...');
      expect(m).toHaveLength(1);
      expect(m[0].value).toBe('https://x.com');
    });
  });

  describe('findUrlBoundary', () => {
    it('returns match when cursor inside URL', () => {
      const text = 'go to https://example.com now';
      const m = findUrlBoundary(text, 12);
      expect(m).not.toBeNull();
      expect(m!.value).toBe('https://example.com');
    });

    it('returns null when cursor outside URL', () => {
      const text = 'go to https://example.com now';
      expect(findUrlBoundary(text, 0)).toBeNull();
      expect(findUrlBoundary(text, 100)).toBeNull();
    });
  });

  describe('removeUrlMatchFromText', () => {
    it('removes URL from text', () => {
      const text = 'see https://x.com here';
      const matches = findUrlMatches(text);
      expect(matches).toHaveLength(1);
      const result = removeUrlMatchFromText(text, matches[0]);
      expect(result).toBe('see  here');
    });
  });
});
