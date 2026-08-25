import { useCallback, useEffect, useRef, useState } from 'react';

import {
  appendOrderedReviewAction,
  createReviewUndoAction,
  filterReviewActionHistoryForFile,
  popOrderedReviewAction,
  replaceLatestReviewAction,
} from '../utils/changeReviewActionHistory';

import type { ChangeReviewActionHistoryStorePort } from '../ports/changeReviewActionHistoryPorts';
import type { ReviewUndoActionInput } from '../utils/changeReviewActionHistory';
import type { ReviewDecisionHydrationStatus } from '../utils/changeReviewScope';
import type { ReviewRedoAction, ReviewUndoAction } from '@shared/types';

interface UseChangeReviewActionHistoryControllerInput {
  resetKey: string;
  hydrationKey: string | null;
  hydrationScopeKey: string | null;
  hydrationStatus: ReviewDecisionHydrationStatus;
  hydratedUndoHistory: ReviewUndoAction[];
  hydratedRedoHistory: ReviewRedoAction[];
  store: ChangeReviewActionHistoryStorePort;
}

export interface ChangeReviewActionHistoryController {
  undoDepth: number;
  redoDepth: number;
  getUndoHistory: () => ReviewUndoAction[];
  getRedoHistory: () => ReviewRedoAction[];
  getLatestUndoAction: () => ReviewUndoAction | undefined;
  getLatestRedoAction: () => ReviewRedoAction | undefined;
  pushUndoAction: (input: ReviewUndoActionInput) => ReviewUndoAction;
  completeUndoAction: (action: ReviewUndoAction, redoAction: ReviewRedoAction) => boolean;
  bindCommittedAction: (
    optimistic: ReviewUndoAction,
    committed: ReviewUndoAction | undefined
  ) => boolean;
  completeRedoAction: (redoAction: ReviewRedoAction) => boolean;
  discardLatestAction: (action: ReviewUndoAction) => boolean;
  publishUndoHistory: () => void;
  replaceHistories: (undoHistory: ReviewUndoAction[], redoHistory: ReviewRedoAction[]) => void;
  clear: () => void;
  clearForFile: (filePath: string) => void;
}

export function useChangeReviewActionHistoryController({
  resetKey,
  hydrationKey,
  hydrationScopeKey,
  hydrationStatus,
  hydratedUndoHistory,
  hydratedRedoHistory,
  store,
}: UseChangeReviewActionHistoryControllerInput): ChangeReviewActionHistoryController {
  const undoHistoryRef = useRef<ReviewUndoAction[]>([]);
  const redoHistoryRef = useRef<ReviewRedoAction[]>([]);
  const redoBeforePreparedActionRef = useRef<{
    action: ReviewUndoAction;
    actionId: string;
    history: ReviewRedoAction[];
  } | null>(null);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);

  useEffect(() => {
    undoHistoryRef.current = [];
    redoHistoryRef.current = [];
    redoBeforePreparedActionRef.current = null;
    setUndoDepth(0);
    setRedoDepth(0);
  }, [resetKey]);

  useEffect(() => {
    if (
      hydrationKey === null ||
      hydrationScopeKey !== hydrationKey ||
      hydrationStatus !== 'loaded'
    ) {
      return;
    }
    undoHistoryRef.current = hydratedUndoHistory;
    redoHistoryRef.current = hydratedRedoHistory;
    setUndoDepth(hydratedUndoHistory.length);
    setRedoDepth(hydratedRedoHistory.length);
  }, [hydratedRedoHistory, hydratedUndoHistory, hydrationKey, hydrationScopeKey, hydrationStatus]);

  const getUndoHistory = useCallback((): ReviewUndoAction[] => undoHistoryRef.current, []);
  const getRedoHistory = useCallback((): ReviewRedoAction[] => redoHistoryRef.current, []);
  const getLatestUndoAction = useCallback(
    (): ReviewUndoAction | undefined => undoHistoryRef.current.at(-1),
    []
  );
  const getLatestRedoAction = useCallback(
    (): ReviewRedoAction | undefined => redoHistoryRef.current.at(-1),
    []
  );

  const pushUndoAction = useCallback(
    (input: ReviewUndoActionInput): ReviewUndoAction => {
      const action = createReviewUndoAction(input);
      const undoHistory = appendOrderedReviewAction(undoHistoryRef.current, action);
      undoHistoryRef.current = undoHistory;
      store.publishUndoHistory(undoHistory);
      redoBeforePreparedActionRef.current = {
        action,
        actionId: action.id,
        history: redoHistoryRef.current,
      };
      redoHistoryRef.current = [];
      store.publishRedoHistory([]);
      setUndoDepth(undoHistory.length);
      setRedoDepth(0);
      return action;
    },
    [store]
  );

  const completeUndoAction = useCallback(
    (action: ReviewUndoAction, redoAction: ReviewRedoAction): boolean => {
      const result = popOrderedReviewAction(undoHistoryRef.current, action);
      if (!result.popped) return false;
      const redoHistory = [...redoHistoryRef.current, redoAction];
      undoHistoryRef.current = result.stack;
      redoHistoryRef.current = redoHistory;
      redoBeforePreparedActionRef.current = null;
      store.publishUndoHistory(result.stack);
      store.publishRedoHistory(redoHistory);
      setUndoDepth(result.stack.length);
      setRedoDepth(redoHistory.length);
      return true;
    },
    [store]
  );

  const bindCommittedAction = useCallback(
    (optimistic: ReviewUndoAction, committed: ReviewUndoAction | undefined): boolean => {
      if (!committed) return false;
      const result = replaceLatestReviewAction(undoHistoryRef.current, optimistic, committed);
      if (!result.replaced) return false;
      undoHistoryRef.current = result.stack;
      store.publishUndoHistory(result.stack);
      return true;
    },
    [store]
  );

  const completeRedoAction = useCallback(
    (redoAction: ReviewRedoAction): boolean => {
      const latest = redoHistoryRef.current.at(-1);
      if (latest?.action.id !== redoAction.action.id) return false;
      const redoHistory = redoHistoryRef.current.slice(0, -1);
      const undoHistory = appendOrderedReviewAction(undoHistoryRef.current, redoAction.action);
      redoHistoryRef.current = redoHistory;
      undoHistoryRef.current = undoHistory;
      redoBeforePreparedActionRef.current = null;
      store.publishRedoHistory(redoHistory);
      store.publishUndoHistory(undoHistory);
      setRedoDepth(redoHistory.length);
      setUndoDepth(undoHistory.length);
      return true;
    },
    [store]
  );

  const discardLatestAction = useCallback(
    (action: ReviewUndoAction): boolean => {
      const latest = undoHistoryRef.current.at(-1);
      if (latest?.id !== action.id) return false;
      const result = popOrderedReviewAction(undoHistoryRef.current, latest);
      if (!result.popped) return false;
      undoHistoryRef.current = result.stack;
      store.publishUndoHistory(result.stack);
      const redoBackup = redoBeforePreparedActionRef.current;
      if (redoBackup?.actionId === action.id) {
        redoHistoryRef.current = redoBackup.history;
        store.publishRedoHistory(redoBackup.history);
        setRedoDepth(redoBackup.history.length);
        redoBeforePreparedActionRef.current = null;
      }
      setUndoDepth(result.stack.length);
      return true;
    },
    [store]
  );

  const publishUndoHistory = useCallback((): void => {
    store.publishUndoHistory([...undoHistoryRef.current]);
  }, [store]);

  const replaceHistories = useCallback(
    (undoHistory: ReviewUndoAction[], redoHistory: ReviewRedoAction[]): void => {
      undoHistoryRef.current = undoHistory;
      redoHistoryRef.current = redoHistory;
      redoBeforePreparedActionRef.current = null;
      store.publishUndoHistory(undoHistory);
      store.publishRedoHistory(redoHistory);
      setUndoDepth(undoHistory.length);
      setRedoDepth(redoHistory.length);
    },
    [store]
  );

  const clear = useCallback((): void => {
    undoHistoryRef.current = [];
    redoHistoryRef.current = [];
    redoBeforePreparedActionRef.current = null;
    store.publishUndoHistory([]);
    store.publishRedoHistory([]);
    store.clearLegacyUndoStack();
    setUndoDepth(0);
    setRedoDepth(0);
  }, [store]);

  const clearForFile = useCallback(
    (filePath: string): void => {
      const filtered = filterReviewActionHistoryForFile({
        undoHistory: undoHistoryRef.current,
        redoHistory: redoHistoryRef.current,
        filePath,
      });
      if (filtered.clearAll) {
        clear();
        return;
      }
      undoHistoryRef.current = filtered.undoHistory;
      redoHistoryRef.current = filtered.redoHistory;
      redoBeforePreparedActionRef.current = null;
      store.publishUndoHistory(filtered.undoHistory);
      store.publishRedoHistory(filtered.redoHistory);
      setUndoDepth(filtered.undoHistory.length);
      setRedoDepth(0);
    },
    [clear, store]
  );

  return {
    undoDepth,
    redoDepth,
    getUndoHistory,
    getRedoHistory,
    getLatestUndoAction,
    getLatestRedoAction,
    pushUndoAction,
    completeUndoAction,
    bindCommittedAction,
    completeRedoAction,
    discardLatestAction,
    publishUndoHistory,
    replaceHistories,
    clear,
    clearForFile,
  };
}
