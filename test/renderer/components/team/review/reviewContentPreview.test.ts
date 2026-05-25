import { describe, expect, it } from 'vitest';

import {
  getReviewRejectBlockReason,
  getResolvedReviewModifiedContent,
  isReviewRejectable,
  isReviewFileMissingOnDisk,
  isReviewTextContentUnavailable,
  shouldRenderCurrentDiskContextPreview,
} from '../../../../../src/renderer/components/team/review/reviewContentPreview';

import type { FileChangeWithContent } from '@shared/types';
import type { FileChangeSummary } from '@shared/types/review';

function makeFile(overrides: Partial<FileChangeSummary> = {}): FileChangeSummary {
  return {
    filePath: '/repo/calc112/calc.js',
    relativePath: 'calc112/calc.js',
    snippets: [],
    linesAdded: 0,
    linesRemoved: 0,
    isNewFile: true,
    ...overrides,
  };
}

function makeContent(overrides: Partial<FileChangeWithContent> = {}): FileChangeWithContent {
  return {
    ...makeFile(),
    originalFullContent: null,
    modifiedFullContent: null,
    contentSource: 'unavailable',
    ...overrides,
  };
}

describe('reviewContentPreview', () => {
  it('uses write snippets as a restorable preview when the file is missing on disk', () => {
    const file = makeFile({
      snippets: [
        {
          toolUseId: 'tool-1',
          filePath: '/repo/calc112/calc.js',
          toolName: 'Write',
          type: 'write-new',
          oldString: '',
          newString: 'const value = 1;\n',
          replaceAll: false,
          timestamp: '2026-03-01T10:00:00.000Z',
          isError: false,
        },
      ],
    });
    const content = makeContent();

    expect(isReviewFileMissingOnDisk(content)).toBe(true);
    expect(getResolvedReviewModifiedContent(file, content)).toBe('const value = 1;\n');
    expect(isReviewTextContentUnavailable(file, content)).toBe(false);
  });

  it('keeps metadata-only unavailable content unavailable', () => {
    const file = makeFile();
    const content = makeContent();

    expect(getResolvedReviewModifiedContent(file, content)).toBeNull();
    expect(isReviewTextContentUnavailable(file, content)).toBe(true);
  });

  it('blocks reject for metadata-only current disk content but allows a context preview', () => {
    const file = makeFile({
      isNewFile: false,
      snippets: [
        {
          toolUseId: 'tool-1',
          filePath: '/repo/calc112/calc.js',
          toolName: 'Edit',
          type: 'edit',
          oldString: '',
          newString: '',
          replaceAll: false,
          timestamp: '2026-03-01T10:00:00.000Z',
          isError: false,
        },
      ],
    });
    const content = makeContent({
      contentSource: 'disk-current',
      originalFullContent: null,
      modifiedFullContent: 'const value = 1;\n',
    });

    expect(getReviewRejectBlockReason(file, content)).toBe('baseline-unavailable');
    expect(isReviewRejectable(file, content)).toBe(false);
    expect(shouldRenderCurrentDiskContextPreview(file, content)).toBe(true);
  });

  it('allows reject when both original and modified full text are available', () => {
    const file = makeFile({ isNewFile: false });
    const content = makeContent({
      contentSource: 'snippet-reconstruction',
      originalFullContent: 'const value = 1;\n',
      modifiedFullContent: 'const value = 2;\n',
    });

    expect(getReviewRejectBlockReason(file, content)).toBeNull();
    expect(isReviewRejectable(file, content)).toBe(true);
  });
});
