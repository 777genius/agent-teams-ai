import { describe, expect, it } from 'vitest';

import { resolveFilePath } from '../../../src/renderer/store/utils/pathResolution';

describe('resolveFilePath', () => {
  it('returns unix absolute paths as-is', () => {
    expect(resolveFilePath('/repo', '/repo/src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('returns windows absolute paths as-is', () => {
    expect(resolveFilePath('C:\\repo', 'C:\\repo\\src\\index.ts')).toBe('C:\\repo\\src\\index.ts');
  });

  it('resolves dot-prefixed relative paths', () => {
    expect(resolveFilePath('/repo', './src/app.ts')).toBe('/repo/src/app.ts');
    expect(resolveFilePath('C:\\repo', '.\\src\\app.ts')).toBe('C:\\repo\\src\\app.ts');
  });

  it('resolves parent relative paths on unix', () => {
    expect(resolveFilePath('/repo/apps/web', '../shared/file.ts')).toBe(
      '/repo/apps/shared/file.ts'
    );
  });

  it('resolves parent relative paths on windows', () => {
    expect(resolveFilePath('C:\\repo\\apps\\web', '..\\shared\\file.ts')).toBe(
      'C:\\repo\\apps\\shared\\file.ts'
    );
  });

  it('preserves Windows drive-root separators when resolving child paths', () => {
    expect(resolveFilePath('C:\\', 'src\\app.ts')).toBe('C:\\src\\app.ts');
    expect(resolveFilePath('C:/', 'src/app.ts')).toBe('C:/src/app.ts');
  });

  it('passes through tilde paths as-is', () => {
    expect(resolveFilePath('/repo', '~/some/directory')).toBe('~/some/directory');
  });

  it('passes through tilde paths with @ prefix as-is', () => {
    expect(resolveFilePath('/repo', '@~/some/file.ts')).toBe('~/some/file.ts');
  });

  it('passes through bare tilde as-is', () => {
    expect(resolveFilePath('/repo', '~')).toBe('~');
  });

  it('passes through tilde paths with backslash separator (Windows)', () => {
    expect(resolveFilePath('C:\\repo', '~\\.claude\\agents\\file.md')).toBe(
      '~\\.claude\\agents\\file.md'
    );
  });

  it('resolves relative paths under Windows UNC roots', () => {
    expect(resolveFilePath('\\\\server\\share\\repo', 'src\\index.ts')).toBe(
      '\\\\server\\share\\repo\\src\\index.ts'
    );
    expect(resolveFilePath('//server/share/repo', 'src/index.ts')).toBe(
      '//server/share/repo/src/index.ts'
    );
  });

  it('does not resolve parent paths above a Windows UNC share root', () => {
    expect(resolveFilePath('\\\\server\\share', '..\\outside\\file.ts')).toBe(
      '\\\\server\\share\\outside\\file.ts'
    );
    expect(resolveFilePath('//server/share', '../outside/file.ts')).toBe(
      '//server/share/outside/file.ts'
    );
  });

  it('does not treat tilde in the middle as special', () => {
    expect(resolveFilePath('/repo', 'foo~/bar')).toBe('/repo/foo~/bar');
  });
});
