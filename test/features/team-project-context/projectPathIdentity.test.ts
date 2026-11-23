import { describe, expect, it } from 'vitest';

import { isAbsoluteProjectPath } from '../../../src/features/team-project-context/main/projectPathIdentity';

describe('project path identities', () => {
  it('requires a Windows drive or UNC share instead of a current-drive root', () => {
    expect(isAbsoluteProjectPath('\\work\\alpha', 'win32')).toBe(false);
    expect(isAbsoluteProjectPath('C:work\\alpha', 'win32')).toBe(false);
    expect(isAbsoluteProjectPath('C:\\work\\alpha', 'win32')).toBe(true);
    expect(isAbsoluteProjectPath('\\\\server\\share\\alpha', 'win32')).toBe(true);
    expect(isAbsoluteProjectPath('/work/alpha', 'darwin')).toBe(true);
  });
});
