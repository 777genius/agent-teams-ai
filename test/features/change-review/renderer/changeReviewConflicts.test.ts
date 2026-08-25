import { selectLatestReviewConflictCandidate } from '@features/change-review/renderer';
import { describe, expect, it } from 'vitest';

import type { ReviewDraftHistoryConflictCandidateSummary } from '@features/change-review-history/contracts';
import type { ReviewDecisionConflictCandidateSummary } from '@shared/types';

function decision(capturedAt: string): ReviewDecisionConflictCandidateSummary {
  return {
    id: 'decision',
    capturedAt,
    origin: 'current-snapshot',
    recoverability: 'recoverable',
    expectedRevision: 1,
    observedCurrentRevision: 2,
    hunkDecisionCount: 0,
    fileDecisionCount: 0,
    undoDepth: 1,
    redoDepth: 0,
  };
}

function draft(capturedAt: string): ReviewDraftHistoryConflictCandidateSummary {
  return {
    id: 'draft',
    capturedAt,
    origin: 'current-snapshot',
    recoverability: 'recoverable',
    filePath: '/repo/file.ts',
    expectedRevision: 1,
    expectedGeneration: 'first',
    observedCurrentRevision: 2,
    observedCurrentGeneration: 'second',
    entryRevision: 1,
  };
}

describe('change review conflict selection', () => {
  it('returns no selection when both conflict queues are empty', () => {
    expect(selectLatestReviewConflictCandidate([], [])).toBeNull();
  });

  it('uses the decision candidate as the stable tie breaker', () => {
    const capturedAt = '2026-07-23T12:00:00.000Z';

    expect(selectLatestReviewConflictCandidate([decision(capturedAt)], [draft(capturedAt)])).toEqual({
      kind: 'decision',
      value: decision(capturedAt),
    });
  });
});
