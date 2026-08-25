import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { normalizePathForComparison } from '@shared/utils/platformPath';

import { useChangeReviewOperationGeneration } from './useChangeReviewOperationGeneration';

import type { ChangeReviewRecentWrite } from '../ports/changeReviewDialogInteractionPorts';
import type { ChangeReviewOperationStatePort } from '../ports/changeReviewMutationSafetyPorts';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

export interface ChangeReviewOperationViewPortBindings {
  fileApplyInFlightRef: MutableRefObject<Set<string>>;
  undoInFlightRef: MutableRefObject<boolean>;
  closingRef: MutableRefObject<boolean>;
  pendingApplyCleanupKeyRef: MutableRefObject<string | null>;
  recentReviewWritesRef: MutableRefObject<Map<string, ChangeReviewRecentWrite>>;
  setFilesApplying: Dispatch<SetStateAction<Set<string>>>;
  setUndoing: Dispatch<SetStateAction<boolean>>;
  setClosing: Dispatch<SetStateAction<boolean>>;
}

interface UseChangeReviewOperationStateInput {
  active: boolean;
  decisionHydrationKey: string | null;
  fallbackScopeKey: string;
  changeSetEpoch: number;
  resetKey: string;
  port: ChangeReviewOperationStatePort;
}

export interface ChangeReviewOperationState {
  filesApplying: Set<string>;
  undoing: boolean;
  closing: boolean;
  viewPortBindings: ChangeReviewOperationViewPortBindings;
  captureReviewOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentReviewOperationScope: (
    operationScope: ReviewOperationScopeToken | null
  ) => operationScope is ReviewOperationScopeToken;
  isFileMutationInFlight: (filePath: string) => boolean;
  isPathMutationInFlight: (normalizedPath: string) => boolean;
}

export function useChangeReviewOperationState({
  active,
  decisionHydrationKey,
  fallbackScopeKey,
  changeSetEpoch,
  resetKey,
  port,
}: UseChangeReviewOperationStateInput): ChangeReviewOperationState {
  const [filesApplying, setFilesApplying] = useState<Set<string>>(() => new Set());
  const [undoing, setUndoing] = useState(false);
  const [closing, setClosing] = useState(false);
  const fileApplyInFlightRef = useRef(new Set<string>());
  const undoInFlightRef = useRef(false);
  const closingRef = useRef(false);
  const pendingApplyCleanupKeyRef = useRef<string | null>(null);
  const recentReviewWritesRef = useRef(new Map<string, ChangeReviewRecentWrite>());

  const resetGenerationState = useCallback((): void => {
    // Busy state belongs to one operation generation. Keep recent-write evidence
    // so late filesystem events from committed mutations remain suppressible.
    fileApplyInFlightRef.current.clear();
    undoInFlightRef.current = false;
    closingRef.current = false;
    setFilesApplying(new Set());
    setUndoing(false);
    setClosing(false);
  }, []);

  const { captureReviewOperationScope, isCurrentReviewOperationScope } =
    useChangeReviewOperationGeneration({
      active,
      decisionHydrationKey,
      fallbackScopeKey,
      changeSetEpoch,
      resetGenerationState,
    });

  useEffect(() => {
    if (pendingApplyCleanupKeyRef.current !== decisionHydrationKey) {
      pendingApplyCleanupKeyRef.current = null;
    }
  }, [decisionHydrationKey]);

  useEffect(() => {
    fileApplyInFlightRef.current.clear();
    recentReviewWritesRef.current.clear();
    undoInFlightRef.current = false;
    closingRef.current = false;
    setUndoing(false);
    setClosing(false);
    setFilesApplying(new Set());
  }, [resetKey]);

  const isFileMutationInFlight = useCallback(
    (filePath: string): boolean => fileApplyInFlightRef.current.has(filePath),
    []
  );
  const isPathMutationInFlight = useCallback(
    (normalizedPath: string): boolean => {
      const pathBusy = [...fileApplyInFlightRef.current].some(
        (filePath) => normalizePathForComparison(filePath) === normalizedPath
      );
      return pathBusy || undoInFlightRef.current || port.getSnapshot().applying;
    },
    [port]
  );
  const viewPortBindings = useMemo<ChangeReviewOperationViewPortBindings>(
    () => ({
      fileApplyInFlightRef,
      undoInFlightRef,
      closingRef,
      pendingApplyCleanupKeyRef,
      recentReviewWritesRef,
      setFilesApplying,
      setUndoing,
      setClosing,
    }),
    []
  );

  return {
    filesApplying,
    undoing,
    closing,
    viewPortBindings,
    captureReviewOperationScope,
    isCurrentReviewOperationScope,
    isFileMutationInFlight,
    isPathMutationInFlight,
  };
}
