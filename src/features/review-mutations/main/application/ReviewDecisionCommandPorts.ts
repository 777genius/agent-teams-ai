import type { ReviewMutationSteps } from '../../core/application/ReviewMutationCoordinator';
import type {
  PrepareReviewMutationInput,
  ReviewMutationJournalRecord,
} from '../../core/application/ReviewMutationJournalTypes';
import type { ReviewDecisionCommandCurrentState } from '../../core/domain/reviewDecisionCommandPolicy';
import type { ReviewMutationPathAuthorization } from './ReviewMutationRecoveryPorts';
import type {
  ApplyReviewRequest,
  ApplyReviewResult,
  ConflictCheckResult,
  FileChangeSummary,
  FileChangeWithContent,
  FileReviewDecision,
  RejectResult,
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
  ReviewMutationDiskPostimage,
  ReviewPersistedStateSnapshot,
  SnippetDiff,
} from '@shared/types/review';

export interface ReviewDecisionCommandScopePort {
  resolve(
    value: unknown,
    options: { requireIdentity: true }
  ): Promise<{ scope: ReviewFileScope; authorization: ReviewMutationPathAuthorization }>;
  parsePersistenceScope(
    value: unknown,
    scope: ReviewFileScope
  ): ReviewDecisionPersistenceScope | null;
  validateFilePath(
    authorization: ReviewMutationPathAuthorization,
    filePath: unknown,
    options: { requireReviewedFile: boolean; rejectHardlinks: boolean }
  ): Promise<string>;
  validateSnippets(
    authorization: ReviewMutationPathAuthorization,
    snippets: SnippetDiff[],
    options: { requireReviewedFile: boolean; rejectHardlinks: boolean }
  ): Promise<void>;
  assertDecisionShape(value: unknown): asserts value is FileReviewDecision;
  assertSnippetShapes(value: unknown): asserts value is SnippetDiff[];
  getAuthoritativeFile(
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): FileChangeSummary;
  resolveAuthoritativeContent(
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): Promise<FileChangeWithContent>;
  normalizeIdentityPath(filePath: string): string;
}

export interface ReviewDecisionCommandApplierPort {
  checkConflict(filePath: string, expectedModified: string): Promise<ConflictCheckResult>;
  rejectHunks(
    teamName: string,
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Promise<RejectResult>;
  rejectFile(
    teamName: string,
    filePath: string,
    original: string,
    modified: string
  ): Promise<RejectResult>;
  previewReject(
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Promise<{ preview: string; hasConflicts: boolean }>;
  applyReviewDecisions(
    request: ApplyReviewRequest,
    fileContents: Map<string, FileChangeWithContent>
  ): Promise<ApplyReviewResult>;
}

export interface ReviewDecisionCommandPersistencePort {
  withLock<T>(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope,
    operation: () => Promise<T>
  ): Promise<T>;
  assertValidSnapshot(value: ReviewPersistedStateSnapshot): void;
  load(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<ReviewDecisionCommandCurrentState | null>;
}

export interface ReviewDecisionCommandBatchPort {
  assertPersistedStateIncludesDecisions(
    state: ReviewPersistedStateSnapshot,
    decisions: readonly FileReviewDecision[]
  ): void;
  applyDisk(
    record: ReviewMutationJournalRecord,
    onResult?: (result: ApplyReviewResult) => void,
    onPostimages?: (postimages: readonly ReviewMutationDiskPostimage[]) => void
  ): Promise<ReviewMutationJournalRecord>;
  commit(record: ReviewMutationJournalRecord): Promise<void>;
}

export interface ReviewDecisionCommandHistoryPort {
  bindNewHistorySnapshots(
    state: ReviewPersistedStateSnapshot,
    current: ReviewDecisionCommandCurrentState | null,
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization
  ): Promise<ReviewPersistedStateSnapshot>;
}

export interface ReviewDecisionCommandRecoveryPort {
  recoverPending(teamName: string, persistenceScope: ReviewDecisionPersistenceScope): Promise<void>;
}

export interface ReviewDecisionCommandCoordinatorPort {
  execute(
    input: PrepareReviewMutationInput,
    steps: ReviewMutationSteps<ReviewMutationJournalRecord>
  ): Promise<ReviewMutationJournalRecord>;
}

export interface ReviewDecisionCommandSnapshotIdentityPort {
  now(): number;
  createToken(): string;
  fingerprintSnippets(snippets: SnippetDiff[]): string;
}

export interface ReviewDecisionCommandCachePort {
  invalidateFile(filePath: string): void;
}

export interface ReviewDecisionCommandLoggerPort {
  debug(message: string, error: unknown): void;
}

export interface ReviewDecisionCommandDependencies {
  scope: ReviewDecisionCommandScopePort;
  applier: ReviewDecisionCommandApplierPort;
  persistence: ReviewDecisionCommandPersistencePort;
  batch: ReviewDecisionCommandBatchPort;
  history: ReviewDecisionCommandHistoryPort;
  recovery: ReviewDecisionCommandRecoveryPort;
  coordinator: ReviewDecisionCommandCoordinatorPort;
  snapshots: ReviewDecisionCommandSnapshotIdentityPort;
  cache: ReviewDecisionCommandCachePort;
  logger: ReviewDecisionCommandLoggerPort;
}
