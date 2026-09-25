import type {
  LoadedReviewMutationDecisions,
  ReviewMutationPathAuthorization,
} from './ReviewMutationRecoveryPorts';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewFileScope,
  ReviewRenameRecoveryExpectation,
} from '@shared/types/review';

export interface ReviewHistoryMutationScopePort {
  validateFilePath(
    authorization: ReviewMutationPathAuthorization,
    filePath: string,
    options: { requireReviewedFile: boolean; rejectHardlinks: boolean }
  ): Promise<string>;
  getAuthoritativeFile(
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): FileChangeSummary;
  resolveAuthoritativeContent(
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): Promise<FileChangeWithContent>;
  parseRenameExpectation(value: unknown): ReviewRenameRecoveryExpectation;
  assertExpectedRename(
    content: FileChangeWithContent,
    expectation: ReviewRenameRecoveryExpectation
  ): void;
  normalizeIdentityPath(filePath: string): string;
}

export interface ReviewHistoryMutationFilePort {
  readText(filePath: string): Promise<string>;
}

export interface ReviewHistoryMutationDependencies {
  scope: ReviewHistoryMutationScopePort;
  files: ReviewHistoryMutationFilePort;
}

export type ReviewHistoryMutationCurrentState = LoadedReviewMutationDecisions | null;
