import {
  appendOrderedReviewAction,
  isReviewActionPersistenceBlocking,
  popOrderedReviewAction,
  replaceLatestReviewAction,
} from '@features/change-review/renderer';
import { describe, expect, it } from 'vitest';

import {
  createReviewOperationScopeToken,
  getReviewCloseBlockReason,
  getReviewDecisionHydrationGuard,
  getReviewRenameRecoveryExpectation,
  hasReviewFileRejections,
  hasUnresolvedReviewExternalChange,
  hasUnscopedLocalReviewState,
  isReviewActionLocked,
  isReviewDiskPreimageRestored,
  isReviewFileFullyRejected,
  isReviewOperationScopeCurrent,
  partitionReviewFilesByApplyErrors,
  reconcileReviewDecisionRecordsAfterApply,
  replaceReviewScopedRecord,
  resolveDraftBaselineAfterSave,
  resolveReviewFileIsNew,
  restoreReviewDecisionRecordsForFile,
  restoreReviewDecisionRecordsForFiles,
  selectLatestReviewConflictCandidate,
  shouldCreateFileWhenUndoingReject,
  shouldDeleteFileWhenUndoingReject,
  shouldRequestReviewCloseForEscape,
} from '../../../../../src/renderer/components/team/review/reviewActionState';

function makeFile(filePath: string, changeKey?: string) {
  return {
    filePath,
    relativePath: filePath.split('/').pop() ?? filePath,
    changeKey,
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  };
}

describe('ChangeReviewDialog interaction guards', () => {
  it('invalidates stale async operations even when the same scope is reopened', () => {
    const first = createReviewOperationScopeToken('scope-a');
    const reopened = createReviewOperationScopeToken('scope-a');

    expect(isReviewOperationScopeCurrent(first, first)).toBe(true);
    expect(isReviewOperationScopeCurrent(reopened, first)).toBe(false);
    expect(isReviewOperationScopeCurrent(null, first)).toBe(false);
  });

  it('lets an inner modal consume Escape before Changes closes', () => {
    expect(
      shouldRequestReviewCloseForEscape({
        key: 'Escape',
        defaultPrevented: false,
        hasOpenModalLayer: false,
      })
    ).toBe(true);
    expect(
      shouldRequestReviewCloseForEscape({
        key: 'Escape',
        defaultPrevented: true,
        hasOpenModalLayer: false,
      })
    ).toBe(false);
    expect(
      shouldRequestReviewCloseForEscape({
        key: 'Escape',
        defaultPrevented: false,
        hasOpenModalLayer: true,
      })
    ).toBe(false);
  });

  it.each([
    { applying: true, fileApplyCount: 0, undoing: false, closing: false },
    { applying: false, fileApplyCount: 1, undoing: false, closing: false },
    { applying: false, fileApplyCount: 0, undoing: true, closing: false },
    { applying: false, fileApplyCount: 0, undoing: false, closing: true },
  ])('locks every review action for any in-flight mutation: %o', (state) => {
    expect(isReviewActionLocked(state)).toBe(true);
  });

  it('allows review actions only when all mutation lanes are idle', () => {
    expect(
      isReviewActionLocked({
        applying: false,
        fileApplyCount: 0,
        undoing: false,
        closing: false,
      })
    ).toBe(false);
  });

  it('blocks follow-up review actions until the latest accepted action is durably saved', () => {
    expect(isReviewActionPersistenceBlocking('saving')).toBe(true);
    expect(isReviewActionPersistenceBlocking('error')).toBe(true);
    expect(isReviewActionPersistenceBlocking('saved')).toBe(false);
  });

  it('blocks close for drafts and in-flight actions instead of silently discarding state', () => {
    expect(getReviewCloseBlockReason({ busy: true, draftCount: 0 })).toContain('current');
    expect(getReviewCloseBlockReason({ busy: false, draftCount: 1 })).toContain('Save or discard');
    expect(getReviewCloseBlockReason({ busy: false, draftCount: 0 })).toBeNull();
  });

  it('does not close an unscoped review while any local or pending durable state remains', () => {
    const clean = {
      editedContentCount: 0,
      hunkDecisionCount: 0,
      fileDecisionCount: 0,
      undoHistoryCount: 0,
      redoHistoryCount: 0,
      pendingDraftWriteCount: 0,
      draftWriteChainCount: 0,
      draftWriteErrorCount: 0,
      pendingApplyCleanup: false,
      pendingDecisionClear: false,
      persistenceStatus: 'saved' as const,
    };

    expect(hasUnscopedLocalReviewState(clean)).toBe(false);
    for (const dirty of [
      { editedContentCount: 1 },
      { hunkDecisionCount: 1 },
      { fileDecisionCount: 1 },
      { undoHistoryCount: 1 },
      { redoHistoryCount: 1 },
      { pendingDraftWriteCount: 1 },
      { draftWriteChainCount: 1 },
      { draftWriteErrorCount: 1 },
      { pendingApplyCleanup: true },
      { pendingDecisionClear: true },
      { persistenceStatus: 'error' as const },
    ]) {
      expect(hasUnscopedLocalReviewState({ ...clean, ...dirty })).toBe(true);
    }
  });

  it('shows recovery copies newest-first across decision and manual-edit conflicts', () => {
    const decision = {
      id: 'decision',
      capturedAt: '2026-07-19T10:00:00.000Z',
      origin: 'current-snapshot' as const,
      recoverability: 'recoverable' as const,
      expectedRevision: 0,
      observedCurrentRevision: 1,
      hunkDecisionCount: 0,
      fileDecisionCount: 0,
      undoDepth: 0,
      redoDepth: 0,
    };
    const draft = {
      id: 'draft',
      capturedAt: '2026-07-19T10:01:00.000Z',
      origin: 'current-snapshot' as const,
      recoverability: 'recoverable' as const,
      filePath: '/repo/a.ts',
      expectedRevision: 0,
      expectedGeneration: null,
      observedCurrentRevision: 1,
      observedCurrentGeneration: 'generation-1',
      entryRevision: 1,
    };

    expect(selectLatestReviewConflictCandidate([decision], [draft])).toEqual({
      kind: 'draft',
      value: draft,
    });
    expect(selectLatestReviewConflictCandidate([decision], [])).toEqual({
      kind: 'decision',
      value: decision,
    });
  });

  it('replaces stale scoped drafts while preserving unrelated review state', () => {
    expect(
      replaceReviewScopedRecord(
        {
          '/repo/a.ts': 'stale-a',
          '/repo/b.ts': 'keep-b',
          'C:\\Repo\\C.ts': 'stale-c',
        },
        ['/repo/a.ts', 'c:/repo/c.ts'],
        { '/repo/a.ts': 'saved-a' }
      )
    ).toEqual({ '/repo/a.ts': 'saved-a', '/repo/b.ts': 'keep-b' });
  });

  it('distinguishes pending, ready, and failed persisted-decision hydration', () => {
    expect(
      getReviewDecisionHydrationGuard({
        expectedScopeKey: 'scope-a',
        hydratedScopeKey: null,
        status: 'idle',
      })
    ).toBe('pending');
    expect(
      getReviewDecisionHydrationGuard({
        expectedScopeKey: 'scope-a',
        hydratedScopeKey: 'scope-b',
        status: 'loaded',
      })
    ).toBe('pending');
    expect(
      getReviewDecisionHydrationGuard({
        expectedScopeKey: 'scope-a',
        hydratedScopeKey: 'scope-a',
        status: 'loaded',
      })
    ).toBe('ready');
    expect(
      getReviewDecisionHydrationGuard({
        expectedScopeKey: 'scope-a',
        hydratedScopeKey: 'scope-a',
        status: 'error',
      })
    ).toBe('error');
  });

  it('rebases a draft that changes while Save is in flight onto the saved bytes', () => {
    expect(resolveDraftBaselineAfterSave('saved A', 'newer B')).toBe('saved A');
    expect(resolveDraftBaselineAfterSave('saved A', undefined)).toBeUndefined();
  });

  it('blocks saving a draft until a matching external disk change is resolved', () => {
    expect(
      hasUnresolvedReviewExternalChange('/repo/src/file.ts', {
        '/repo/src/other.ts': { type: 'change' },
        '/repo/src/file.ts': { type: 'unlink' },
      })
    ).toBe(true);
    expect(
      hasUnresolvedReviewExternalChange('/repo/src/file.ts', {
        '/repo/src/other.ts': { type: 'change' },
      })
    ).toBe(false);
  });

  it('prefers resolved content when legacy summary new-file metadata disagrees', () => {
    const file = makeFile('/repo/file.ts');
    expect(
      resolveReviewFileIsNew(file, {
        ...file,
        isNewFile: true,
        originalFullContent: '',
        modifiedFullContent: 'created',
        contentSource: 'disk-current',
      })
    ).toBe(true);
  });

  it('recognizes persisted full or partial rejection so file Accept can restore disk', () => {
    const file = makeFile('/repo/file.ts');
    expect(
      hasReviewFileRejections(file, 2, {
        hunkDecisions: {},
        fileDecisions: { '/repo/file.ts': 'rejected' },
      })
    ).toBe(true);
    expect(
      hasReviewFileRejections(file, 2, {
        hunkDecisions: {
          '/repo/file.ts:0': 'rejected',
          '/repo/file.ts:1': 'pending',
        },
        fileDecisions: {},
      })
    ).toBe(true);
    expect(
      hasReviewFileRejections(file, 2, {
        hunkDecisions: {
          '/repo/file.ts:0': 'accepted',
          '/repo/file.ts:1': 'pending',
        },
        fileDecisions: {},
      })
    ).toBe(false);
  });

  it('distinguishes a complete rejection from a partial rejection', () => {
    const file = makeFile('/repo/file.ts');
    expect(
      isReviewFileFullyRejected(file, 2, {
        hunkDecisions: { '/repo/file.ts:0': 'rejected', '/repo/file.ts:1': 'pending' },
        fileDecisions: {},
      })
    ).toBe(false);
    expect(
      isReviewFileFullyRejected(file, 2, {
        hunkDecisions: { '/repo/file.ts:0': 'rejected', '/repo/file.ts:1': 'rejected' },
        fileDecisions: {},
      })
    ).toBe(true);
  });

  it('deletes on Undo only for the first rejection of an agent-deleted file', () => {
    const file = {
      ...makeFile('/repo/deleted.ts'),
      ledgerSummary: { latestOperation: 'delete' as const },
    };

    expect(
      shouldDeleteFileWhenUndoingReject(file, 2, {
        hunkDecisions: {},
        fileDecisions: {},
      })
    ).toBe(true);
    expect(
      shouldDeleteFileWhenUndoingReject(file, 2, {
        hunkDecisions: { '/repo/deleted.ts:0': 'rejected' },
        fileDecisions: {},
      })
    ).toBe(false);
    expect(
      shouldDeleteFileWhenUndoingReject(makeFile('/repo/modified.ts'), 1, {
        hunkDecisions: {},
        fileDecisions: {},
      })
    ).toBe(false);
  });

  it('recreates a new file on Undo only when the rejection removed its final hunk', () => {
    const file = { ...makeFile('/repo/new.ts'), isNewFile: true };

    expect(
      shouldCreateFileWhenUndoingReject(file, true, 2, {
        hunkDecisions: {
          '/repo/new.ts:0': 'rejected',
          '/repo/new.ts:1': 'rejected',
        },
        fileDecisions: {},
      })
    ).toBe(true);
    expect(
      shouldCreateFileWhenUndoingReject(file, true, 2, {
        hunkDecisions: { '/repo/new.ts:0': 'rejected' },
        fileDecisions: {},
      })
    ).toBe(false);
    expect(
      shouldCreateFileWhenUndoingReject(file, false, 1, {
        hunkDecisions: { '/repo/new.ts:0': 'rejected' },
        fileDecisions: {},
      })
    ).toBe(false);
  });

  it('captures immutable ledger identity for guarded rename recovery', () => {
    const file = {
      ...makeFile('/repo/new.ts'),
      snippets: [
        {
          toolUseId: 'rename-1',
          filePath: '/repo/new.ts',
          toolName: 'Bash' as const,
          type: 'shell-snapshot' as const,
          oldString: '',
          newString: 'new',
          replaceAll: false,
          timestamp: '2026-07-17T10:00:00.000Z',
          isError: false,
          ledger: {
            eventId: 'event-1',
            source: 'ledger-snapshot' as const,
            confidence: 'high' as const,
            originalFullContent: 'old',
            modifiedFullContent: 'new',
            beforeHash: 'before-hash',
            afterHash: 'after-hash',
            relation: {
              kind: 'rename' as const,
              oldPath: '/repo/old.ts',
              newPath: '/repo/new.ts',
            },
          },
        },
      ],
    };

    expect(getReviewRenameRecoveryExpectation(file)).toEqual({
      eventId: 'event-1',
      beforeHash: 'before-hash',
      afterHash: 'after-hash',
      relation: { kind: 'rename', oldPath: '/repo/old.ts', newPath: '/repo/new.ts' },
    });
  });

  it('partitions a mixed Reject All result so only successful files are finalized', () => {
    const first = makeFile('/repo/first.ts');
    const second = makeFile('/repo/second.ts');

    expect(partitionReviewFilesByApplyErrors([first, second], ['/repo/second.ts'])).toEqual({
      successful: [first],
      failed: [second],
    });
    expect(partitionReviewFilesByApplyErrors([first, second], null)).toEqual({
      successful: [],
      failed: [first, second],
    });
  });

  it('fails closed when a Reject All error cannot be attributed to a requested file', () => {
    const files = [makeFile('/repo/first.ts'), makeFile('/repo/second.ts')];
    expect(partitionReviewFilesByApplyErrors(files, ['/repo/rename-source.ts'])).toEqual({
      successful: [],
      failed: files,
    });
    expect(
      partitionReviewFilesByApplyErrors(files, ['/repo/second.ts', '/repo/rename-source.ts'])
    ).toEqual({
      successful: [],
      failed: files,
    });
  });

  it('restores only the failed file decisions, including ledger changeKey entries', () => {
    const file = makeFile('/repo/new.ts', 'rename:/repo/old.ts->/repo/new.ts');
    const restored = restoreReviewDecisionRecordsForFile(
      file,
      {
        hunkDecisions: {
          'rename:/repo/old.ts->/repo/new.ts:0': 'rejected',
          '/repo/other.ts:0': 'rejected',
        },
        fileDecisions: {
          'rename:/repo/old.ts->/repo/new.ts': 'rejected',
          '/repo/other.ts': 'rejected',
        },
      },
      {
        hunkDecisions: {
          'rename:/repo/old.ts->/repo/new.ts:0': 'accepted',
          '/repo/other.ts:0': 'pending',
        },
        fileDecisions: {
          'rename:/repo/old.ts->/repo/new.ts': 'pending',
          '/repo/other.ts': 'pending',
        },
      }
    );

    expect(restored.hunkDecisions).toEqual({
      'rename:/repo/old.ts->/repo/new.ts:0': 'accepted',
      '/repo/other.ts:0': 'rejected',
    });
    expect(restored.fileDecisions).toEqual({
      'rename:/repo/old.ts->/repo/new.ts': 'pending',
      '/repo/other.ts': 'rejected',
    });
  });

  it('keeps successful Reject All decisions and rolls back only failed files', () => {
    const first = makeFile('/repo/first.ts');
    const second = makeFile('/repo/second.ts');
    const result = reconcileReviewDecisionRecordsAfterApply(
      [first, second],
      [second.filePath],
      {
        hunkDecisions: {
          [`${first.filePath}:0`]: 'rejected',
          [`${second.filePath}:0`]: 'rejected',
        },
        fileDecisions: {
          [first.filePath]: 'rejected',
          [second.filePath]: 'rejected',
        },
      },
      {
        hunkDecisions: {},
        fileDecisions: {},
      }
    );

    expect(result.successful).toEqual([first]);
    expect(result.failed).toEqual([second]);
    expect(result.hunkDecisions).toEqual({ [`${first.filePath}:0`]: 'rejected' });
    expect(result.fileDecisions).toEqual({ [first.filePath]: 'rejected' });
  });

  it('restores decisions only for files whose bulk disk Undo succeeded', () => {
    const first = makeFile('/repo/first.ts');
    const second = makeFile('/repo/second.ts');
    const restored = restoreReviewDecisionRecordsForFiles(
      [first],
      {
        hunkDecisions: {
          [`${first.filePath}:0`]: 'rejected',
          [`${second.filePath}:0`]: 'rejected',
        },
        fileDecisions: {
          [first.filePath]: 'rejected',
          [second.filePath]: 'rejected',
        },
      },
      {
        hunkDecisions: {
          [`${first.filePath}:0`]: 'accepted',
          [`${second.filePath}:0`]: 'accepted',
        },
        fileDecisions: {
          [first.filePath]: 'accepted',
          [second.filePath]: 'accepted',
        },
      }
    );

    expect(restored.hunkDecisions).toEqual({
      [`${first.filePath}:0`]: 'accepted',
      [`${second.filePath}:0`]: 'rejected',
    });
    expect(restored.fileDecisions).toEqual({
      [first.filePath]: 'accepted',
      [second.filePath]: 'rejected',
    });
  });

  it('undoes review actions strictly in LIFO order across multiple levels', () => {
    const first = { kind: 'hunk', id: 1 };
    const second = { kind: 'disk', id: 2 };
    let stack = appendOrderedReviewAction([], first);
    stack = appendOrderedReviewAction(stack, second);

    const wrongOrder = popOrderedReviewAction(stack, first);
    expect(wrongOrder).toEqual({ stack: [first, second], popped: false });

    const undoSecond = popOrderedReviewAction(stack, second);
    expect(undoSecond).toEqual({ stack: [first], popped: true });
    const undoFirst = popOrderedReviewAction(undoSecond.stack, first);
    expect(undoFirst).toEqual({ stack: [], popped: true });
  });

  it('keeps ordered review history beyond the former ten-action limit', () => {
    const actions = Array.from({ length: 100 }, (_, index) => `action-${index}`);
    let stack: string[] = [];
    for (const action of actions) stack = appendOrderedReviewAction(stack, action, 10);
    expect(stack).toEqual(actions);
  });

  it('replaces only the optimistic top action with main-bound durable metadata', () => {
    const older = {
      id: 'older',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/older.ts', originalIndex: 0 },
    };
    const optimistic = {
      id: 'latest',
      createdAt: '2026-07-17T12:00:01.000Z',
      kind: 'disk' as const,
      action: {
        originalIndex: 0,
        snapshot: { filePath: '/repo/file.ts', beforeContent: 'before', afterContent: 'after' },
      },
    };
    const committed = {
      ...optimistic,
      action: {
        ...optimistic.action,
        snapshot: {
          ...optimistic.action.snapshot,
          restoreMode: 'content' as const,
          authoritativeBeforeSha256: 'authoritative',
        },
      },
    };

    expect(replaceLatestReviewAction([older, optimistic], optimistic, committed)).toEqual({
      stack: [older, committed],
      replaced: true,
    });
    expect(replaceLatestReviewAction([older, optimistic], older, committed)).toEqual({
      stack: [older, optimistic],
      replaced: false,
    });
  });

  it('recognizes an already-restored disk preimage for crash-safe Undo retry', () => {
    expect(
      isReviewDiskPreimageRestored(
        {
          hasConflict: false,
          currentContent: 'before',
          conflictContent: null,
          originalContent: 'before',
        },
        'before'
      )
    ).toBe(true);
    expect(
      isReviewDiskPreimageRestored(
        { hasConflict: true, currentContent: '', conflictContent: null, originalContent: '' },
        null
      )
    ).toBe(true);
    expect(
      isReviewDiskPreimageRestored(
        {
          hasConflict: true,
          currentContent: 'external',
          conflictContent: 'external',
          originalContent: 'before',
        },
        'before'
      )
    ).toBe(false);
  });
});
