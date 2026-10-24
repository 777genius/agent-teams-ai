import { resolveReviewFilePath } from '@renderer/components/team/review/reviewFilePathResolution';
import { describe, expect, it } from 'vitest';

describe('resolveReviewFilePath', () => {
  it('scrolls to a unique section when duplicate destinations have distinct change keys', () => {
    const files = [
      { filePath: '/sandbox/new.ts', changeKey: 'rename:/sandbox/old.ts->/sandbox/new.ts' },
      { filePath: '/sandbox/new.ts', changeKey: 'path:/sandbox/new.ts' },
    ];

    expect(resolveReviewFilePath(files, files[1].changeKey)).toBe(files[1].changeKey);
    expect(resolveReviewFilePath(files, files[0].filePath)).toBeNull();
  });

  it('resolves initial review paths across Windows slash variants', () => {
    const files = [{ filePath: 'C:\\Repo\\SRC\\New.ts' }];

    expect(resolveReviewFilePath(files, 'C:/Repo/SRC/New.ts')).toBe('C:\\Repo\\SRC\\New.ts');
  });

  it('resolves relative Windows slash variants while preserving case', () => {
    const files = [{ filePath: 'SRC\\New.ts' }];

    expect(resolveReviewFilePath(files, 'SRC/New.ts')).toBe('SRC\\New.ts');
    expect(resolveReviewFilePath(files, 'src/new.ts')).toBeNull();
  });

  it('keeps POSIX path matching case-sensitive', () => {
    const files = [{ filePath: '/repo/SRC/New.ts' }];

    expect(resolveReviewFilePath(files, '/repo/src/new.ts')).toBeNull();
  });

  it('selects exact case when Windows files differ only by case', () => {
    const files = [{ filePath: 'C:\\Sensitive\\Foo.ts' }, { filePath: 'C:\\Sensitive\\foo.ts' }];

    expect(resolveReviewFilePath(files, 'C:/Sensitive/foo.ts')).toBe(files[1].filePath);
    expect(resolveReviewFilePath(files, 'c:/sensitive/FOO.ts')).toBeNull();
  });
});
