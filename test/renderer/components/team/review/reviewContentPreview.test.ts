import { describe, expect, it } from 'vitest';

import {
  getEffectiveReviewFileDecision,
  getResolvedReviewModifiedContent,
  getReviewRejectBlockReason,
  isReviewAcceptDisabled,
  isReviewFileExpectedDeleted,
  isReviewFileMissingOnDisk,
  isReviewRejectable,
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

  it('blocks reject for an unverified snippet baseline even with full text', () => {
    const file = makeFile({ isNewFile: false });
    const content = makeContent({
      contentSource: 'snippet-reconstruction',
      originalFullContent: 'const value = 1;\n',
      modifiedFullContent: 'const value = 2;\n',
    });

    expect(getReviewRejectBlockReason(file, content)).toBe('baseline-unavailable');
    expect(isReviewRejectable(file, content)).toBe(false);
  });

  it('keeps a captured Codex add as preview only even when the current text matches', () => {
    const file = makeFile({
      snippets: [
        {
          toolUseId: 'add-1',
          filePath: '/repo/calc112/calc.js',
          toolName: 'Edit',
          type: 'write-new',
          oldString: '',
          newString: 'created\n',
          replaceAll: false,
          timestamp: '2026-03-01T10:00:00.000Z',
          isError: false,
        },
      ],
    });
    const content = makeContent({
      contentSource: 'snippet-reconstruction',
      originalFullContent: '',
      modifiedFullContent: 'created\n',
    });

    expect(getResolvedReviewModifiedContent(file, content)).toBe('created\n');
    expect(getReviewRejectBlockReason(file, content)).toBe('baseline-unavailable');
    expect(isReviewRejectable(file, content)).toBe(false);
    expect(
      getReviewRejectBlockReason({ ...file, filePath: '/repo/another-file.js' }, content)
    ).toBe('baseline-unavailable');
  });

  it('blocks a ledger label without a ledger event', () => {
    const file = makeFile({ isNewFile: false, snippets: [] });
    const content = makeContent({
      contentSource: 'ledger-exact',
      originalFullContent: 'before\n',
      modifiedFullContent: 'after\n',
    });

    expect(getReviewRejectBlockReason(file, content)).toBe('baseline-unavailable');
  });

  it('detects a final ledger deletion without misclassifying a rename', () => {
    const deleted = makeFile({
      isNewFile: false,
      ledgerSummary: { latestOperation: 'delete', deletedInTask: true },
    });
    const recreated = makeFile({
      isNewFile: false,
      ledgerSummary: { latestOperation: 'create', deletedInTask: true },
    });
    const renamed = makeFile({
      isNewFile: false,
      snippets: [
        {
          toolUseId: 'rename-delete',
          filePath: '/repo/calc112/old.js',
          toolName: 'Bash',
          type: 'shell-snapshot',
          oldString: 'old\n',
          newString: '',
          replaceAll: false,
          timestamp: '2026-03-01T10:00:00.000Z',
          isError: false,
          ledger: {
            eventId: 'event-1',
            source: 'ledger-snapshot',
            confidence: 'high',
            originalFullContent: 'old\n',
            modifiedFullContent: null,
            beforeHash: 'before',
            afterHash: null,
            operation: 'delete',
            beforeState: { exists: true },
            afterState: { exists: false },
            relation: {
              kind: 'rename',
              oldPath: '/repo/calc112/old.js',
              newPath: '/repo/calc112/calc.js',
            },
          },
        },
        {
          toolUseId: 'rename-create',
          filePath: '/repo/calc112/calc.js',
          toolName: 'Bash',
          type: 'shell-snapshot',
          oldString: '',
          newString: 'old\n',
          replaceAll: false,
          timestamp: '2026-03-01T10:00:01.000Z',
          isError: false,
          ledger: {
            eventId: 'event-2',
            source: 'ledger-snapshot',
            confidence: 'high',
            originalFullContent: null,
            modifiedFullContent: 'old\n',
            beforeHash: null,
            afterHash: 'after',
            operation: 'create',
            beforeState: { exists: false },
            afterState: { exists: true },
            relation: {
              kind: 'rename',
              oldPath: '/repo/calc112/old.js',
              newPath: '/repo/calc112/calc.js',
            },
          },
        },
      ],
    });

    expect(isReviewFileExpectedDeleted(deleted)).toBe(true);
    expect(isReviewFileExpectedDeleted(recreated)).toBe(false);
    expect(isReviewFileExpectedDeleted(renamed)).toBe(false);
  });

  it('allows Accept to restore a missing file only when it has a persisted rejection', () => {
    expect(
      isReviewAcceptDisabled({
        hasEdits: false,
        isMissingOnDisk: true,
        isContentUnavailable: false,
        fileDecision: 'rejected',
      })
    ).toBe(false);
    expect(
      isReviewAcceptDisabled({
        hasEdits: false,
        isMissingOnDisk: true,
        isContentUnavailable: false,
        fileDecision: 'pending',
      })
    ).toBe(true);
  });

  it('treats all rejected hunks as an effective file rejection after reopen', () => {
    const file = makeFile({
      isNewFile: false,
      changeKey: 'rename:old->new',
    });
    expect(
      getEffectiveReviewFileDecision(
        file,
        2,
        {
          'rename:old->new:0': 'rejected',
          '/repo/calc112/calc.js:1': 'rejected',
        },
        undefined
      )
    ).toBe('rejected');
    expect(
      getEffectiveReviewFileDecision(
        file,
        2,
        {
          'rename:old->new:0': 'rejected',
          '/repo/calc112/calc.js:1': 'pending',
        },
        undefined
      )
    ).toBeUndefined();
  });
});
