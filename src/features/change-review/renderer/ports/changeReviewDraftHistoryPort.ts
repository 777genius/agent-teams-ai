import type {
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
} from '@features/change-review-history/contracts';
import type { ConflictCheckResult, ReviewConflictResolution, ReviewFileScope } from '@shared/types';

export interface ChangeReviewDraftHistoryScope {
  teamName: string;
  scopeKey: string;
  scopeToken: string;
}

export interface ChangeReviewDraftHistoryVersion {
  revision: number;
  generation: string | null;
}

export type ChangeReviewDraftHistoryEntryInput = Omit<
  ReviewDraftHistoryEntry,
  'updatedAt' | 'generation'
>;

export interface ChangeReviewDraftHistoryPort {
  load(scope: ChangeReviewDraftHistoryScope): Promise<ReviewDraftHistorySnapshot | null>;
  saveEntry(input: {
    scope: ChangeReviewDraftHistoryScope;
    entry: ChangeReviewDraftHistoryEntryInput;
    expectedVersion: ChangeReviewDraftHistoryVersion;
  }): Promise<ReviewDraftHistoryEntry>;
  clear(input: {
    scope: ChangeReviewDraftHistoryScope;
    filePath?: string;
    expectedVersion?: ChangeReviewDraftHistoryVersion;
  }): Promise<void>;
  checkConflict(input: {
    reviewScope: ReviewFileScope;
    filePath: string;
    expectedModified: string;
  }): Promise<ConflictCheckResult>;
  replaceConflictCandidate(input: {
    scope: ChangeReviewDraftHistoryScope;
    expectedEntry: ChangeReviewDraftHistoryEntryInput;
    replacementEntry: ChangeReviewDraftHistoryEntryInput;
    observedVersion: ChangeReviewDraftHistoryVersion;
  }): Promise<ReviewDraftHistoryConflictCandidateSummary>;
  resolveConflictCandidate(input: {
    scope: ChangeReviewDraftHistoryScope;
    candidateId: string;
    resolution: ReviewConflictResolution;
    observedVersion: ChangeReviewDraftHistoryVersion;
  }): Promise<ReviewDraftHistoryEntry | null>;
}
