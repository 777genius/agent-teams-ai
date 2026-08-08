import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX } from '../utils/changeReviewConflicts';

import type { ChangeReviewConflictQueryPort } from '../ports/changeReviewConflictPorts';
import type { ChangeReviewConflictScope } from '../ports/changeReviewConflictPorts';
import type { ReviewDraftHistoryConflictCandidateSummary } from '@features/change-review-history/contracts';
import type { ReviewDecisionConflictCandidateSummary } from '@shared/types';

interface UseChangeReviewConflictDiscoveryControllerInput {
  active: boolean;
  hydrationKey: string | null;
  scope: ChangeReviewConflictScope | null;
  isExpectedHydrationKey: (hydrationKey: string) => boolean;
  hydrateDecisions: (scope: ChangeReviewConflictScope, hydrationKey: string) => Promise<void>;
  clearReportedLoadError: () => void;
  reportLoadError: (message: string) => void;
  port: ChangeReviewConflictQueryPort;
}

export interface ChangeReviewConflictDiscoveryController {
  decisionCandidates: ReviewDecisionConflictCandidateSummary[];
  draftHistoryCandidates: ReviewDraftHistoryConflictCandidateSummary[];
  candidateCount: number;
  refreshPending: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  reset: () => void;
}

export function useChangeReviewConflictDiscoveryController({
  active,
  hydrationKey,
  scope,
  isExpectedHydrationKey,
  hydrateDecisions,
  clearReportedLoadError,
  reportLoadError,
  port,
}: UseChangeReviewConflictDiscoveryControllerInput): ChangeReviewConflictDiscoveryController {
  const [decisionCandidates, setDecisionCandidates] = useState<
    ReviewDecisionConflictCandidateSummary[]
  >([]);
  const [draftHistoryCandidates, setDraftHistoryCandidates] = useState<
    ReviewDraftHistoryConflictCandidateSummary[]
  >([]);
  const [refreshPending, setRefreshPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refreshGenerationRef = useRef(0);

  useLayoutEffect(() => {
    refreshGenerationRef.current += 1;
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [active, hydrationKey]);

  const reset = useCallback((): void => {
    refreshGenerationRef.current += 1;
    setDecisionCandidates([]);
    setDraftHistoryCandidates([]);
    setRefreshPending(false);
    setLoadError(null);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const refreshGeneration = ++refreshGenerationRef.current;
    if (!active || !hydrationKey || !scope) {
      setDecisionCandidates([]);
      setDraftHistoryCandidates([]);
      setRefreshPending(false);
      setLoadError(null);
      return;
    }
    const requestHydrationKey = hydrationKey;
    const isCurrentRequest = (): boolean =>
      isExpectedHydrationKey(requestHydrationKey) &&
      refreshGenerationRef.current === refreshGeneration;

    setRefreshPending(true);
    try {
      const [nextDecisionCandidates, nextDraftHistoryCandidates] = await Promise.all([
        port.loadDecisionCandidates(scope),
        port.loadDraftHistoryCandidates(scope),
      ]);
      if (!isCurrentRequest()) return;
      if (nextDecisionCandidates.length > 0) {
        await hydrateDecisions(scope, requestHydrationKey);
        if (!isCurrentRequest()) return;
      }
      setDecisionCandidates(nextDecisionCandidates);
      setDraftHistoryCandidates(nextDraftHistoryCandidates);
      setLoadError(null);
      clearReportedLoadError();
    } catch (error) {
      if (!isCurrentRequest()) return;
      const message = `${CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX} ${String(error)}`;
      setLoadError(message);
      reportLoadError(message);
    } finally {
      if (isCurrentRequest()) setRefreshPending(false);
    }
  }, [
    active,
    clearReportedLoadError,
    hydrateDecisions,
    hydrationKey,
    isExpectedHydrationKey,
    port,
    reportLoadError,
    scope,
  ]);

  return {
    decisionCandidates,
    draftHistoryCandidates,
    candidateCount: decisionCandidates.length + draftHistoryCandidates.length,
    refreshPending,
    loadError,
    refresh,
    reset,
  };
}
