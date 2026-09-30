import type { ReviewDecisionHydrationStatus } from '../utils/changeReviewScope';

export interface ChangeReviewOperationStateSnapshot {
  applying: boolean;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: ReviewDecisionHydrationStatus;
}

export interface ChangeReviewOperationStatePort {
  getSnapshot: () => ChangeReviewOperationStateSnapshot;
  reportError: (message: string) => void;
}

export type ChangeReviewExternalChangeType = 'change' | 'add' | 'unlink';

export interface ChangeReviewExternalChangeStateSnapshot {
  activeChangeSet: { files: readonly { filePath: string }[] } | null;
  editedContents: Readonly<Record<string, string>>;
  reviewExternalChangesByFile: Readonly<Record<string, unknown>>;
}

export interface ChangeReviewExternalChangeStatePort {
  getSnapshot: () => ChangeReviewExternalChangeStateSnapshot;
  restoreDraft: (filePath: string, content: string) => void;
  markExternalChange: (filePath: string, changeType: ChangeReviewExternalChangeType) => void;
  reportError: (message: string) => void;
}

export interface ChangeReviewExternalChangePolicy {
  hasUnresolvedExternalChange: (
    filePath: string,
    changes: Readonly<Record<string, unknown>>
  ) => boolean;
}
