import { CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX } from '../utils/changeReviewConflicts';

interface ChangeReviewConflictStateSnapshot {
  applyError: string | null;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: string;
}

interface CreateChangeReviewConflictStateBridgeInput {
  getSnapshot: () => ChangeReviewConflictStateSnapshot;
  setApplyError: (message: string | null) => void;
}

export interface ChangeReviewConflictStateBridge {
  clearReportedLoadError: () => void;
  reportError: (message: string) => void;
  clearResolutionError: () => void;
  isDecisionHydrationLoaded: (hydrationKey: string) => boolean;
}

export function createChangeReviewConflictStateBridge({
  getSnapshot,
  setApplyError,
}: CreateChangeReviewConflictStateBridgeInput): ChangeReviewConflictStateBridge {
  return {
    clearReportedLoadError: () => {
      if (getSnapshot().applyError?.startsWith(CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX)) {
        setApplyError(null);
      }
    },
    reportError: (message) => setApplyError(message),
    clearResolutionError: () => setApplyError(null),
    isDecisionHydrationLoaded: (hydrationKey) => {
      const snapshot = getSnapshot();
      return (
        snapshot.decisionHydrationScopeKey === hydrationKey &&
        snapshot.decisionHydrationStatus === 'loaded'
      );
    },
  };
}
