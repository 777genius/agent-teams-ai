import { describe, expect, it } from 'vitest';

import { isToolApprovalPreviewPathLexicallyUnsafe } from './ToolApprovalPreviewPathPolicy';

describe('ToolApprovalPreviewPathPolicy', () => {
  it('rejects POSIX parent components without rejecting dot-containing names', () => {
    expect(isToolApprovalPreviewPathLexicallyUnsafe('link/../target.txt', 'posix')).toBe(true);
    expect(isToolApprovalPreviewPathLexicallyUnsafe('../target.txt', 'posix')).toBe(true);
    expect(isToolApprovalPreviewPathLexicallyUnsafe('safe/..cache/target.txt', 'posix')).toBe(
      false
    );
    expect(isToolApprovalPreviewPathLexicallyUnsafe('safe/.../target.txt', 'posix')).toBe(false);
  });

  it('rejects Windows parent aliases across both separator forms', () => {
    for (const candidate of [
      String.raw`link\..\target.txt`,
      String.raw`link\.. \target.txt`,
      String.raw`link/.. ./target.txt`,
    ]) {
      expect(isToolApprovalPreviewPathLexicallyUnsafe(candidate, 'win32')).toBe(true);
    }
    for (const candidate of [
      String.raw`C:..\target.txt`,
      'C:../target.txt',
      String.raw`D:target.txt`,
      String.raw`\current-drive-rooted.txt`,
      '/current-drive-rooted.txt',
      String.raw`\\server-only`,
      '///not-a-unc-path.txt',
      String.raw`\\?\C:relative\target.txt`,
      String.raw`\\.\pipe\preview`,
    ]) {
      expect(isToolApprovalPreviewPathLexicallyUnsafe(candidate, 'win32')).toBe(true);
    }
    for (const candidate of [
      String.raw`C:\safe\target.txt`,
      'C:/safe/target.txt',
      String.raw`\\server\share\target.txt`,
      '//server/share/target.txt',
      String.raw`\\?\C:\safe\target.txt`,
      String.raw`\\?\UNC\server\share\target.txt`,
    ]) {
      expect(isToolApprovalPreviewPathLexicallyUnsafe(candidate, 'win32')).toBe(false);
    }
    expect(
      isToolApprovalPreviewPathLexicallyUnsafe(String.raw`safe\..cache\target.txt`, 'win32')
    ).toBe(false);
    expect(isToolApprovalPreviewPathLexicallyUnsafe(String.raw`safe\...\target.txt`, 'win32')).toBe(
      false
    );
  });
});
