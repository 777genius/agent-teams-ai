import {
  buildReviewExternalReloadState,
  buildReviewHistoryRestorePlan,
} from '@features/review-mutations';
import { describe, expect, it } from 'vitest';

import type {
  FileChangeSummary,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
} from '@shared/types';

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

describe('buildReviewHistoryRestorePlan', () => {
  const reviewedFile = file('/repo/history.ts', 'history-change');
  const actions = [0, 1, 2].map(
    (originalIndex): ReviewUndoAction => ({
      id: `action-${originalIndex}`,
      createdAt: `2026-07-18T08:00:0${originalIndex}.000Z`,
      kind: 'hunk',
      action: { filePath: reviewedFile.filePath, originalIndex },
    })
  );
  const current = (): ReviewPersistedStateSnapshot => ({
    hunkDecisions: {
      'history-change:0': 'accepted',
      'history-change:1': 'rejected',
      'history-change:2': 'accepted',
    },
    fileDecisions: {},
    hunkContextHashesByFile: { 'history-change': { 0: 'a', 1: 'b', 2: 'c' } },
    reviewActionHistory: structuredClone(actions),
    reviewRedoHistory: [],
  });
  const resolveFile = (filePath: string): FileChangeSummary | null =>
    filePath === reviewedFile.filePath ? reviewedFile : null;

  it('keeps an Undo target applied and moves only newer actions to Redo', () => {
    const input = current();
    const untouched = structuredClone(input);

    const plan = buildReviewHistoryRestorePlan(
      input,
      { kind: 'after-action', stack: 'undo', actionId: 'action-1' },
      resolveFile
    );

    expect(plan).toMatchObject({
      direction: 'undo',
      actionCount: 1,
      orderedActions: [{ id: 'action-2' }],
      persistedState: {
        hunkDecisions: {
          'history-change:0': 'accepted',
          'history-change:1': 'rejected',
        },
        reviewActionHistory: [{ id: 'action-0' }, { id: 'action-1' }],
        reviewRedoHistory: [{ action: { id: 'action-2' } }],
      },
    });
    expect(input).toEqual(untouched);
  });

  it('restores Start and then replays Redo through the selected checkpoint', () => {
    const atStart = buildReviewHistoryRestorePlan(current(), { kind: 'start' }, resolveFile);
    expect(atStart.direction).toBe('undo');
    expect(atStart.orderedActions.map((action) => action.id)).toEqual([
      'action-2',
      'action-1',
      'action-0',
    ]);
    expect(atStart.persistedState.reviewActionHistory).toEqual([]);
    expect(atStart.persistedState.reviewRedoHistory.map((entry) => entry.action.id)).toEqual([
      'action-2',
      'action-1',
      'action-0',
    ]);

    const afterSecond = buildReviewHistoryRestorePlan(
      atStart.persistedState,
      { kind: 'after-action', stack: 'redo', actionId: 'action-1' },
      resolveFile
    );
    expect(afterSecond.direction).toBe('redo');
    expect(afterSecond.orderedActions.map((action) => action.id)).toEqual(['action-0', 'action-1']);
    expect(afterSecond.persistedState.reviewActionHistory.map((action) => action.id)).toEqual([
      'action-0',
      'action-1',
    ]);
    expect(afterSecond.persistedState.reviewRedoHistory.map((entry) => entry.action.id)).toEqual([
      'action-2',
    ]);
  });

  it('returns a no-op for the current checkpoint and rejects stale or duplicate ids', () => {
    expect(
      buildReviewHistoryRestorePlan(
        current(),
        { kind: 'after-action', stack: 'undo', actionId: 'action-2' },
        resolveFile
      )
    ).toMatchObject({ direction: 'none', actionCount: 0, orderedActions: [] });
    expect(() =>
      buildReviewHistoryRestorePlan(
        current(),
        { kind: 'after-action', stack: 'redo', actionId: 'missing' },
        resolveFile
      )
    ).toThrow('selected Redo checkpoint is no longer available');
    const duplicate = current();
    duplicate.reviewRedoHistory.push({
      action: structuredClone(actions[0]!),
      decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
    });
    expect(() => buildReviewHistoryRestorePlan(duplicate, { kind: 'start' }, resolveFile)).toThrow(
      'duplicate action ids'
    );
  });
});

function currentDecisions(): Record<string, 'accepted'> {
  return { '/repo/changed.ts:0': 'accepted' };
}
