import type {
  ExecuteReviewMutationRequest,
  ExecuteReviewMutationResult,
  FileChangeSummary,
  HunkDecision,
  RestoreReviewHistoryRequest,
  RestoreReviewHistoryResult,
  RetryReviewMutationRecoveryRequest,
  RetryReviewMutationRecoveryResult,
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
  ReviewMutationDiskPostimage,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
} from '@shared/types';

export interface ChangeReviewHistoryStateSnapshot {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile: Record<string, Record<number, string>>;
  decisionRevision: number;
}

export interface ChangeReviewHistoryMutationCommandPort {
  executeMutation(request: ExecuteReviewMutationRequest): Promise<ExecuteReviewMutationResult>;
  restoreHistory(request: RestoreReviewHistoryRequest): Promise<RestoreReviewHistoryResult>;
  retryRecovery(
    request: RetryReviewMutationRecoveryRequest
  ): Promise<RetryReviewMutationRecoveryResult>;
}

export interface ChangeReviewHistoryMutationStatePort {
  getSnapshot(): ChangeReviewHistoryStateSnapshot;
  quiesceDecisionPersistence(scope: ChangeReviewHistoryPersistenceScope): Promise<boolean>;
  recordDecisionRevision(scope: ChangeReviewHistoryPersistenceScope, revision: number): void;
  applyDecisionState(state: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  }): void;
  applyPersistedState(state: ReviewPersistedStateSnapshot, applyError: string | null): void;
  reportError(message: string): void;
  clearExternalChange(filePath: string): void;
  invalidateResolvedFileContent(filePath: string): void;
}

export interface ChangeReviewHistoryPersistenceScope extends ReviewDecisionPersistenceScope {
  teamName: string;
}

export interface ChangeReviewHistoryMutationViewPort {
  addMissingFile(file: FileChangeSummary, index: number | undefined, content: string): void;
  fetchFileContent(teamName: string, memberName: string | undefined, filePath: string): void;
  incrementDiscardCounters(filePaths: readonly string[]): void;
  navigateToAction(action: ReviewUndoAction): void;
  markExpectedWrite(filePath: string, expectedContent: string | null): void;
  clearExpectedWrite(filePath: string): void;
  markCommittedPostimages(postimages: readonly ReviewMutationDiskPostimage[] | undefined): void;
  setMutationInFlight(value: boolean): void;
}

export interface ChangeReviewHistoryMutationScope {
  review: ReviewFileScope;
  persistence: ChangeReviewHistoryPersistenceScope;
}
