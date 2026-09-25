import { useCallback } from 'react';

import { isReviewActionPersistenceBlocking } from '../utils/changeReviewActionHistory';
import { isReviewActionLocked } from '../utils/changeReviewDialogLifecycle';

import type { ChangeReviewOperationStatePort } from '../ports/changeReviewMutationSafetyPorts';
import type { ReviewActionPersistenceStatus } from '../utils/changeReviewActionHistory';
import type { ReviewDraftHistoryHydrationState } from '../utils/changeReviewScope';
import type { ChangeReviewOperationState } from './useChangeReviewOperationState';

interface ChangeReviewConflictGuardState {
  refreshPending: boolean;
  loadError: string | null;
  candidateCount: number;
  resolvingCandidateId: string | null;
}

interface UseChangeReviewMutationGuardsInput {
  applying: boolean;
  operation: ChangeReviewOperationState;
  decisionScopeToken: string | null;
  decisionHydrationKey: string | null;
  decisionHydrationReady: boolean;
  draftHistoryHydration: ReviewDraftHistoryHydrationState;
  draftHistoryHydrationReady: boolean;
  conflict: ChangeReviewConflictGuardState;
  persistenceStatus: ReviewActionPersistenceStatus;
  getPersistenceStatus: () => ReviewActionPersistenceStatus;
  port: ChangeReviewOperationStatePort;
}

export interface ChangeReviewMutationGuards {
  reviewMutationBusy: boolean;
  reviewActionsBusy: boolean;
  reviewCloseBusy: boolean;
  hasReviewActionInFlight: () => boolean;
  ensureDurableReviewScope: () => boolean;
}

const DURABLE_SCOPE_ERROR =
  'Durable review scope is unavailable; refusing an unsafe disk mutation.';

export function useChangeReviewMutationGuards({
  applying,
  operation,
  decisionScopeToken,
  decisionHydrationKey,
  decisionHydrationReady,
  draftHistoryHydration,
  draftHistoryHydrationReady,
  conflict,
  persistenceStatus,
  getPersistenceStatus,
  port,
}: UseChangeReviewMutationGuardsInput): ChangeReviewMutationGuards {
  const reviewMutationBusy = isReviewActionLocked({
    applying,
    fileApplyCount: operation.filesApplying.size,
    undoing: operation.undoing,
    closing: operation.closing,
  });
  const reviewActionsBusy =
    reviewMutationBusy ||
    conflict.refreshPending ||
    conflict.loadError !== null ||
    conflict.candidateCount > 0 ||
    conflict.resolvingCandidateId !== null ||
    isReviewActionPersistenceBlocking(persistenceStatus) ||
    (decisionHydrationKey !== null && (!decisionHydrationReady || !draftHistoryHydrationReady));
  // Discovery and persistence drains may finish during close flushing. Only
  // active mutation or conflict resolution keeps the close control locked.
  const reviewCloseBusy = reviewMutationBusy || conflict.resolvingCandidateId !== null;

  const hasReviewActionInFlight = useCallback((): boolean => {
    const state = port.getSnapshot();
    const hydrationReady =
      decisionHydrationKey === null ||
      (state.decisionHydrationScopeKey === decisionHydrationKey &&
        state.decisionHydrationStatus === 'loaded' &&
        draftHistoryHydration.key === decisionHydrationKey &&
        draftHistoryHydration.status === 'loaded');
    return (
      !hydrationReady ||
      conflict.refreshPending ||
      conflict.loadError !== null ||
      conflict.candidateCount > 0 ||
      conflict.resolvingCandidateId !== null ||
      isReviewActionPersistenceBlocking(getPersistenceStatus()) ||
      isReviewActionLocked({
        applying: state.applying,
        fileApplyCount: operation.viewPortBindings.fileApplyInFlightRef.current.size,
        undoing: operation.viewPortBindings.undoInFlightRef.current,
        closing: operation.viewPortBindings.closingRef.current,
      })
    );
  }, [
    conflict.candidateCount,
    conflict.loadError,
    conflict.refreshPending,
    conflict.resolvingCandidateId,
    decisionHydrationKey,
    draftHistoryHydration.key,
    draftHistoryHydration.status,
    getPersistenceStatus,
    operation.viewPortBindings.closingRef,
    operation.viewPortBindings.fileApplyInFlightRef,
    operation.viewPortBindings.undoInFlightRef,
    port,
  ]);

  const ensureDurableReviewScope = useCallback((): boolean => {
    if (decisionScopeToken) return true;
    port.reportError(DURABLE_SCOPE_ERROR);
    return false;
  }, [decisionScopeToken, port]);

  return {
    reviewMutationBusy,
    reviewActionsBusy,
    reviewCloseBusy,
    hasReviewActionInFlight,
    ensureDurableReviewScope,
  };
}
