import { resolveChangeReviewFileHunkCount } from '@features/change-review';
import { describe, expect, it } from 'vitest';

describe('resolveChangeReviewFileHunkCount', () => {
  it('prefers the measured editor chunk count', () => {
    expect(resolveChangeReviewFileHunkCount('/repo/file.ts', 2, { '/repo/file.ts': 4 })).toBe(4);
  });

  it('preserves an explicit zero chunk count', () => {
    expect(resolveChangeReviewFileHunkCount('/repo/file.ts', 2, { '/repo/file.ts': 0 })).toBe(0);
  });

  it('falls back to the snippet count until the editor has measured the file', () => {
    expect(resolveChangeReviewFileHunkCount('/repo/file.ts', 2, {})).toBe(2);
  });
});
