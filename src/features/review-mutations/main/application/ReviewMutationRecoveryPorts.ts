import type {
  PrepareReviewMutationInput,
  ReviewMutationJournalDiskStep,
  ReviewMutationJournalRecord,
} from '../../core/application/ReviewMutationJournalTypes';
import type { ReviewMutationSteps } from '../../core/application/ReviewMutationCoordinator';
import type {
  ExecuteReviewMutationRequest,
  FileChangeSummary,
  FileChangeWithContent,
  ReviewDecisionPersistenceScope,
  ReviewDirectDiskMutationStep,
  ReviewFileScope,
  ReviewMutationDiskPostimage,
  ReviewPersistedStateSnapshot,
  ReviewRenameRecoveryExpectation,
  ReviewUndoAction,
  SnippetDiff,
} from '@shared/types/review';

export interface ReviewMutationPathAuthorization {
  roots: { lexicalPath: string; realPath: string }[];
  reviewedFiles: Map<string, FileChangeSummary> | null;
  resolutionMemberName: string;
}

export interface LoadedReviewMutationDecisions extends ReviewPersistedStateSnapshot {
  revision: number;
}

export interface ReviewMutationScopePort {
  parse(value: unknown): ReviewFileScope;
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
    filePath: string,
    options: { requireReviewedFile: boolean; rejectHardlinks: boolean }
  ): Promise<string>;
  validateSnippets(
    authorization: ReviewMutationPathAuthorization,
    snippets: SnippetDiff[],
    options: { requireReviewedFile: boolean; rejectHardlinks: boolean }
  ): Promise<void>;
  resolveAuthoritativeContent(
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): Promise<FileChangeWithContent>;
  assertExpectedRename(
    content: FileChangeWithContent,
    expectation: ReviewRenameRecoveryExpectation
  ): void;
  parseRenameExpectation(value: unknown): ReviewRenameRecoveryExpectation;
  assertDecisionShape(value: unknown): void;
  assertSnippetShapes(value: unknown): asserts value is SnippetDiff[];
  getAuthoritativeFile(
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): FileChangeSummary;
  normalizeIdentityPath(filePath: string): string;
  normalizeFilesystemPath(filePath: string): string;
}

export interface ReviewMutationDecisionPort {
  withLock<T>(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope,
    operation: () => Promise<T>
  ): Promise<T>;
  assertValidSnapshot(value: ReviewPersistedStateSnapshot): void;
  assertCurrentRevision(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope,
    expectedRevision: number
  ): Promise<void>;
  load(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<LoadedReviewMutationDecisions | null>;
  commit(record: ReviewMutationJournalRecord): Promise<void>;
  assertExactTransition(
    request: ExecuteReviewMutationRequest,
    current: LoadedReviewMutationDecisions | null,
    authorization: ReviewMutationPathAuthorization
  ): void;
  bindAuthoritativeForwardMutation(
    request: ExecuteReviewMutationRequest,
    current: LoadedReviewMutationDecisions | null,
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization
  ): Promise<ReviewPersistedStateSnapshot>;
  assertAuthoritativelyBoundAction(action: ReviewUndoAction): void;
}

export interface ReviewMutationJournalRepositoryPort {
  list(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<ReviewMutationJournalRecord[]>;
  checkpoint(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord>;
  markFailed(record: ReviewMutationJournalRecord, error: unknown): Promise<void>;
  unblock(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord>;
}

export interface ReviewMutationCoordinatorPort {
  execute(
    input: PrepareReviewMutationInput,
    steps: ReviewMutationSteps<ReviewMutationJournalRecord>
  ): Promise<ReviewMutationJournalRecord>;
  resume(
    record: ReviewMutationJournalRecord,
    steps: ReviewMutationSteps<ReviewMutationJournalRecord>
  ): Promise<ReviewMutationJournalRecord>;
}

export type DirectReviewMutationState = 'before' | 'after' | 'both' | 'intermediate';

export interface ReviewMutationDiskApplierPort {
  getRejectedRenamePostimages(
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[],
    direction: 'restore' | 'reapply'
  ): Promise<ReviewMutationDiskPostimage[]>;
  classifyEditedFileTransition(
    filePath: string,
    beforeContent: string | null,
    afterContent: string | null
  ): Promise<Exclude<DirectReviewMutationState, 'intermediate'>>;
  classifyRejectedRenameTransition(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<'accepted' | 'rejected' | 'both' | 'restoring' | 'reapplying' | 'legacy-reapplying'>;
  saveEditedFile(
    filePath: string,
    content: string,
    expectedContent: string | null
  ): Promise<unknown>;
  deleteEditedFile(filePath: string, expectedContent: string): Promise<unknown>;
  restoreRejectedRename(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<unknown>;
  reapplyRejectedRename(
    filePath: string,
    original: string | null,
    snippets: SnippetDiff[]
  ): Promise<unknown>;
  finalizeEditedFileTransaction?(
    filePath: string,
    expectedContent: string | null,
    nextContent: string | null
  ): Promise<void>;
  finalizeRejectedRenameTransaction?(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[],
    direction: 'restore' | 'reapply'
  ): Promise<void>;
}

export interface ReviewMutationContentCachePort {
  invalidateAuthoritativeContent(content: FileChangeWithContent): void;
  invalidateFile(filePath: string): void;
}

export interface ReviewMutationLoggerPort {
  warn(message: string, error: unknown): void;
  error(message: string, error: unknown): void;
}

export interface ReviewDirectMutationDiskDependencies {
  scope: ReviewMutationScopePort;
  journal: ReviewMutationJournalRepositoryPort;
  applier: ReviewMutationDiskApplierPort;
  cache: ReviewMutationContentCachePort;
  logger: ReviewMutationLoggerPort;
}

export interface ReviewDirectMutationDiskPort {
  normalize(
    steps: readonly ReviewDirectDiskMutationStep[],
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization
  ): Promise<ReviewMutationJournalDiskStep[]>;
  buildPostimages(
    steps: readonly ReviewMutationJournalDiskStep[]
  ): Promise<ReviewMutationDiskPostimage[]>;
  buildRecoveryPostimages(
    record: ReviewMutationJournalRecord
  ): Promise<ReviewMutationDiskPostimage[]>;
  classify(step: ReviewMutationJournalDiskStep): Promise<DirectReviewMutationState>;
  assertPreimages(steps: readonly ReviewMutationJournalDiskStep[]): Promise<void>;
  apply(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord>;
}

export interface ReviewMutationRecoveryDependencies {
  scope: ReviewMutationScopePort;
  decisions: ReviewMutationDecisionPort;
  journal: ReviewMutationJournalRepositoryPort;
  coordinator: ReviewMutationCoordinatorPort;
  disk: ReviewDirectMutationDiskPort;
  applyDecisionBatchDisk(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord>;
  logger: ReviewMutationLoggerPort;
}
