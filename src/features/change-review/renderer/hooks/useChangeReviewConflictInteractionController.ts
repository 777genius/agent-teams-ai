import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { selectLatestReviewConflictCandidate } from '../utils/changeReviewConflicts';

import type { ChangeReviewConflictCommandPort } from '../ports/changeReviewConflictPorts';
import type { ChangeReviewConflictScope } from '../ports/changeReviewConflictPorts';
import type { ReviewConflictCandidateSelection } from '../utils/changeReviewConflicts';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { ReviewDraftHistoryConflictCandidateSummary } from '@features/change-review-history/contracts';
import type {
  ReviewConflictResolution,
  ReviewDecisionConflictCandidateSummary,
} from '@shared/types';

interface UseChangeReviewConflictInteractionControllerInput {
  active: boolean;
  hydrationKey: string | null;
  scope: ChangeReviewConflictScope | null;
  decisionCandidates: readonly ReviewDecisionConflictCandidateSummary[];
  draftHistoryCandidates: readonly ReviewDraftHistoryConflictCandidateSummary[];
  captureOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentOperationScope: (
    operationScope: ReviewOperationScopeToken | null
  ) => operationScope is ReviewOperationScopeToken;
  isExpectedHydrationKey: (hydrationKey: string) => boolean;
  hydrateDecisions: (scope: ChangeReviewConflictScope, hydrationKey: string) => Promise<void>;
  isDecisionHydrationLoaded: (hydrationKey: string) => boolean;
  publishDecisionPersistenceSaved: () => void;
  resolveDraftHistoryCandidate: (
    candidate: ReviewDraftHistoryConflictCandidateSummary,
    resolution: ReviewConflictResolution,
    operationScope: ReviewOperationScopeToken
  ) => Promise<boolean>;
  clearResolutionError: () => void;
  reportResolutionError: (message: string) => void;
  refreshCandidates: () => Promise<void>;
  port: ChangeReviewConflictCommandPort;
}

export interface ChangeReviewConflictInteractionController {
  activeCandidate: ReviewConflictCandidateSelection | null;
  activeCandidateRecoverable: boolean;
  resolvingCandidateId: string | null;
  pendingDiscard: ReviewConflictCandidateSelection | null;
  requestDiscard: (candidate: ReviewConflictCandidateSelection) => void;
  onDiscardOpenChange: (open: boolean) => void;
  confirmPendingDiscard: () => Promise<void>;
  resolveActiveCandidate: (
    resolution: ReviewConflictResolution,
    expectedCandidateId?: string
  ) => Promise<void>;
}

export function useChangeReviewConflictInteractionController({
  active,
  hydrationKey,
  scope,
  decisionCandidates,
  draftHistoryCandidates,
  captureOperationScope,
  isCurrentOperationScope,
  isExpectedHydrationKey,
  hydrateDecisions,
  isDecisionHydrationLoaded,
  publishDecisionPersistenceSaved,
  resolveDraftHistoryCandidate,
  clearResolutionError,
  reportResolutionError,
  refreshCandidates,
  port,
}: UseChangeReviewConflictInteractionControllerInput): ChangeReviewConflictInteractionController {
  const [resolvingCandidateId, setResolvingCandidateId] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<ReviewConflictCandidateSelection | null>(
    null
  );
  const resolutionOperationRef = useRef<object | null>(null);
  const activeCandidate = useMemo(
    () => selectLatestReviewConflictCandidate(decisionCandidates, draftHistoryCandidates),
    [decisionCandidates, draftHistoryCandidates]
  );
  const activeCandidateRecoverable = activeCandidate?.value.recoverability === 'recoverable';

  useLayoutEffect(() => {
    resolutionOperationRef.current = null;
    setResolvingCandidateId(null);
    setPendingDiscard(null);
    return () => {
      resolutionOperationRef.current = null;
    };
  }, [active, hydrationKey]);

  const resolveActiveCandidate = useCallback(
    async (resolution: ReviewConflictResolution, expectedCandidateId?: string): Promise<void> => {
      if (
        !activeCandidate ||
        (resolution === 'recover-candidate' && !activeCandidateRecoverable) ||
        (expectedCandidateId !== undefined && activeCandidate.value.id !== expectedCandidateId) ||
        !hydrationKey ||
        !scope ||
        resolutionOperationRef.current !== null
      ) {
        return;
      }
      const selected = activeCandidate;
      const resolutionHydrationKey = hydrationKey;
      const operationScope = captureOperationScope();
      if (!operationScope) return;
      const resolutionOperation = {};
      resolutionOperationRef.current = resolutionOperation;
      setResolvingCandidateId(selected.value.id);
      const isCurrentResolution = (): boolean =>
        isCurrentOperationScope(operationScope) &&
        isExpectedHydrationKey(resolutionHydrationKey) &&
        resolutionOperationRef.current === resolutionOperation;

      try {
        if (selected.kind === 'decision') {
          await port.resolveDecisionCandidate({
            scope,
            candidateId: selected.value.id,
            resolution,
            observedCurrentRevision: selected.value.observedCurrentRevision,
          });
          if (!isCurrentResolution()) return;
          await hydrateDecisions(scope, resolutionHydrationKey);
          if (!isCurrentResolution()) return;
          if (!isDecisionHydrationLoaded(resolutionHydrationKey)) {
            throw new Error('Resolved decisions could not be reloaded');
          }
          publishDecisionPersistenceSaved();
        } else {
          const resolved = await resolveDraftHistoryCandidate(
            selected.value,
            resolution,
            operationScope
          );
          if (!resolved) return;
        }
        if (!isCurrentResolution()) return;
        clearResolutionError();
        await refreshCandidates();
      } catch (error) {
        if (!isCurrentResolution()) return;
        reportResolutionError(`Unable to resolve the durable recovery copy: ${String(error)}`);
        await refreshCandidates();
      } finally {
        if (isCurrentResolution()) {
          resolutionOperationRef.current = null;
          setResolvingCandidateId(null);
        }
      }
    },
    [
      activeCandidate,
      activeCandidateRecoverable,
      captureOperationScope,
      clearResolutionError,
      hydrateDecisions,
      hydrationKey,
      isCurrentOperationScope,
      isDecisionHydrationLoaded,
      isExpectedHydrationKey,
      port,
      publishDecisionPersistenceSaved,
      refreshCandidates,
      reportResolutionError,
      resolveDraftHistoryCandidate,
      scope,
    ]
  );

  const requestDiscard = useCallback((candidate: ReviewConflictCandidateSelection): void => {
    setPendingDiscard(candidate);
  }, []);

  const onDiscardOpenChange = useCallback(
    (open: boolean): void => {
      if (!open && resolvingCandidateId === null) setPendingDiscard(null);
    },
    [resolvingCandidateId]
  );

  const confirmPendingDiscard = useCallback(async (): Promise<void> => {
    if (!pendingDiscard) return;
    const operationScope = captureOperationScope();
    if (!operationScope) return;
    const candidateId = pendingDiscard.value.id;
    try {
      await resolveActiveCandidate('keep-current', candidateId);
    } finally {
      if (isCurrentOperationScope(operationScope)) {
        setPendingDiscard((current) => (current?.value.id === candidateId ? null : current));
      }
    }
  }, [captureOperationScope, isCurrentOperationScope, pendingDiscard, resolveActiveCandidate]);

  return {
    activeCandidate,
    activeCandidateRecoverable,
    resolvingCandidateId,
    pendingDiscard,
    requestDiscard,
    onDiscardOpenChange,
    confirmPendingDiscard,
    resolveActiveCandidate,
  };
}
