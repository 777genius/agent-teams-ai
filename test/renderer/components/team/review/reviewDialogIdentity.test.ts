import { describe, expect, it } from 'vitest';
import { buildReviewHistoryRestorePlan } from '@features/review-mutations';

import {
  getReviewPhysicalPathEntries,
  hasReviewDraftForEntry,
  resolveReviewHistoryActionFile,
} from '../../../../../src/renderer/components/team/review/reviewDialogIdentity';

import type { FileChangeSummary, ReviewUndoAction } from '@shared/types';

function file(filePath: string, changeKey: string): FileChangeSummary {
  return {
    filePath,
    relativePath: filePath.split(/[\\/]/).at(-1) ?? filePath,
    changeKey,
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  };
}

function rejected(file: FileChangeSummary): Extract<ReviewUndoAction, { kind: 'disk' }> {
  return {
    id: 'reject-edit',
    createdAt: '2026-09-29T00:00:00.000Z',
    kind: 'disk',
    action: {
      file,
      snapshot: { filePath: file.filePath, file, beforeContent: 'agent', afterContent: 'disk' },
      decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
    },
  };
}

describe('review dialog entry identity', () => {
  const path = '/sandbox/review/new.ts';
  const rename = file(path, 'rename:/sandbox/review/old.ts->/sandbox/review/new.ts');
  const edit = file(path, 'path:/sandbox/review/new.ts');

  it('groups all entries for one exact physical path without folding case', () => {
    const differentlyCased = file('/sandbox/review/New.ts', 'path:/sandbox/review/New.ts');
    expect(getReviewPhysicalPathEntries([rename, edit, differentlyCased], path)).toEqual([
      rename,
      edit,
    ]);
  });

  it('resolves an interrupted Restore of the second sibling from persisted identity', () => {
    const action = rejected(edit);
    expect(resolveReviewHistoryActionFile([rename, edit], path, action)).toBe(edit);
    expect(resolveReviewHistoryActionFile([rename, edit], path, rejected(rename))).toBe(rename);
    expect(
      resolveReviewHistoryActionFile([rename, edit], path, {
        ...action,
        action: { ...action.action, file: rename },
      } as ReviewUndoAction)
    ).toBeNull();
  });

  it('keeps the rename decision while Retry Restore undoes only the edit entry', () => {
    const renameAction = { ...rejected(rename), id: 'reject-rename' };
    const editAction = {
      ...rejected(edit),
      action: {
        ...rejected(edit).action,
        decisionSnapshot: {
          hunkDecisions: {},
          fileDecisions: { [edit.changeKey!]: 'accepted' as const },
        },
      },
    };
    const plan = buildReviewHistoryRestorePlan(
      {
        hunkDecisions: {},
        fileDecisions: { [rename.changeKey!]: 'rejected', [edit.changeKey!]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [renameAction, editAction],
        reviewRedoHistory: [],
      },
      { kind: 'after-action', stack: 'undo', actionId: renameAction.id },
      (filePath, action) => resolveReviewHistoryActionFile([rename, edit], filePath, action)
    );
    expect(plan.persistedState.fileDecisions).toEqual({
      [rename.changeKey!]: 'rejected',
      [edit.changeKey!]: 'accepted',
    });
    expect(plan.persistedState.reviewRedoHistory[0]?.action.id).toBe(editAction.id);
  });

  it('fails closed when duplicate-path history has no persisted entry key', () => {
    const action = rejected(edit);
    const legacy = {
      ...action,
      action: {
        ...action.action,
        file: undefined,
        snapshot: { ...action.action.snapshot, file: undefined },
      },
    } as ReviewUndoAction;
    expect(resolveReviewHistoryActionFile([rename, edit], path, legacy)).toBeNull();
    expect(resolveReviewHistoryActionFile([edit], path, legacy)).toBe(edit);
  });

  it('recognizes a physical-path draft in the focused duplicate entry editor', () => {
    expect(
      hasReviewDraftForEntry([rename, edit], { [path]: 'manual draft' }, edit.changeKey!)
    ).toBe(true);
    expect(hasReviewDraftForEntry([rename, edit], {}, edit.changeKey!)).toBe(false);
    expect(hasReviewDraftForEntry([rename, edit], { [path]: 'manual draft' }, 'other')).toBe(false);
  });
});
