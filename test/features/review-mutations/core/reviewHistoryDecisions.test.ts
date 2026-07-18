import { buildReviewExternalReloadState } from '@features/review-mutations';
import { describe, expect, it } from 'vitest';

import type { FileChangeSummary, ReviewPersistedStateSnapshot, ReviewUndoAction } from '@shared/types';

function file(filePath: string, changeKey?: string): FileChangeSummary {
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

function hunkAction(id: string, filePath: string): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-18T08:00:00.000Z',
    kind: 'hunk',
    action: { filePath, originalIndex: 0 },
  };
}

describe('buildReviewExternalReloadState', () => {
  it('drops only the changed file state, preserves independent Undo, and clears scope-wide Redo', () => {
    const changed = file('/repo/changed.ts', 'change:changed');
    const independent = hunkAction('independent', '/repo/other.ts');
    const changedAction = hunkAction('changed', changed.filePath);
    const current: ReviewPersistedStateSnapshot = {
      hunkDecisions: {
        'change:changed:0': 'rejected',
        '/repo/other.ts:0': 'accepted',
      },
      fileDecisions: {
        'change:changed': 'rejected',
        '/repo/other.ts': 'accepted',
      },
      hunkContextHashesByFile: {
        'change:changed': { 0: 'changed-hash' },
        '/repo/other.ts': { 0: 'other-hash' },
      },
      reviewActionHistory: [changedAction, independent],
      reviewRedoHistory: [
        {
          action: { ...changedAction, id: 'changed-redo' },
          decisionSnapshot: {
            hunkDecisions: currentDecisions(),
            fileDecisions: {},
          },
        },
      ],
    };

    expect(buildReviewExternalReloadState(changed, current)).toEqual({
      hunkDecisions: { '/repo/other.ts:0': 'accepted' },
      fileDecisions: { '/repo/other.ts': 'accepted' },
      hunkContextHashesByFile: { '/repo/other.ts': { 0: 'other-hash' } },
      reviewActionHistory: [independent],
      reviewRedoHistory: [],
    });
  });

  it('clears all Undo when a bulk snapshot makes per-file history impossible to split', () => {
    const changed = file('/repo/changed.ts');
    const independent = hunkAction('independent', '/repo/other.ts');
    const bulk: ReviewUndoAction = {
      id: 'bulk',
      createdAt: '2026-07-18T08:00:00.000Z',
      kind: 'bulk',
      decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      diskSnapshots: [],
    };

    const result = buildReviewExternalReloadState(changed, {
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [independent, bulk],
      reviewRedoHistory: [],
    });

    expect(result.reviewActionHistory).toEqual([]);
    expect(result.reviewRedoHistory).toEqual([]);
  });
});

function currentDecisions(): Record<string, 'accepted'> {
  return { '/repo/changed.ts:0': 'accepted' };
}
