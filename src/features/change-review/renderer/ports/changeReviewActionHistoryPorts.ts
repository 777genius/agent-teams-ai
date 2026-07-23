import type { ReviewRedoAction, ReviewUndoAction } from '@shared/types';

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
  hunkDecisions: object;
  fileDecisions: object;
  reviewActionHistory: object;
  reviewRedoHistory: object;
  fileContents: object;
  fileChunkCounts: object;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: 'idle' | 'loading' | 'loaded' | 'error';
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
