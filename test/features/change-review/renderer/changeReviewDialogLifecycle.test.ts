import { evaluateChangeReviewCloseReadiness } from '@features/change-review/renderer';
import { describe, expect, it } from 'vitest';

import type { ChangeReviewCloseReadinessInput } from '@features/change-review/renderer';

function readyInput(
  overrides: Partial<ChangeReviewCloseReadinessInput> = {}
): ChangeReviewCloseReadinessInput {
  return {
    hydrationKey: 'hydration-a',
    decisionHydrationScopeKey: 'hydration-a',
    decisionHydrationStatus: 'loaded',
    draftHydrationKey: 'hydration-a',
    draftHydrationStatus: 'loaded',
    editedContentCount: 0,
    hunkDecisionCount: 0,
    fileDecisionCount: 0,
    undoHistoryCount: 0,
    redoHistoryCount: 0,
    draftDiagnostics: {
      pendingWriteCount: 0,
      writeChainCount: 0,
      writeErrorCount: 0,
    },
    scopedDraftDiagnostics: {
      pendingWriteCount: 0,
      writeChainCount: 0,
      writeErrorCount: 0,
    },
    decisionDiagnostics: {
      pendingDecisionClear: false,
      persistenceStatus: 'saved',
    },
    pendingApplyCleanupKey: null,
    actionLockState: {
      applying: false,
      fileApplyCount: 0,
      undoing: false,
      closing: false,
    },
    ...overrides,
  };
}

describe('changeReviewDialogLifecycle', () => {
  it('flushes a fully hydrated idle scope', () => {
    expect(evaluateChangeReviewCloseReadiness(readyInput())).toEqual({
      disposition: 'flush',
    });
  });

  it('blocks dirty local state that has lost its durable scope', () => {
    expect(
      evaluateChangeReviewCloseReadiness(
        readyInput({
          hydrationKey: null,
          decisionHydrationScopeKey: null,
          decisionHydrationStatus: 'idle',
          draftHydrationKey: null,
          draftHydrationStatus: 'idle',
          editedContentCount: 1,
        })
      )
    ).toEqual({
      disposition: 'block',
      blocker:
        'Manual edit history lost its saved review scope. Keep Changes open and retry recovery.',
    });
  });

  it('allows an unreadable remote scope to close only when no local branch exists', () => {
    const unreadable = readyInput({
      decisionHydrationStatus: 'error',
    });

    expect(evaluateChangeReviewCloseReadiness(unreadable)).toEqual({
      disposition: 'close-without-flush',
    });
    expect(
      evaluateChangeReviewCloseReadiness({
        ...unreadable,
        hunkDecisionCount: 1,
      })
    ).toEqual({
      disposition: 'block',
      blocker:
        'Saved review state could not be reconciled with local changes. Retry recovery before closing Changes.',
    });
  });

  it('blocks pending hydration before evaluating action locks', () => {
    expect(
      evaluateChangeReviewCloseReadiness(
        readyInput({
          draftHydrationStatus: 'loading',
          actionLockState: {
            applying: true,
            fileApplyCount: 0,
            undoing: false,
            closing: false,
          },
        })
      )
    ).toEqual({
      disposition: 'block',
      blocker: 'Wait for saved review state to finish loading before closing Changes.',
    });
  });

  it('blocks a hydrated scope while another review action is active', () => {
    expect(
      evaluateChangeReviewCloseReadiness(
        readyInput({
          actionLockState: {
            applying: false,
            fileApplyCount: 1,
            undoing: false,
            closing: false,
          },
        })
      )
    ).toEqual({
      disposition: 'block',
      blocker: 'Wait for the current review action to finish.',
    });
  });
});
