import { countLineChanges } from '@shared/utils/lineDiffStats';
import { describe, expect, it } from 'vitest';

describe('countLineChanges', () => {
  it('handles empty content and trailing newlines without phantom lines', () => {
    expect(countLineChanges('', '')).toEqual({ added: 0, removed: 0 });
    expect(countLineChanges('', 'a\n')).toEqual({ added: 1, removed: 0 });
    expect(countLineChanges('a\n', '')).toEqual({ added: 0, removed: 1 });
  });

  it('uses exact diffLines semantics for newline-only and CRLF changes', () => {
    expect(countLineChanges('a\n', 'a')).toEqual({ added: 1, removed: 1 });
    expect(countLineChanges('a\r\n', 'a\n')).toEqual({ added: 1, removed: 1 });
  });
});
