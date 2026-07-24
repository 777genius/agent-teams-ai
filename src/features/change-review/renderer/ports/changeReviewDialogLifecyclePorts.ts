import type {
  ChangeReviewActionLockState,
  ChangeReviewDecisionWriteDiagnostics,
  ChangeReviewDraftWriteDiagnostics,
} from '../utils/changeReviewDialogLifecycle';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { ReviewDraftHistoryEntry } from '@features/change-review-history/contracts';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  ApplyReviewResult,
  FileChangeWithContent,
  HunkDecision,
  RetryReviewMutationRecoveryRequest,
  RetryReviewMutationRecoveryResult,
  ReviewMutationDiskPostimage,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

export interface ChangeReviewDialogLifecyclePersistenceScope {
  teamName: string;
  scopeKey: string;
  scopeToken: string;
}

export type ChangeReviewDialogLifecycleAutoClearResult = 'cleared' | 'failed' | 'stale' | 'pending';

export type ChangeReviewDialogLifecycleApplyOutcome =
  | { status: 'applied'; result: ApplyReviewResult }
  | { status: 'failed'; result: ApplyReviewResult | null; errorMessage: string };

export interface ChangeReviewDialogLifecycleDecisionPersistencePort {
  scheduleAutoPersistence: (scope: ChangeReviewDialogLifecyclePersistenceScope) => void;
  clearAfterDurableStateEmptied: (
    scope: ChangeReviewDialogLifecyclePersistenceScope,
    hydrationKey: string
  ) => Promise<ChangeReviewDialogLifecycleAutoClearResult>;
  flushForClose: () => Promise<boolean>;
  getDiagnostics: () => ChangeReviewDecisionWriteDiagnostics;
}

export interface ChangeReviewDialogLifecycleDraftHistoryPort {
  getEntry: (filePath: string) => ReviewDraftHistoryEntry | undefined;
  flushWrites: () => Promise<boolean>;
  retryHydration: () => void;
  discardUnreadableScope: (operationScope: ReviewOperationScopeToken) => Promise<boolean>;
  getDiagnostics: (hydrationKey?: string | null) => ChangeReviewDraftWriteDiagnostics;
}

export interface ChangeReviewDialogLifecycleStateSnapshot {
  editedContents: Record<string, string>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  fileContents: Record<string, FileChangeWithContent>;
  fileChunkCounts: Record<string, number>;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: 'idle' | 'loading' | 'loaded' | 'error';
  applying: boolean;
}

export interface ChangeReviewDialogLifecycleStatePort {
  getSnapshot: () => ChangeReviewDialogLifecycleStateSnapshot;
  reportError: (message: string | null) => void;
  completeSavedStateDiscard: (markDecisionHydrationLoaded: boolean) => void;
}

export interface ChangeReviewDialogLifecycleCommandPort {
  resetAllReviewState: () => void;
  clearChangeReviewCache: () => void;
  fetchAgentChanges: (teamName: string, memberName: string) => void;
  fetchTaskChanges: (teamName: string, taskId: string, options: TaskChangeRequestOptions) => void;
  hydrateDecisions: (
    scope: ChangeReviewDialogLifecyclePersistenceScope,
    hydrationKey: string
  ) => Promise<void>;
  clearDecisions: (
    scope: ChangeReviewDialogLifecyclePersistenceScope,
    forceDiscard?: boolean
  ) => Promise<boolean>;
  applyReview: (
    teamName: string,
    taskId: string | undefined,
    memberName: string | undefined
  ) => Promise<ChangeReviewDialogLifecycleApplyOutcome>;
  retryMutationRecovery: (
    request: RetryReviewMutationRecoveryRequest
  ) => Promise<RetryReviewMutationRecoveryResult>;
}

export interface ChangeReviewDialogLifecycleEditorPort {
  captureDraftSnapshots: (shouldCapture: (filePath: string) => boolean) => void;
}

export interface ChangeReviewDialogLifecycleStatusPort {
  getActionLockState: (applying: boolean) => ChangeReviewActionLockState;
  beginClosing: () => void;
  finishClosing: () => void;
  setRecoveryInFlight: (value: boolean) => void;
}

export interface ChangeReviewDialogLifecycleSessionPort {
  getPendingApplyCleanupKey: () => string | null;
  setPendingApplyCleanupKey: (key: string | null) => void;
  isExpectedHydrationKey: (hydrationKey: string) => boolean;
}

export interface ChangeReviewDialogLifecycleWriteEvidencePort {
  markCommittedPostimages: (postimages: readonly ReviewMutationDiskPostimage[] | undefined) => void;
}
