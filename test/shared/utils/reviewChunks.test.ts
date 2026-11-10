import { rejectReviewChunks } from '@shared/utils/reviewChunks';
import { describe, expect, it } from 'vitest';

describe('reviewChunks', () => {
  it('preserves CRLF and trailing blank lines when rejecting one chunk', () => {
    const original = 'one\r\ntwo\r\nthree\r\n\r\n';
    const modified = 'ONE\r\ntwo\r\nTHREE\r\n\r\n';

    const result = rejectReviewChunks(original, modified, [0]);

    expect(result).toBe('one\r\ntwo\r\nTHREE\r\n\r\n');
    expect(result).not.toMatch(/(^|[^\r])\n/);
  });

  it('falls back to the original CRLF style when the modified side has no newline', () => {
    expect(rejectReviewChunks('one\r\ntwo', 'combined', [0])).toBe('one\r\ntwo');
  });
});
