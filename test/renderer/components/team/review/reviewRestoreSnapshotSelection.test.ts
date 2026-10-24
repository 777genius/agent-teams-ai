import { describe, expect, it } from 'vitest';

import { selectReviewRestoreSnapshots } from '../../../../../src/renderer/components/team/review/reviewRestoreSnapshotSelection';

import type { FileChangeSummary, ReviewDiskUndoAction } from '@shared/types';

function file(filePath: string, changeKey?: string): FileChangeSummary {
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

function diskAction(
  entry: FileChangeSummary | undefined,
  filePath: string,
  beforeContent: string,
  afterContent: string | null
): ReviewDiskUndoAction {
  return {
    snapshot: { filePath, file: entry, beforeContent, afterContent },
    file: entry,
  };
}

describe('Restore snapshot selection', () => {
  it('restores the edit entry after the sibling rename was rejected and restored', () => {
    const path = '/sandbox/review/new.ts';
    const rename = file(path, 'rename:/sandbox/review/old.ts->/sandbox/review/new.ts');
    const edit = file(path, 'path:/sandbox/review/new.ts');
    const editRejection = diskAction(edit, path, 'edited-by-agent', 'renamed');
    const renameRejection = diskAction(rename, path, 'renamed', 'old');
    const renameRestore = diskAction(rename, path, 'old', 'renamed');

    const selected = selectReviewRestoreSnapshots([rename, edit], edit, [
      editRejection,
      renameRejection,
      renameRestore,
    ]);

    expect(selected.latestDiskSnapshot).toBe(editRejection.snapshot);
    expect(selected.sessionSnapshot).toBe(editRejection.snapshot);
    expect(selected.sessionSnapshot?.beforeContent).toBe('edited-by-agent');
    expect(selected.sessionSnapshot?.afterContent).toBe('renamed');
  });

  it('does not assign unkeyed legacy history to either duplicate-path entry', () => {
    const path = '/sandbox/review/new.ts';
    const rename = file(path, 'rename:/sandbox/review/old.ts->/sandbox/review/new.ts');
    const edit = file(path, 'path:/sandbox/review/new.ts');
    const legacy = diskAction(undefined, path, 'unknown', 'old');

    expect(selectReviewRestoreSnapshots([rename, edit], rename, [legacy])).toEqual({
      latestDiskSnapshot: undefined,
      sessionSnapshot: undefined,
    });
    expect(selectReviewRestoreSnapshots([rename, edit], edit, [legacy])).toEqual({
      latestDiskSnapshot: undefined,
      sessionSnapshot: undefined,
    });
  });

  it('uses path fallback when a unique entry or its legacy snapshot lacks changeKey', () => {
    const path = '/sandbox/review/file.ts';
    const keyed = file(path, 'path:/sandbox/review/file.ts');
    const unkeyed = file(path);
    const legacy = diskAction(undefined, path, 'edited', 'original');
    const keyedHistory = diskAction(keyed, path, 'edited', 'original');

    expect(selectReviewRestoreSnapshots([keyed], keyed, [legacy]).sessionSnapshot).toBe(
      legacy.snapshot
    );
    expect(selectReviewRestoreSnapshots([unkeyed], unkeyed, [keyedHistory]).sessionSnapshot).toBe(
      keyedHistory.snapshot
    );
  });

  it('keeps case-distinct paths separate', () => {
    const upper = file('C:\\Repo\\File.ts');
    const lower = file('C:\\Repo\\file.ts');
    const upperAction = diskAction(upper, upper.filePath, 'upper-new', 'upper-old');
    const lowerAction = diskAction(lower, lower.filePath, 'lower-new', 'lower-old');

    expect(
      selectReviewRestoreSnapshots([upper, lower], upper, [upperAction, lowerAction])
        .sessionSnapshot
    ).toBe(upperAction.snapshot);
    expect(
      selectReviewRestoreSnapshots([upper, lower], lower, [upperAction, lowerAction])
        .sessionSnapshot
    ).toBe(lowerAction.snapshot);
  });
});
