import { describe, expect, it } from 'vitest';

import { resolveReviewFilePath } from '@renderer/components/team/review/reviewFilePathResolution';

describe('resolveReviewFilePath', () => {
  it('resolves initial review paths across Windows slash and case variants', () => {
    const files = [{ filePath: 'C:\\Repo\\SRC\\New.ts' }];

    expect(resolveReviewFilePath(files, 'c:/repo/src/new.ts')).toBe('C:\\Repo\\SRC\\New.ts');
  });

  it('resolves relative Windows paths case-insensitively when backslash separators are present', () => {
    const files = [{ filePath: 'SRC\\New.ts' }];

    expect(resolveReviewFilePath(files, 'src/new.ts')).toBe('SRC\\New.ts');
  });

  it('keeps POSIX path matching case-sensitive', () => {
    const files = [{ filePath: '/repo/SRC/New.ts' }];

    expect(resolveReviewFilePath(files, '/repo/src/new.ts')).toBeNull();
  });
});
