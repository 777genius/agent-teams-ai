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
    expect(isToolApprovalPreviewPathLexicallyUnsafe(String.raw`C:..\target.txt`, 'win32')).toBe(
      true
    );
    expect(isToolApprovalPreviewPathLexicallyUnsafe('C:../target.txt', 'win32')).toBe(true);
    expect(isToolApprovalPreviewPathLexicallyUnsafe(String.raw`D:target.txt`, 'win32')).toBe(true);
    expect(isToolApprovalPreviewPathLexicallyUnsafe(String.raw`C:\safe\target.txt`, 'win32')).toBe(
      false
    );
    expect(
      isToolApprovalPreviewPathLexicallyUnsafe(String.raw`safe\..cache\target.txt`, 'win32')
    ).toBe(false);
    expect(isToolApprovalPreviewPathLexicallyUnsafe(String.raw`safe\...\target.txt`, 'win32')).toBe(
      false
    );
  });
});
