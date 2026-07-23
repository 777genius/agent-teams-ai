import type {
  FileChangeSummary,
  HunkDecision,
  ReviewConflictResolution,
  ReviewDecisionConflictCandidate,
  ReviewDecisionConflictCandidateSummary,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types/review';

import type { ReviewHistoryPersistenceLockPort, ReviewHistoryPersistenceScope } from './ports';

export interface LoadedReviewDecisionState extends ReviewPersistedStateSnapshot {
  revision: number;
}

export interface ReviewDecisionAuthorization {
  files: readonly FileChangeSummary[] | null;
  normalizePath(filePath: string): string;
  resolveFile(filePath: string): FileChangeSummary;
}

export interface ReviewDecisionAuthorizationPort {
  authorize(teamName: string, scopeKey: string): Promise<ReviewDecisionAuthorization>;
}

export interface ReviewDecisionQueryPort {
  load(
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ): Promise<LoadedReviewDecisionState | null>;
  loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidateSummary[]>;
  loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDecisionConflictCandidate>;
}

export interface SaveReviewDecisionStateInput {
  scopeToken: string;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory?: ReviewUndoAction[];
  reviewRedoHistory?: ReviewRedoAction[];
  expectedRevision?: number;
}

export interface ReviewDecisionMutationPort {
  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number
  ): Promise<number>;
  save(teamName: string, scopeKey: string, input: SaveReviewDecisionStateInput): Promise<number>;
  clear(teamName: string, scopeKey: string): Promise<void>;
  clearUnreadableExactScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void>;
}

export interface ReviewDecisionValidationPort {
  assertValidSnapshot(state: ReviewPersistedStateSnapshot): void;
}

export interface ReviewDecisionRecoveryInspection {
  containsPotentialDiskMutation: boolean;
  corruptRecordCount: number;
}

export interface ReviewDecisionRecoveryPort {
  recover(teamName: string, scope: ReviewHistoryPersistenceScope): Promise<void>;
  inspectForDiscard(
    teamName: string,
    scope: ReviewHistoryPersistenceScope
  ): Promise<ReviewDecisionRecoveryInspection>;
  quarantineCorruptScope(teamName: string, scope: ReviewHistoryPersistenceScope): Promise<void>;
  clearScope(teamName: string, scope: ReviewHistoryPersistenceScope): Promise<void>;
}

export interface ReviewDecisionHistoryDependencies {
  lock: ReviewHistoryPersistenceLockPort;
  authorization: ReviewDecisionAuthorizationPort;
  queries: ReviewDecisionQueryPort;
  mutations: ReviewDecisionMutationPort;
  validation: ReviewDecisionValidationPort;
  recovery: ReviewDecisionRecoveryPort;
}
