import type { ReviewDecisionHydrationStatus } from '../utils/changeReviewScope';
import type {
  FileChangeWithContent,
  HunkDecision,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

export interface ChangeReviewActionHistoryStorePort {
  publishUndoHistory(history: ReviewUndoAction[]): void;
  publishRedoHistory(history: ReviewRedoAction[]): void;
  clearLegacyUndoStack(): void;
}

export interface ChangeReviewDecisionPersistenceScope {
  teamName: string;
  scopeKey: string;
  scopeToken: string;
}

export interface ChangeReviewDecisionPersistenceSnapshot {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  fileContents: Record<string, FileChangeWithContent>;
  fileChunkCounts: Record<string, number>;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: ReviewDecisionHydrationStatus;
  applyError: string | null;
}

export interface ChangeReviewDecisionPersistencePort {
  getSnapshot(): ChangeReviewDecisionPersistenceSnapshot;
  load(scope: ChangeReviewDecisionPersistenceScope): Promise<void>;
  schedule(scope: ChangeReviewDecisionPersistenceScope): void;
  flush(scope: ChangeReviewDecisionPersistenceScope): Promise<boolean>;
  clear(scope: ChangeReviewDecisionPersistenceScope): Promise<boolean>;
  reportError(message: string): void;
  clearError(expectedMessage: string): void;
}
