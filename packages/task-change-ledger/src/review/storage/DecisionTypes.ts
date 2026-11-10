import type {
  FileChangeSummary,
  FileReviewDecision,
  HunkDecision,
  ReviewConflictResolution,
  ReviewDecisionConflictCandidate,
  ReviewDecisionConflictCandidateSummary,
  ReviewDiskUndoAction,
  ReviewDiskUndoSnapshot,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '../../contracts.js';

export const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;

export const MAX_STORED_DECISIONS_BYTES = 128 * 1024 * 1024;

export const MAX_STORED_DECISION_ENTRIES = 200_000;

export const MAX_STORED_CONTEXT_FILES = 2_000;

export const MAX_STORED_KEY_LENGTH = 32_768;

export const MAX_STORED_REVIEW_ACTIONS = 100_000;

export const MAX_RETAINED_DECISION_SCOPES = 16;

export const MAX_RETAINED_CONFLICT_CANDIDATES = 8;

export const MAX_RETAINED_LOGICAL_SCOPE_CONFLICT_CANDIDATES = 32;

export const EXACT_SCOPE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

export const EXACT_SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface ReviewDecisionsData {
  scopeToken?: string;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  /** filePath -> (hunkIndex -> contextHash) */
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  /** Ordered, self-contained Accept/Reject Undo history for this exact scope. */
  reviewActionHistory?: ReviewUndoAction[];
  /** Durable forward branch created by Undo and cleared by a new review action. */
  reviewRedoHistory?: ReviewRedoAction[];
  updatedAt: string;
}

export interface ReviewDecisionsDataV2 extends ReviewDecisionsData {
  version: 2;
  scopeKey: string;
  scopeToken: string;
}

export interface ReviewDecisionsDataV3 extends ReviewDecisionsData {
  version: 3;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
}

export interface ReviewDecisionsDataV4 extends ReviewDecisionsData {
  version: 4;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
  revision: number;
  lastMutationId?: string;
}

export interface ReviewDecisionsDataV5 extends ReviewDecisionsData {
  version: 5;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  revision: number;
  lastMutationId?: string;
}

export type StoredReviewDiskUndoSnapshotV6 = Omit<
  ReviewDiskUndoSnapshot,
  'beforeContent' | 'afterContent' | 'file'
> & {
  beforeBlob: string;
  afterBlob: string | null;
  fileRef?: string;
};

export type StoredReviewDiskUndoActionV6 = Omit<ReviewDiskUndoAction, 'snapshot' | 'file'> & {
  snapshot: StoredReviewDiskUndoSnapshotV6;
  fileRef?: string;
};

export type StoredReviewUndoActionV6 =
  | (Omit<Extract<ReviewUndoAction, { kind: 'bulk' }>, 'diskSnapshots'> & {
      diskSnapshots: StoredReviewDiskUndoSnapshotV6[];
    })
  | (Omit<Extract<ReviewUndoAction, { kind: 'disk' }>, 'action'> & {
      action: StoredReviewDiskUndoActionV6;
    })
  | Extract<ReviewUndoAction, { kind: 'hunk' }>;

export type StoredReviewRedoActionV6 = Omit<ReviewRedoAction, 'action'> & {
  action: StoredReviewUndoActionV6;
};

export interface StoredReviewDecisionsDataV6 extends Omit<
  ReviewDecisionsData,
  'reviewActionHistory' | 'reviewRedoHistory'
> {
  version: 6;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: StoredReviewUndoActionV6[];
  reviewRedoHistory: StoredReviewRedoActionV6[];
  textBlobs: Record<string, string>;
  fileSummaryBlobs: Record<string, FileChangeSummary>;
  revision: number;
  lastMutationId?: string;
}

export interface ParsedReviewDecisionsDataV6 extends ReviewDecisionsData {
  version: 6;
  scopeKey: string;
  scopeToken: string;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  revision: number;
  lastMutationId?: string;
}

export interface StoredReviewDecisionConflictCandidateV1 {
  version: 1;
  id: string;
  scopeKey: string;
  scopeTokenHash: string;
  capturedAt: string;
  expectedRevision: number;
  observedCurrentRevision: number;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: StoredReviewUndoActionV6[];
  reviewRedoHistory: StoredReviewRedoActionV6[];
  textBlobs: Record<string, string>;
  fileSummaryBlobs: Record<string, FileChangeSummary>;
}

export interface LoadedReviewDecisions {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  revision: number;
}

export interface InternalLoadedReviewDecisions extends LoadedReviewDecisions {
  lastMutationId?: string;
  storageVersion: number;
}

export class InvalidReviewDecisionDataError extends Error {}

export function shouldQuarantineDecisionConflictCandidate(error: unknown): boolean {
  if (error instanceof InvalidReviewDecisionDataError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith('Unsafe review decision conflict candidate') ||
    error.message === 'Unsafe or oversized review decision conflict candidate' ||
    error.message === 'Review decision conflict candidate changed while being read'
  );
}

export interface StorageLogger {
  warn(message: string): void;
  error(message: string): void;
}
export interface DecisionContext {
  readonly teamsRoot: string;
  readonly logger: StorageLogger;
  assertValidSnapshot(data: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
    reviewActionHistory?: ReviewUndoAction[];
    reviewRedoHistory?: ReviewRedoAction[];
  }): void;
  assertSafeScope(teamName: string, scopeKey: string, scopeToken?: string): void;
  getLegacyDirPath(teamName: string): string;
  getLegacyFilePath(teamName: string, scopeKey: string): string;
  getV2DirPath(teamName: string, scopeKey: string): string;
  getV2FilePath(teamName: string, scopeKey: string, scopeToken: string): string;
  getConflictCandidateDir(teamName: string, scopeKey: string, scopeToken: string): string;
  getConflictScopeDir(teamName: string, scopeKey: string): string;
  getConflictCandidateDirByScopeHash(teamName: string, scopeKey: string, scopeHash: string): string;
  inspectConflictScopes(
    teamName: string,
    scopeKey: string
  ): Promise<{ scopeHashes: Set<string>; candidatePaths: Set<string> }>;
  getConflictCandidatePath(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): string;
  ensureConflictCandidateDir(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<string>;
  hashHistoryBlob(kind: 'text' | 'file-summary', value: string): string;
  encodeHistoryV6(
    undoHistory: readonly ReviewUndoAction[],
    redoHistory: readonly ReviewRedoAction[]
  ): Pick<
    StoredReviewDecisionsDataV6,
    'reviewActionHistory' | 'reviewRedoHistory' | 'textBlobs' | 'fileSummaryBlobs'
  >;
  decodeHistoryV6(data: {
    reviewActionHistory?: unknown;
    reviewRedoHistory?: unknown;
    textBlobs?: unknown;
    fileSummaryBlobs?: unknown;
  }): { undo: ReviewUndoAction[]; redo: ReviewRedoAction[] } | null;
  getConflictCandidateIdentityPayload(
    candidate: Omit<
      StoredReviewDecisionConflictCandidateV1,
      'version' | 'id' | 'capturedAt' | 'observedCurrentRevision'
    >
  ): object;
  parseConflictCandidate(
    value: unknown,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): ReviewDecisionConflictCandidate;
  loadConflictCandidateFromPath(
    filePath: string,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): Promise<ReviewDecisionConflictCandidate>;
  assertConflictCandidateCapacity(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    protectedPath: string,
    replacementPath?: string
  ): Promise<void>;
  writeConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedRevision: number,
    observedCurrentRevision: number,
    state: ReviewPersistedStateSnapshot,
    replacementPath?: string
  ): Promise<void>;
  parseStoredData(
    parsed: unknown
  ):
    | ReviewDecisionsData
    | ReviewDecisionsDataV2
    | ReviewDecisionsDataV3
    | ReviewDecisionsDataV4
    | ReviewDecisionsDataV5
    | ParsedReviewDecisionsDataV6
    | null;
  isReviewActionHistory(value: unknown): value is ReviewUndoAction[];
  isReviewActionDescriptor(value: unknown): boolean;
  isReviewActionDescriptorConsistent(action: ReviewUndoAction): boolean;
  isReviewRedoHistory(value: unknown): value is ReviewRedoAction[];
  hasDisjointReviewActionIds(
    undoHistory: readonly ReviewUndoAction[],
    redoHistory: readonly ReviewRedoAction[]
  ): boolean;
  getDiskBackedHistory(snapshot: {
    reviewActionHistory: readonly ReviewUndoAction[];
    reviewRedoHistory: readonly ReviewRedoAction[];
  }): object[];
  isDecisionSnapshot(value: unknown): boolean;
  isHunkUndoAction(value: unknown): boolean;
  isDiskUndoAction(value: unknown): boolean;
  isDiskUndoSnapshot(value: unknown): boolean;
  isFileSummary(value: unknown): boolean;
  isDecisionRecord(value: unknown): value is Record<string, HunkDecision>;
  isContextHashRecord(value: unknown): value is Record<string, Record<number, string>> | undefined;
  extractDecisions(
    data:
      | ReviewDecisionsData
      | ReviewDecisionsDataV2
      | ReviewDecisionsDataV3
      | ReviewDecisionsDataV4
      | ReviewDecisionsDataV5
      | ParsedReviewDecisionsDataV6,
    scopeToken?: string
  ): InternalLoadedReviewDecisions | null;
  loadFromPath(
    filePath: string,
    scopeToken?: string,
    expectedScopeKey?: string
  ): Promise<InternalLoadedReviewDecisions | null>;
  getPendingMutationScopeHashes(teamName: string, scopeKey: string): Promise<Set<string>>;
  pruneScopeDir(teamName: string, scopeKey: string, protectedPath: string): Promise<void>;
  loadInternal(
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ): Promise<InternalLoadedReviewDecisions | null>;
  load(
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ): Promise<LoadedReviewDecisions | null>;
  mapConflictCandidates<T extends { id: string; capturedAt: string }>(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    mapCandidate: (candidate: ReviewDecisionConflictCandidate) => T
  ): Promise<T[]>;
  loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidate[]>;
  loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidateSummary[]>;
  locateConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<{ candidatePath: string; candidate: ReviewDecisionConflictCandidate }>;
  loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDecisionConflictCandidate>;
  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number
  ): Promise<number>;
  save(
    teamName: string,
    scopeKey: string,
    data: {
      scopeToken: string;
      hunkDecisions: Record<string, HunkDecision>;
      fileDecisions: Record<string, HunkDecision>;
      hunkContextHashesByFile?: Record<string, Record<number, string>>;
      reviewActionHistory?: ReviewUndoAction[];
      reviewRedoHistory?: ReviewRedoAction[];
      expectedRevision?: number;
      mutationId?: string;
    }
  ): Promise<number>;
  mergeFileDecisionPatch(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    decision: FileReviewDecision & { reviewKey: string }
  ): Promise<void>;
  clear(teamName: string, scopeKey: string, scopeToken?: string): Promise<void>;
  clearUnreadableExactScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void>;
}
