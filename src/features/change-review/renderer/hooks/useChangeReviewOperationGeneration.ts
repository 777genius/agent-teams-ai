import { useCallback, useLayoutEffect, useRef } from 'react';

import {
  createReviewOperationScopeToken,
  isReviewOperationScopeCurrent,
  type ReviewOperationScopeToken,
} from '../utils/reviewOperationGeneration';

interface UseChangeReviewOperationGenerationInput {
  active: boolean;
  decisionHydrationKey: string | null;
  fallbackScopeKey: string;
  changeSetEpoch: number;
  resetGenerationState: () => void;
}

interface ChangeReviewOperationGeneration {
  captureReviewOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentReviewOperationScope: (
    operationScope: ReviewOperationScopeToken | null
  ) => operationScope is ReviewOperationScopeToken;
}

export function useChangeReviewOperationGeneration({
  active,
  decisionHydrationKey,
  fallbackScopeKey,
  changeSetEpoch,
  resetGenerationState,
}: UseChangeReviewOperationGenerationInput): ChangeReviewOperationGeneration {
  const operationScopeRef = useRef<ReviewOperationScopeToken | null>(null);

  useLayoutEffect(() => {
    const activeScopeKey = active ? (decisionHydrationKey ?? fallbackScopeKey) : null;
    const operationScope = activeScopeKey ? createReviewOperationScopeToken(activeScopeKey) : null;
    operationScopeRef.current = operationScope;
    resetGenerationState();
    return () => {
      if (operationScopeRef.current === operationScope) {
        operationScopeRef.current = null;
      }
    };
  }, [active, changeSetEpoch, decisionHydrationKey, fallbackScopeKey, resetGenerationState]);

  const captureReviewOperationScope = useCallback((): ReviewOperationScopeToken | null => {
    return operationScopeRef.current;
  }, []);

  const isCurrentReviewOperationScope = useCallback(
    (
      operationScope: ReviewOperationScopeToken | null
    ): operationScope is ReviewOperationScopeToken =>
      isReviewOperationScopeCurrent(operationScopeRef.current, operationScope),
    []
  );

  return { captureReviewOperationScope, isCurrentReviewOperationScope };
}
