import { normalizeReviewWatchedFiles } from '@features/change-review/main';
import { describe, expect, it } from 'vitest';

describe('review file watch policy', () => {
  it('keeps only string paths from renderer arrays', () => {
    const values = ['/safe/a.ts', 42] as unknown[];

    expect(normalizeReviewWatchedFiles(values)).toEqual(['/safe/a.ts']);
  });

  it.each([undefined, null, 'file.ts', { filePath: 'file.ts' }])(
    'normalizes non-array input %j to an empty list',
    (value) => {
      expect(normalizeReviewWatchedFiles(value)).toEqual([]);
    }
  );
});
