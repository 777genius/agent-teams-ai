import {
  buildRedoDiskMutationSteps,
  buildUndoDiskMutationSteps,
  createReviewRedoAction,
  executeWithPreparedReviewWriteExpectations,
  getReviewDiskMutationExpectedContent,
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
});
