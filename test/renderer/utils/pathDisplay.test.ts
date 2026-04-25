import { describe, expect, it } from 'vitest';

import {
  formatProjectPath,
  resolveAbsolutePath,
  shortenDisplayPath,
} from '../../../src/renderer/utils/pathDisplay';

describe('pathDisplay Windows paths', () => {
  it('treats lowercase drive paths as absolute', () => {
    expect(resolveAbsolutePath('c:\\Users\\Alice\\repo\\src\\app.ts', 'C:\\Users\\Alice\\repo')).toBe(
      'c:\\Users\\Alice\\repo\\src\\app.ts'
    );
  });

  it('shortens project-root relative paths case-insensitively on Windows', () => {
    expect(shortenDisplayPath('c:\\Users\\Alice\\repo\\src\\app.ts', 'C:\\Users\\Alice\\Repo')).toBe(
      'src\\app.ts'
    );
  });

  it('formats lowercase Windows user paths with a home marker', () => {
    expect(formatProjectPath('c:\\users\\Alice\\repo')).toBe('~/repo');
  });

  it('resolves home paths from lowercase Windows user roots', () => {
    expect(resolveAbsolutePath('~/repo/src/app.ts', 'c:\\users\\Alice\\workspace')).toBe(
      'c:\\users\\Alice\\repo\\src\\app.ts'
    );
  });

  it('resolves relative paths using the project root separator', () => {
    expect(resolveAbsolutePath('src/app.ts', 'C:\\Users\\Alice\\repo')).toBe(
      'C:\\Users\\Alice\\repo\\src\\app.ts'
    );
  });
});
