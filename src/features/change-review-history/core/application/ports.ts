import type {
  ReviewDraftHistoryConflictCandidate,
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
} from '../../contracts';
import type { ReviewConflictResolution } from '@shared/types/review';

export interface ReviewHistoryPersistenceScope {
  scopeKey: string;
  scopeToken: string;
}

export interface ReviewHistoryPersistenceLockPort {
  run<T>(
    teamName: string,
    scope: ReviewHistoryPersistenceScope,
    operation: () => Promise<T>
  ): Promise<T>;
}

export type ReviewDraftHistoryPersistenceScope = ReviewHistoryPersistenceScope;
export type ReviewDraftHistoryPersistenceLockPort = ReviewHistoryPersistenceLockPort;

export interface ReviewDraftHistoryAuthorization {
  isCurrentReviewedFile(filePath: string): boolean;
  assertCurrentReviewedFile(filePath: string): Promise<void>;
}

export interface ReviewDraftHistoryAuthorizationPort {
  authorize(teamName: string, scopeKey: string): Promise<ReviewDraftHistoryAuthorization>;
}

export interface ReviewDraftHistoryQueryPort {
  load(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistorySnapshot | null>;
  loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidateSummary[]>;
  loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDraftHistoryConflictCandidate>;
}

export interface ReviewDraftHistoryConflictMutationPort {
  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryEntry | null>;
  replaceConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryConflictCandidate>;
}

export interface ReviewDraftHistoryEntryMutationPort {
  saveEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    input: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'> & {
      expectedRevision: number;
      expectedGeneration: string | null;
    }
  ): Promise<ReviewDraftHistoryEntry>;
  clearEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath: string,
    expectedRevision: number,
    expectedGeneration: string | null
  ): Promise<void>;
  clearUnreadableScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void>;
}
