import { describe, expect, it } from 'vitest';

import { getRelativePathWithinPrefix, isPathPrefix } from '../../../src/shared/utils/platformPath';

describe('platformPath Windows containment', () => {
  it('matches Windows drive paths case-insensitively and preserves child path style', () => {
    expect(isPathPrefix('C:/Users/Alice/Repo', 'c:\\Users\\Alice\\repo\\src\\app.ts')).toBe(true);
    expect(
      getRelativePathWithinPrefix('C:/Users/Alice/Repo', 'c:\\Users\\Alice\\repo\\src\\app.ts')
    ).toBe('src\\app.ts');
  });

  it('matches UNC paths with mixed separators', () => {
    expect(
      getRelativePathWithinPrefix('\\\\server\\share\\Repo', '//server/share/repo/src/app.ts')
    ).toBe('src/app.ts');
  });

  it('rejects sibling paths that only share the same text prefix', () => {
    expect(
      getRelativePathWithinPrefix('C:\\Users\\Alice\\Repo', 'C:\\Users\\Alice\\Repo2\\x.ts')
    ).toBe(null);
  });

  it('keeps POSIX paths case-sensitive', () => {
    expect(getRelativePathWithinPrefix('/Users/Alice/Repo', '/Users/Alice/Repo/src/app.ts')).toBe(
      'src/app.ts'
    );
    expect(getRelativePathWithinPrefix('/Users/Alice/Repo', '/Users/Alice/repo/src/app.ts')).toBe(
      null
    );
  });
});
