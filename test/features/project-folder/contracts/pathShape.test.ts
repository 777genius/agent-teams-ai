import { isInvalidProjectFolderPathShape } from '@features/project-folder/contracts';
import { describe, expect, it } from 'vitest';

describe('isInvalidProjectFolderPathShape', () => {
  it('rejects empty, relative, NUL and filesystem-root paths before a probe', () => {
    expect(isInvalidProjectFolderPathShape('')).toBe(true);
    expect(isInvalidProjectFolderPathShape('   ')).toBe(true);
    expect(isInvalidProjectFolderPathShape('relative/project')).toBe(true);
    expect(isInvalidProjectFolderPathShape('/tmp/bad\0name')).toBe(true);
    expect(isInvalidProjectFolderPathShape('/')).toBe(true);
    expect(isInvalidProjectFolderPathShape('C:\\')).toBe(true);
  });

  it('allows ordinary absolute project folders', () => {
    expect(isInvalidProjectFolderPathShape('/tmp/new-project')).toBe(false);
    expect(isInvalidProjectFolderPathShape('C:\\Users\\test\\project')).toBe(false);
  });
});
