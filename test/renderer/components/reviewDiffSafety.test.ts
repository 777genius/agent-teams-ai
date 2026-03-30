import { describe, expect, it } from 'vitest';

import {
  shouldRenderCodeMirrorReviewDiff,
  shouldRenderSnippetReviewPreview,
} from '@renderer/components/team/review/reviewDiffSafety';

describe('reviewDiffSafety', () => {
  it('allows regular CodeMirror review diffs', () => {
    expect(shouldRenderCodeMirrorReviewDiff('line 1\nline 2', 'line 1\nline 3')).toBe(true);
  });

  it('blocks oversized CodeMirror review diffs by line-product', () => {
    const original = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join('\n');
    const modified = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join('\n');

    expect(shouldRenderCodeMirrorReviewDiff(original, modified)).toBe(false);
  });

  it('allows small snippet previews', () => {
    expect(
      shouldRenderSnippetReviewPreview([
        {
          filePath: '/tmp/a.ts',
          oldString: 'const a = 1;\n',
          newString: 'const a = 2;\n',
          timestamp: '2026-03-28T10:00:00.000Z',
          toolUseId: 'tool-1',
          toolName: 'Edit',
          type: 'edit',
          replaceAll: false,
          isError: false,
        },
      ])
    ).toBe(true);
  });

  it('blocks oversized snippet previews', () => {
    expect(
      shouldRenderSnippetReviewPreview([
        {
          filePath: '/tmp/big.ts',
          oldString: '',
          newString: 'a'.repeat(600 * 1024),
          timestamp: '2026-03-28T10:00:00.000Z',
          toolUseId: 'tool-2',
          toolName: 'Write',
          type: 'write-update',
          replaceAll: false,
          isError: false,
        },
      ])
    ).toBe(false);
  });
});
