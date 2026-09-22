import { describe, expect, it } from 'vitest';

import {
  getAsyncLanguageDesc,
  getSyncLanguageExtension,
} from '@renderer/utils/codemirrorLanguages';

describe('getSyncLanguageExtension', () => {
  it.each([
    ['file.ts', true],
    ['file.tsx', true],
    ['file.js', true],
    ['file.jsx', true],
    ['file.mjs', true],
    ['file.cjs', true],
    ['file.py', true],
    ['file.json', true],
    ['file.jsonl', true],
    ['file.css', true],
    ['file.scss', true],
    ['file.sass', true],
    ['file.less', true],
    ['file.html', true],
    ['file.htm', true],
    ['file.xml', true],
    ['file.svg', true],
    ['file.md', true],
    ['file.mdx', true],
    ['file.markdown', true],
    ['file.yaml', true],
    ['file.yml', true],
    ['file.rs', true],
    ['file.go', true],
    ['file.java', true],
    ['file.c', true],
    ['file.h', true],
    ['file.cpp', true],
    ['file.cxx', true],
    ['file.cc', true],
    ['file.hpp', true],
    ['file.php', true],
    ['file.sql', true],
  ])('returns extension for %s', (fileName, expected) => {
    const ext = getSyncLanguageExtension(fileName);
    expect(ext !== null).toBe(expected);
  });

  it('returns null for unknown extensions', () => {
    expect(getSyncLanguageExtension('file.unknown')).toBeNull();
    expect(getSyncLanguageExtension('file.dat')).toBeNull();
    expect(getSyncLanguageExtension('file.bin')).toBeNull();
  });

  it('handles files without extension', () => {
    expect(getSyncLanguageExtension('Makefile')).toBeNull();
    expect(getSyncLanguageExtension('Dockerfile')).toBeNull();
  });

  it('is case-insensitive for extensions', () => {
    expect(getSyncLanguageExtension('file.TS')).not.toBeNull();
    expect(getSyncLanguageExtension('file.JSON')).not.toBeNull();
    expect(getSyncLanguageExtension('file.Py')).not.toBeNull();
  });

  it('handles nested paths', () => {
    expect(getSyncLanguageExtension('src/main/index.ts')).not.toBeNull();
    expect(getSyncLanguageExtension('deeply/nested/path/file.py')).not.toBeNull();
  });
});

describe('getAsyncLanguageDesc', () => {
  it('returns a LanguageDescription for known file types', () => {
    const desc = getAsyncLanguageDesc('file.rb');
    expect(desc).not.toBeNull();
    expect(desc!.name).toBeDefined();
  });

  it('returns null for completely unknown types', () => {
    const desc = getAsyncLanguageDesc('file.xyzabc123');
    expect(desc).toBeNull();
  });

  it('works with full path', () => {
    const desc = getAsyncLanguageDesc('src/main.rb');
    expect(desc).not.toBeNull();
  });
});
