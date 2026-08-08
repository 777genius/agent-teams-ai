import { useEffect, useRef } from 'react';

import type { ChangeReviewDecisionPersistenceScope } from '../ports/changeReviewActionHistoryPorts';
import type { ChangeReviewAutoClearResult } from './useChangeReviewDecisionPersistenceController';

interface UseChangeReviewDecisionAutoPersistenceInput {
  active: boolean;
  hydrationKey: string | null;
  scope: ChangeReviewDecisionPersistenceScope | null;
  hydrationReady: boolean;
  blocked: boolean;
  hasDurableReviewState: boolean;
  hunkDecisions: object;
  fileDecisions: object;
  undoHistory: object;
  redoHistory: object;
  fileContents: object;
  fileChunkCounts: object;
  scheduleAutoPersistence: (scope: ChangeReviewDecisionPersistenceScope) => void;
  clearAfterDurableStateEmptied: (
    scope: ChangeReviewDecisionPersistenceScope,
    hydrationKey: string
  ) => Promise<ChangeReviewAutoClearResult>;
}

export function useChangeReviewDecisionAutoPersistence({
  active,
  hydrationKey,
  scope,
  hydrationReady,
  blocked,
  hasDurableReviewState,
  hunkDecisions,
  fileDecisions,
  undoHistory,
  redoHistory,
  fileContents,
  fileChunkCounts,
  scheduleAutoPersistence,
  clearAfterDurableStateEmptied,
}: UseChangeReviewDecisionAutoPersistenceInput): void {
  const hadDurableReviewStateRef = useRef(false);
  const hasDurableReviewStateRef = useRef(hasDurableReviewState);
  hasDurableReviewStateRef.current = hasDurableReviewState;

  useEffect(() => {
    hadDurableReviewStateRef.current = false;
  }, [scope?.scopeToken]);

  useEffect(() => {
    if (!active || !scope || !hydrationKey || !hydrationReady || blocked) return;
    if (hasDurableReviewState) {
      hadDurableReviewStateRef.current = true;
      scheduleAutoPersistence(scope);
      return;
    }
    if (!hadDurableReviewStateRef.current) return;
    void clearAfterDurableStateEmptied(scope, hydrationKey).then((result) => {
      if (result === 'cleared' && !hasDurableReviewStateRef.current) {
        hadDurableReviewStateRef.current = false;
      }
    });
  }, [
    active,
    blocked,
    clearAfterDurableStateEmptied,
    fileChunkCounts,
    fileContents,
    fileDecisions,
    hasDurableReviewState,
    hunkDecisions,
    hydrationKey,
    hydrationReady,
    redoHistory,
    scheduleAutoPersistence,
    scope,
    undoHistory,
  ]);
}
