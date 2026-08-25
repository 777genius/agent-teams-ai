import type { ReviewMutationPathAuthorization } from './ReviewMutationRecoveryPorts';
import type {
  FileChangeWithContent,
  ReviewFileScope,
  ReviewRenameRecoveryExpectation,
  SnippetDiff,
} from '@shared/types/review';

export interface ReviewEditableMutationScopePort {
  parseReviewRenameRecoveryExpectation(value: unknown): ReviewRenameRecoveryExpectation;
  resolveReviewPathAuthorization(
    value: unknown,
    options: { requireIdentity: true }
  ): Promise<{ scope: ReviewFileScope; authorization: ReviewMutationPathAuthorization }>;
  validateAuthorizedReviewFilePath(
    authorization: ReviewMutationPathAuthorization,
    filePath: unknown,
    options: { requireReviewedFile: true; rejectHardlinks: true }
  ): Promise<string>;
  resolveAuthoritativeFileContent(
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): Promise<FileChangeWithContent>;
  validateSnippetPaths(
    authorization: ReviewMutationPathAuthorization,
    snippets: SnippetDiff[],
    options: { requireReviewedFile: true; rejectHardlinks: true }
  ): Promise<void>;
  assertExpectedAuthoritativeRename(
    content: FileChangeWithContent,
    expectation: ReviewRenameRecoveryExpectation
  ): void;
  invalidateAuthoritativeReviewContent(content: FileChangeWithContent): void;
}

export interface ReviewEditableMutationApplierPort {
  saveEditedFile(
    filePath: string,
    content: string,
    expectedCurrentContent: string | null
  ): Promise<{ success: boolean }>;
  deleteEditedFile(filePath: string, expectedCurrentContent: string): Promise<{ success: boolean }>;
  restoreRejectedRename(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: boolean }>;
  reapplyRejectedRename(
    filePath: string,
    original: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: boolean }>;
}

export interface ReviewEditableMutationContentPort {
  invalidateFile(filePath: string): void;
}

export interface ReviewEditableMutationDependencies {
  scope: ReviewEditableMutationScopePort;
  applier: ReviewEditableMutationApplierPort;
  content: ReviewEditableMutationContentPort;
}
