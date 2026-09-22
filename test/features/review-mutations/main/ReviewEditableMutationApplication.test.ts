import {
  createReviewEditableMutationFeature,
  type ReviewEditableMutationDependencies,
} from '@features/review-mutations/main';
import { describe, expect, it, vi } from 'vitest';

import type { FileChangeWithContent, SnippetDiff } from '@shared/types/review';

const REVIEWED_FILE_PATH = '/review-editable-safe-root/reviewed.ts';
const RENAMED_FILE_PATH = '/review-editable-safe-root/renamed.ts';

function createSnippet(): SnippetDiff {
  return {
    toolUseId: 'rename-event',
    filePath: REVIEWED_FILE_PATH,
    toolName: 'Bash',
    type: 'shell-snapshot',
    oldString: 'before\n',
    newString: 'after\n',
    replaceAll: false,
    timestamp: '2026-07-24T10:00:00.000Z',
    isError: false,
  };
}

function createHarness() {
  const authorization = {
    roots: [],
    reviewedFiles: null,
    resolutionMemberName: 'worker',
  };
  const expectation = {
    eventId: 'rename-event',
    beforeHash: null,
    afterHash: null,
    relation: {
      kind: 'rename' as const,
      oldPath: REVIEWED_FILE_PATH,
      newPath: RENAMED_FILE_PATH,
    },
  };
  const content = {
    filePath: RENAMED_FILE_PATH,
    relativePath: 'renamed.ts',
    snippets: [createSnippet()],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    originalFullContent: 'before\n',
    modifiedFullContent: 'after\n',
    contentSource: 'ledger-exact',
  } satisfies FileChangeWithContent;

  const dependencies = {
    scope: {
      parseReviewRenameRecoveryExpectation: vi.fn(() => expectation),
      resolveReviewPathAuthorization: vi.fn(() =>
        Promise.resolve({
          scope: { teamName: 'safe-team', memberName: 'worker' },
          authorization,
        })
      ),
      validateAuthorizedReviewFilePath: vi.fn(() => Promise.resolve(RENAMED_FILE_PATH)),
      resolveAuthoritativeFileContent: vi.fn(() => Promise.resolve(content)),
      validateSnippetPaths: vi.fn(() => Promise.resolve()),
      assertExpectedAuthoritativeRename: vi.fn(),
      invalidateAuthoritativeReviewContent: vi.fn(),
    },
    applier: {
      saveEditedFile: vi.fn(() => Promise.resolve({ success: true })),
      deleteEditedFile: vi.fn(() => Promise.resolve({ success: true })),
      restoreRejectedRename: vi.fn(() => Promise.resolve({ success: true })),
      reapplyRejectedRename: vi.fn(() => Promise.resolve({ success: true })),
    },
    content: {
      invalidateFile: vi.fn(),
    },
  } satisfies ReviewEditableMutationDependencies;

  return { dependencies, authorization, expectation, content };
}

describe('ReviewEditableMutationApplication', () => {
  it('authorizes save and delete before applying and invalidating content', async () => {
    const harness = createHarness();
    const events: string[] = [];
    harness.dependencies.scope.resolveReviewPathAuthorization.mockImplementation(() => {
      events.push('resolve');
      return Promise.resolve({
        scope: { teamName: 'safe-team', memberName: 'worker' },
        authorization: harness.authorization,
      });
    });
    harness.dependencies.scope.validateAuthorizedReviewFilePath.mockImplementation(() => {
      events.push('validate-file');
      return Promise.resolve(REVIEWED_FILE_PATH);
    });
    harness.dependencies.applier.saveEditedFile.mockImplementation(() => {
      events.push('save');
      return Promise.resolve({ success: true });
    });
    harness.dependencies.applier.deleteEditedFile.mockImplementation(() => {
      events.push('delete');
      return Promise.resolve({ success: true });
    });
    harness.dependencies.content.invalidateFile.mockImplementation(() => {
      events.push('invalidate');
    });
    const feature = createReviewEditableMutationFeature(harness.dependencies);

    await expect(
      feature.saveEditedFile(
        { teamName: 'renderer-team', memberName: 'worker' },
        {
          filePath: '/renderer/file.ts',
          content: 'after\n',
          expectedCurrentContent: 'before\n',
        }
      )
    ).resolves.toEqual({ success: true });
    expect(events).toEqual(['resolve', 'validate-file', 'save', 'invalidate']);
    expect(harness.dependencies.scope.resolveReviewPathAuthorization).toHaveBeenLastCalledWith(
      { teamName: 'renderer-team', memberName: 'worker' },
      { requireIdentity: true }
    );
    expect(harness.dependencies.scope.validateAuthorizedReviewFilePath).toHaveBeenLastCalledWith(
      harness.authorization,
      '/renderer/file.ts',
      {
        requireReviewedFile: true,
        rejectHardlinks: true,
      }
    );
    expect(harness.dependencies.applier.saveEditedFile).toHaveBeenCalledWith(
      REVIEWED_FILE_PATH,
      'after\n',
      'before\n'
    );

    events.length = 0;
    await expect(
      feature.deleteEditedFile(
        { teamName: 'renderer-team', memberName: 'worker' },
        { filePath: '/renderer/file.ts', expectedCurrentContent: 'after\n' }
      )
    ).resolves.toEqual({ success: true });
    expect(events).toEqual(['resolve', 'validate-file', 'delete', 'invalidate']);
    expect(harness.dependencies.applier.deleteEditedFile).toHaveBeenCalledWith(
      REVIEWED_FILE_PATH,
      'after\n'
    );
    expect(harness.dependencies.content.invalidateFile).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate a direct edit whose applier rejects it', async () => {
    const harness = createHarness();
    harness.dependencies.applier.saveEditedFile.mockRejectedValueOnce(
      new Error('compare-and-set failed')
    );
    const feature = createReviewEditableMutationFeature(harness.dependencies);

    await expect(
      feature.saveEditedFile(
        { teamName: 'safe-team', memberName: 'worker' },
        {
          filePath: REVIEWED_FILE_PATH,
          content: 'after\n',
          expectedCurrentContent: 'before\n',
        }
      )
    ).rejects.toThrow('compare-and-set failed');
    expect(harness.dependencies.content.invalidateFile).not.toHaveBeenCalled();
  });

  it('authorizes a rejected rename in the original order and restores exact content', async () => {
    const harness = createHarness();
    const events: string[] = [];
    harness.dependencies.scope.parseReviewRenameRecoveryExpectation.mockImplementation(() => {
      events.push('parse-expectation');
      return harness.expectation;
    });
    harness.dependencies.scope.resolveReviewPathAuthorization.mockImplementation(() => {
      events.push('resolve');
      return Promise.resolve({
        scope: { teamName: 'safe-team', memberName: 'worker' },
        authorization: harness.authorization,
      });
    });
    harness.dependencies.scope.validateAuthorizedReviewFilePath.mockImplementation(() => {
      events.push('validate-file');
      return Promise.resolve(RENAMED_FILE_PATH);
    });
    harness.dependencies.scope.resolveAuthoritativeFileContent.mockImplementation(() => {
      events.push('resolve-content');
      return Promise.resolve(harness.content);
    });
    harness.dependencies.scope.validateSnippetPaths.mockImplementation(() => {
      events.push('validate-snippets');
      return Promise.resolve();
    });
    harness.dependencies.scope.assertExpectedAuthoritativeRename.mockImplementation(() => {
      events.push('assert-expectation');
    });
    harness.dependencies.applier.restoreRejectedRename.mockImplementation(() => {
      events.push('restore');
      return Promise.resolve({ success: true });
    });
    harness.dependencies.scope.invalidateAuthoritativeReviewContent.mockImplementation(() => {
      events.push('invalidate');
    });
    const feature = createReviewEditableMutationFeature(harness.dependencies);

    await expect(
      feature.restoreRejectedRename(
        { teamName: 'renderer-team', memberName: 'worker' },
        '/renderer/rename.ts',
        { renderer: 'expectation' }
      )
    ).resolves.toEqual({ success: true });

    expect(events).toEqual([
      'parse-expectation',
      'resolve',
      'validate-file',
      'resolve-content',
      'validate-snippets',
      'assert-expectation',
      'restore',
      'invalidate',
    ]);
    expect(harness.dependencies.scope.validateSnippetPaths).toHaveBeenCalledWith(
      harness.authorization,
      harness.content.snippets,
      { requireReviewedFile: true, rejectHardlinks: true }
    );
    expect(harness.dependencies.applier.restoreRejectedRename).toHaveBeenCalledWith(
      RENAMED_FILE_PATH,
      'before\n',
      'after\n',
      harness.content.snippets
    );
  });

  it('invalidates authoritative rename content when reapply fails', async () => {
    const harness = createHarness();
    harness.dependencies.applier.reapplyRejectedRename.mockRejectedValueOnce(
      new Error('reapply incomplete')
    );
    const feature = createReviewEditableMutationFeature(harness.dependencies);

    await expect(
      feature.reapplyRejectedRename(
        { teamName: 'safe-team', memberName: 'worker' },
        RENAMED_FILE_PATH,
        harness.expectation
      )
    ).rejects.toThrow('reapply incomplete');
    expect(harness.dependencies.applier.reapplyRejectedRename).toHaveBeenCalledWith(
      RENAMED_FILE_PATH,
      'before\n',
      harness.content.snippets
    );
    expect(harness.dependencies.scope.invalidateAuthoritativeReviewContent).toHaveBeenCalledWith(
      harness.content
    );
  });

  it('stops before scope resolution when rename expectation parsing fails', async () => {
    const harness = createHarness();
    harness.dependencies.scope.parseReviewRenameRecoveryExpectation.mockImplementationOnce(() => {
      throw new Error('Invalid rename recovery expectation');
    });
    const feature = createReviewEditableMutationFeature(harness.dependencies);

    await expect(
      feature.restoreRejectedRename(
        { teamName: 'safe-team', memberName: 'worker' },
        RENAMED_FILE_PATH,
        null
      )
    ).rejects.toThrow('Invalid rename recovery expectation');
    expect(harness.dependencies.scope.resolveReviewPathAuthorization).not.toHaveBeenCalled();
    expect(harness.dependencies.applier.restoreRejectedRename).not.toHaveBeenCalled();
    expect(harness.dependencies.scope.invalidateAuthoritativeReviewContent).not.toHaveBeenCalled();
  });
});
