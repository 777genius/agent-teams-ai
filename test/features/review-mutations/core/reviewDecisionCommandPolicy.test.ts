import {
  assertCurrentReviewDecisionRevision,
  assertExactApplyReviewHistoryTransition,
} from '@features/review-mutations/main';
import { describe, expect, it } from 'vitest';

import type {
  FileChangeSummary,
  FileReviewDecision,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
} from '@shared/types/review';

const FILE_PATH = '/sandbox/fixture.ts';
const REVIEW_KEY = 'fixture-change';

const file: FileChangeSummary = {
  filePath: FILE_PATH,
  relativePath: 'fixture.ts',
  snippets: [],
  linesAdded: 1,
  linesRemoved: 1,
  isNewFile: false,
  changeKey: REVIEW_KEY,
};

const current = {
  hunkDecisions: {},
  fileDecisions: {},
  hunkContextHashesByFile: {},
  reviewActionHistory: [],
  reviewRedoHistory: [],
  revision: 4,
};

const decision: FileReviewDecision & { reviewKey: string } = {
  filePath: FILE_PATH,
  reviewKey: REVIEW_KEY,
  fileDecision: 'rejected',
  hunkDecisions: {},
};

function createAction(id = 'action-1'): Extract<ReviewUndoAction, { kind: 'disk' }> {
  return {
    id,
    createdAt: '2026-07-24T00:00:00.000Z',
    kind: 'disk',
    descriptor: { intent: 'reject-file', filePath: FILE_PATH },
    action: {
      snapshot: {
        filePath: FILE_PATH,
        beforeContent: 'after\n',
        afterContent: 'before\n',
      },
      decisionSnapshot: {
        hunkDecisions: current.hunkDecisions,
        fileDecisions: current.fileDecisions,
      },
    },
  };
}

function createState(action = createAction()): ReviewPersistedStateSnapshot {
  return {
    hunkDecisions: {},
    fileDecisions: { [REVIEW_KEY]: 'rejected' },
    hunkContextHashesByFile: {},
    reviewActionHistory: [action],
    reviewRedoHistory: [],
  };
}

const context = {
  resolveFile: () => file,
  normalizePath: (filePath: string) => filePath,
};

describe('review decision command policy', () => {
  it('accepts an exact file Reject transition at the expected revision', () => {
    expect(() => assertCurrentReviewDecisionRevision(current, 4)).not.toThrow();
    expect(() =>
      assertExactApplyReviewHistoryTransition(createState(), current, [decision], context)
    ).not.toThrow();
  });

  it('rejects a stale revision and a reused durable action id', () => {
    expect(() => assertCurrentReviewDecisionRevision(current, 3)).toThrow(
      'Review decisions changed; refusing stale state overwrite'
    );

    const reused = createAction('known-action');
    expect(() =>
      assertExactApplyReviewHistoryTransition(
        createState(reused),
        { ...current, reviewRedoHistory: [{ action: reused, decisionSnapshot: current }] },
        [decision],
        context
      )
    ).toThrow('Durable Reject requires exactly one new disk history action');
  });

  it('rejects off-scope decision changes and a forged action descriptor', () => {
    expect(() =>
      assertExactApplyReviewHistoryTransition(
        {
          ...createState(),
          fileDecisions: { [REVIEW_KEY]: 'rejected', 'other-change': 'accepted' },
        },
        current,
        [decision],
        context
      )
    ).toThrow('Durable Reject state changes decisions outside the requested files');

    expect(() =>
      assertExactApplyReviewHistoryTransition(
        createState({
          ...createAction(),
          descriptor: { intent: 'reject-file', filePath: '/sandbox/other.ts' },
        }),
        current,
        [decision],
        context
      )
    ).toThrow('Durable Reject history descriptor does not match the decision transition');
  });
});
