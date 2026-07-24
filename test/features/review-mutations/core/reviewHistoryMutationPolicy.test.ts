import {
  assertExactReviewHistoryTransition,
  buildUndoDiskMutationSteps,
} from '@features/review-mutations/main';
import { describe, expect, it } from 'vitest';

import type {
  ExecuteReviewMutationRequest,
  FileChangeSummary,
  ReviewUndoAction,
} from '@shared/types/review';

const FILE_PATH = '/sandbox/fixture.ts';
const hashContent = (content: string): string => `hash:${content}`;

const file: FileChangeSummary = {
  filePath: FILE_PATH,
  relativePath: 'fixture.ts',
  snippets: [],
  linesAdded: 1,
  linesRemoved: 1,
  isNewFile: false,
  changeKey: 'fixture-change',
};

const action: Extract<ReviewUndoAction, { kind: 'disk' }> = {
  id: 'action-1',
  createdAt: '2026-07-24T00:00:00.000Z',
  kind: 'disk',
  action: {
    snapshot: {
      filePath: FILE_PATH,
      beforeContent: 'before\n',
      afterContent: 'after\n',
      authoritativeBeforeSha256: hashContent('before\n'),
    },
    originalIndex: 0,
  },
};

const current = {
  hunkDecisions: { 'fixture-change:0': 'rejected' as const },
  fileDecisions: {},
  hunkContextHashesByFile: {},
  reviewActionHistory: [action],
  reviewRedoHistory: [],
  revision: 4,
};

function createUndoRequest(): ExecuteReviewMutationRequest {
  return {
    scope: { teamName: 'safe-team', memberName: 'worker' },
    decisionPersistenceScope: { scopeKey: 'agent-worker', scopeToken: 'scope-token' },
    kind: 'undo',
    expectedTopActionId: action.id,
    diskSteps: buildUndoDiskMutationSteps(action.id, [action.action.snapshot]),
    persistedState: {
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [],
      reviewRedoHistory: [
        {
          action,
          decisionSnapshot: {
            hunkDecisions: current.hunkDecisions,
            fileDecisions: current.fileDecisions,
          },
          hunkContextHashesByFile: {},
        },
      ],
    },
    expectedDecisionRevision: 4,
  };
}

const context = {
  resolveFile: () => file,
  normalizePath: (filePath: string) => filePath,
  hashContent,
};

describe('review history mutation policy', () => {
  it('accepts only the exact durable Undo state and disk transition', () => {
    expect(() =>
      assertExactReviewHistoryTransition(createUndoRequest(), current, context)
    ).not.toThrow();
  });

  it('rejects forged disk bytes even when the history stacks match', () => {
    const request = createUndoRequest();
    request.diskSteps = [
      {
        id: `${action.id}:0`,
        type: 'write',
        filePath: FILE_PATH,
        expectedContent: 'after\n',
        content: 'forged\n',
      },
    ];

    expect(() => assertExactReviewHistoryTransition(request, current, context)).toThrow(
      'Review Undo disk mutation does not match durable history'
    );
  });

  it('rejects a stale expected action id before mutating history', () => {
    const request = createUndoRequest();
    request.expectedTopActionId = 'stale-action';

    expect(() => assertExactReviewHistoryTransition(request, current, context)).toThrow(
      'Review history changed; refusing stale Undo'
    );
  });

  it('rejects legacy disk history without an authoritative preimage binding', () => {
    const legacyAction: ReviewUndoAction = {
      ...action,
      action: {
        ...action.action,
        snapshot: {
          ...action.action.snapshot,
          authoritativeBeforeSha256: undefined,
        },
      },
    };
    const request = createUndoRequest();
    request.expectedTopActionId = legacyAction.id;

    expect(() =>
      assertExactReviewHistoryTransition(
        request,
        { ...current, reviewActionHistory: [legacyAction] },
        context
      )
    ).toThrow('Review history predates authoritative disk snapshots; reload Changes');
  });
});
