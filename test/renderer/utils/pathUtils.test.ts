import { describe, expect, it } from 'vitest';

import {
  getBaseName,
  getFirstSegment,
  hasPathSeparator,
  isRelativePath,
  splitPathSegments,
} from '@renderer/utils/pathUtils';

describe('pathUtils', () => {
  describe('getBaseName', () => {
    it('extracts filename from Unix path', () => {
      expect(getBaseName('/Users/name/project/file.ts')).toBe('file.ts');
    });

    it('extracts filename from Windows path', () => {
      expect(getBaseName('C:\\Users\\name\\project\\file.ts')).toBe('file.ts');
    });

    it('extracts filename from mixed-separator path', () => {
      expect(getBaseName('C:\\Users/name\\project/file.ts')).toBe('file.ts');
    });

    it('returns bare filename as-is', () => {
      expect(getBaseName('file.ts')).toBe('file.ts');
    });

    it('returns empty for trailing separator', () => {
      expect(getBaseName('/path/to/dir/')).toBe('');
    });

    it('returns empty for empty string', () => {
      expect(getBaseName('')).toBe('');
    });
  });

  describe('getFirstSegment', () => {
    it('returns first segment from Unix path', () => {
      expect(getFirstSegment('src/components/App.tsx')).toBe('src');
    });

    it('returns first segment from Windows path', () => {
      expect(getFirstSegment('src\\components\\App.tsx')).toBe('src');
    });

    it('returns drive letter from Windows absolute path', () => {
      expect(getFirstSegment('C:\\Users\\name')).toBe('C:');
    });

    it('skips leading separator in absolute path', () => {
      expect(getFirstSegment('/Users/name')).toBe('Users');
    });

    it('returns bare filename', () => {
      expect(getFirstSegment('file.ts')).toBe('file.ts');
    });

    it('returns empty for empty string', () => {
      expect(getFirstSegment('')).toBe('');
    });
  });

  describe('splitPathSegments', () => {
    it('splits Unix path', () => {
      expect(splitPathSegments('/a/b/c')).toEqual(['a', 'b', 'c']);
    });

    it('splits Windows path', () => {
      expect(splitPathSegments('C:\\a\\b\\c')).toEqual(['C:', 'a', 'b', 'c']);
    });

    it('splits mixed-separator path', () => {
      expect(splitPathSegments('a/b\\c')).toEqual(['a', 'b', 'c']);
    });

    it('filters empty segments', () => {
      expect(splitPathSegments('//a///b//')).toEqual(['a', 'b']);
    });

    it('returns single segment for bare name', () => {
      expect(splitPathSegments('file.ts')).toEqual(['file.ts']);
    });
  });

  describe('hasPathSeparator', () => {
    it('detects forward slash', () => {
      expect(hasPathSeparator('a/b')).toBe(true);
    });

    it('detects backslash', () => {
      expect(hasPathSeparator('a\\b')).toBe(true);
    });

    it('returns false for bare name', () => {
      expect(hasPathSeparator('file.ts')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(hasPathSeparator('')).toBe(false);
    });
  });

  describe('isRelativePath', () => {
    it('detects ./ prefix', () => {
      expect(isRelativePath('./src')).toBe(true);
    });

    it('detects .\\ prefix', () => {
      expect(isRelativePath('.\\src')).toBe(true);
    });

    it('detects ../ prefix', () => {
      expect(isRelativePath('../lib')).toBe(true);
    });

    it('detects ..\\ prefix', () => {
      expect(isRelativePath('..\\lib')).toBe(true);
    });

    it('rejects absolute Unix path', () => {
      expect(isRelativePath('/abs')).toBe(false);
    });

    it('rejects absolute Windows path', () => {
      expect(isRelativePath('C:\\abs')).toBe(false);
    });

    it('rejects bare name', () => {
      expect(isRelativePath('name')).toBe(false);
    });

    it('rejects single dot without separator', () => {
      expect(isRelativePath('.hidden')).toBe(false);
    });
  });
});
