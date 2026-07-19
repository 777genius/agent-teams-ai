import { restoreReviewDecisionRecordsForFile } from '@features/review-mutations';
import {
  areReviewPersistedStatesEqual,
  buildForwardDiskMutationSteps,
  buildRedoDiskMutationSteps,
  buildUndoDiskMutationSteps,
  classifyReviewHistoryRecovery,
  createReviewRedoAction,
  executeWithPreparedReviewWriteExpectations,
  getReviewDiskMutationExpectedContent,
  markReviewMutationDiskPostimages,
} from '@renderer/components/team/review/reviewHistoryTimeline';
import { describe, expect, it } from 'vitest';

import type { HunkDecision, ReviewDiskUndoSnapshot, ReviewUndoAction } from '@shared/types';

function snapshot(
  restoreMode: ReviewDiskUndoSnapshot['restoreMode'] = 'content'
): ReviewDiskUndoSnapshot {
  return {
    filePath: '/repo/file.ts',
    beforeContent: 'before\n',
    afterContent: 'after\n',
    restoreMode,
  };
}

describe('review history timeline', () => {
  it('compares durable states independently of record key order', () => {
    const left = {
      hunkDecisions: { 'file.ts:1': 'rejected' as const, 'file.ts:0': 'accepted' as const },
      fileDecisions: {},
      hunkContextHashesByFile: undefined,
      reviewActionHistory: [],
      reviewRedoHistory: [],
    };
    const equivalent = {
      hunkDecisions: { 'file.ts:0': 'accepted' as const, 'file.ts:1': 'rejected' as const },
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
    };
    const different = {
      ...equivalent,
      hunkDecisions: { ...equivalent.hunkDecisions, 'file.ts:1': 'accepted' as const },
    };

    expect(areReviewPersistedStatesEqual(left, equivalent)).toBe(true);
    expect(areReviewPersistedStatesEqual(left, different)).toBe(false);

    expect(
      classifyReviewHistoryRecovery(
        {
          decisionRevision: 3,
          recoveredMutation: false,
          recoveredRestoreHistory: false,
          differentMutationPending: false,
          persistedState: equivalent,
          expectedRestoreCompleted: false,
          diskPostimages: [],
          retried: false,
        },
        3,
        left
      )
    ).toBe('retry-restore');
    expect(
      classifyReviewHistoryRecovery(
        {
          decisionRevision: 4,
          recoveredMutation: true,
          recoveredRestoreHistory: true,
          differentMutationPending: false,
          persistedState: equivalent,
          expectedRestoreCompleted: true,
          diskPostimages: [{ filePath: '/repo/file.ts', content: 'before\n' }],
          retried: true,
        },
        3,
        left
      )
    ).toBe('apply-selected-restore');
    expect(
      classifyReviewHistoryRecovery(
        {
          decisionRevision: 4,
          recoveredMutation: true,
          recoveredRestoreHistory: true,
          differentMutationPending: false,
          persistedState: different,
          expectedRestoreCompleted: false,
          diskPostimages: [],
          retried: true,
        },
        3,
        left
      )
    ).toBe('synchronize-latest');
    expect(
      classifyReviewHistoryRecovery(
        {
          decisionRevision: 4,
          recoveredMutation: false,
          recoveredRestoreHistory: false,
          differentMutationPending: false,
          persistedState: equivalent,
          expectedRestoreCompleted: true,
          diskPostimages: [{ filePath: '/repo/file.ts', content: 'before\n' }],
          retried: false,
        },
        3,
        left
      )
    ).toBe('apply-selected-restore');
    expect(
      classifyReviewHistoryRecovery(
        {
          decisionRevision: 3,
          recoveredMutation: false,
          recoveredRestoreHistory: false,
          differentMutationPending: true,
          persistedState: left,
          expectedRestoreCompleted: false,
          diskPostimages: [],
          retried: false,
        },
        3,
        left
      )
    ).toBe('different-mutation-pending');
  });

  it('inverts content, create, and delete snapshots without weakening CAS', () => {
    expect(buildUndoDiskMutationSteps('action', [snapshot('content')])).toEqual([
      {
        id: 'action:0',
        type: 'write',
        filePath: '/repo/file.ts',
        expectedContent: 'after\n',
        content: 'before\n',
      },
    ]);
    expect(buildRedoDiskMutationSteps('action', [snapshot('content')])).toEqual([
      {
        id: 'action:redo:0',
        type: 'write',
        filePath: '/repo/file.ts',
        expectedContent: 'before\n',
        content: 'after\n',
      },
    ]);
    expect(buildForwardDiskMutationSteps('action', [snapshot('content')])).toEqual([
      {
        id: 'action:0',
        type: 'write',
        filePath: '/repo/file.ts',
        expectedContent: 'before\n',
        content: 'after\n',
      },
    ]);
    expect(buildRedoDiskMutationSteps('action', [snapshot('create-file')])).toEqual([
      {
        id: 'action:redo:0',
        type: 'delete',
        filePath: '/repo/file.ts',
        expectedContent: 'before\n',
      },
    ]);
    expect(buildRedoDiskMutationSteps('action', [snapshot('delete-file')])).toEqual([
      {
        id: 'action:redo:0',
        type: 'write',
        filePath: '/repo/file.ts',
        expectedContent: null,
        content: 'after\n',
      },
    ]);
  });

  it('inverts rename recovery direction using the same immutable expectation', () => {
    const renameExpectation = {
      eventId: 'rename-event',
      beforeHash: 'before-hash',
      afterHash: 'after-hash',
      relation: {
        kind: 'rename' as const,
        oldPath: '/repo/old.ts',
        newPath: '/repo/file.ts',
      },
    };
    const rename = { ...snapshot('restore-rejected-rename'), renameExpectation };
    expect(buildRedoDiskMutationSteps('action', [rename])).toEqual([
      {
        id: 'action:redo:0',
        type: 'reapply-rejected-rename',
        filePath: '/repo/file.ts',
        expectation: renameExpectation,
      },
    ]);
    expect(
      buildRedoDiskMutationSteps('action', [{ ...rename, restoreMode: 'reapply-rejected-rename' }])
    ).toEqual([
      {
        id: 'action:redo:0',
        type: 'restore-rejected-rename',
        filePath: '/repo/file.ts',
        expectation: renameExpectation,
      },
    ]);

    expect(getReviewDiskMutationExpectedContent(rename, 'undo')).toBe('before\n');
    expect(getReviewDiskMutationExpectedContent(rename, 'redo')).toBeNull();
    const reverseRename = { ...rename, restoreMode: 'reapply-rejected-rename' as const };
    expect(getReviewDiskMutationExpectedContent(reverseRename, 'undo')).toBeNull();
    expect(getReviewDiskMutationExpectedContent(reverseRename, 'redo')).toBe('after\n');
    expect(getReviewDiskMutationExpectedContent(snapshot('create-file'), 'undo')).toBe('before\n');
    expect(getReviewDiskMutationExpectedContent(snapshot('create-file'), 'redo')).toBeNull();
  });

  it('keeps a conflicting Redo fail-closed and captures an immutable forward state', () => {
    expect(() =>
      buildRedoDiskMutationSteps('action', [
        { ...snapshot(), restoreConflict: 'external edit conflicts with history' },
      ])
    ).toThrow('external edit conflicts with history');

    const action: ReviewUndoAction = {
      id: 'hunk-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk',
      action: { filePath: '/repo/file.ts', originalIndex: 0 },
    };
    const state: {
      hunkDecisions: Record<string, HunkDecision>;
      fileDecisions: Record<string, HunkDecision>;
      hunkContextHashesByFile: Record<string, Record<number, string>>;
    } = {
      hunkDecisions: { 'file:0': 'accepted' },
      fileDecisions: {},
      hunkContextHashesByFile: { file: { 0: 'hash' } },
    };
    const redo = createReviewRedoAction(action, state);
    state.hunkDecisions['file:0'] = 'rejected';
    state.hunkContextHashesByFile.file[0] = 'changed';
    expect(redo).toMatchObject({
      action,
      decisionSnapshot: { hunkDecisions: { 'file:0': 'accepted' } },
      hunkContextHashesByFile: { file: { 0: 'hash' } },
    });
  });

  it('registers watcher suppression before an Undo or Redo IPC can mutate disk', async () => {
    const marked = new Map<string, string | null>();
    let releaseMutation: (() => void) | undefined;
    const mutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const pending = executeWithPreparedReviewWriteExpectations(
      [snapshot('content')],
      'redo',
      (filePath, expectedContent) => marked.set(filePath, expectedContent),
      () => mutation
    );

    expect(marked).toEqual(new Map([['/repo/file.ts', 'after\n']]));
    releaseMutation?.();
    await pending;
  });

  it('replaces provisional rename expectations with exact main-process postimages', () => {
    const marked = new Map<string, string | null>();
    marked.set('/repo/new.ts', null);

    markReviewMutationDiskPostimages(
      [
        { filePath: '/repo/old.ts', content: null },
        { filePath: '/repo/new.ts', content: 'authoritative agent content\n' },
      ],
      (filePath, content) => marked.set(filePath, content)
    );

    expect(marked).toEqual(
      new Map([
        ['/repo/new.ts', 'authoritative agent content\n'],
        ['/repo/old.ts', null],
      ])
    );
  });

  it('restores only exact numeric hunk aliases for the selected review key', () => {
    const file = {
      filePath: '/repo/a',
      changeKey: 'change:a',
      relativePath: 'a',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: false,
    };
    expect(
      restoreReviewDecisionRecordsForFile(
        file,
        {
          hunkDecisions: {
            'change:a:0': 'rejected',
            '/repo/a:1': 'rejected',
            '/repo/a:shadow:0': 'accepted',
            'change:a:shadow:0': 'accepted',
          },
          fileDecisions: {},
        },
        { hunkDecisions: { 'change:a:0': 'accepted' }, fileDecisions: {} }
      )
    ).toEqual({
      hunkDecisions: {
        'change:a:0': 'accepted',
        '/repo/a:shadow:0': 'accepted',
        'change:a:shadow:0': 'accepted',
      },
      fileDecisions: {},
    });
  });
});
