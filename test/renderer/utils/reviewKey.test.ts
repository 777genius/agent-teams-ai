import { describe, expect, it } from 'vitest';

import {
  getReviewKeyForFilePath,
  normalizePersistedReviewState,
} from '../../../src/renderer/utils/reviewKey';

describe('reviewKey path normalization', () => {
  it('maps slash variants of Windows file paths to the same review key', () => {
    const files = [{ filePath: 'C:\\Repo\\src\\file.ts', changeKey: 'path:c:/repo/src/file.ts' }];

    expect(getReviewKeyForFilePath(files, 'c:/repo/src/file.ts')).toBe('path:c:/repo/src/file.ts');
  });

  it('normalizes persisted legacy Windows path decisions onto changeKey entries', () => {
    const files = [{ filePath: 'C:/Repo/src/file.ts', changeKey: 'path:c:/repo/src/file.ts' }];
    const state = normalizePersistedReviewState(files, {
      fileDecisions: { 'c:\\repo\\src\\file.ts': 'rejected' },
      hunkDecisions: { 'c:\\repo\\src\\file.ts:2': 'accepted' },
      hunkContextHashesByFile: { 'c:\\repo\\src\\file.ts': { 2: 'ctx' } },
    });

    expect(state.fileDecisions).toEqual({ 'path:c:/repo/src/file.ts': 'rejected' });
    expect(state.hunkDecisions).toEqual({ 'path:c:/repo/src/file.ts:2': 'accepted' });
    expect(state.hunkContextHashesByFile).toEqual({
      'path:c:/repo/src/file.ts': { 2: 'ctx' },
    });
  });
});
