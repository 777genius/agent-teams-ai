import type {
  ReviewIdentityValidators,
  ReviewRootConfig,
} from '../../core/domain/reviewScopePolicy';
import type {
  AuthoritativeReviewFileHost,
  AuthoritativeReviewFiles,
} from './authoritativeReviewFiles';
import type { FileChangeSummary, FileChangeWithContent, SnippetDiff } from '@shared/types/review';

export interface AuthorizedReviewRoot {
  lexicalPath: string;
  realPath: string;
}

export interface ReviewPathAuthorization {
  roots: AuthorizedReviewRoot[];
  reviewedFiles: AuthoritativeReviewFiles | null;
  identity: AuthoritativeReviewFileHost;
  resolutionMemberName: string;
  selectedReviewKeys?: ReadonlyMap<string, string>;
}

export interface ReviewScopeConfigPort {
  getConfig(teamName: string): Promise<ReviewRootConfig | null>;
}

export interface ReviewScopeChangesPort {
  getTaskChanges(
    teamName: string,
    taskId: string
  ): Promise<{ files: FileChangeSummary[]; scope?: { memberName?: string } }>;
  getAgentChanges(teamName: string, memberName: string): Promise<{ files: FileChangeSummary[] }>;
}

export interface ReviewScopeContentPort {
  getFileContent(
    teamName: string,
    memberName: string,
    filePath: string,
    snippets: SnippetDiff[]
  ): Promise<FileChangeWithContent>;
  invalidateFile(filePath: string): void;
}

export interface ReviewScopePathPort extends AuthoritativeReviewFileHost {
  dirname(filePath: string): string;
  isWithinRoot(filePath: string, rootPath: string, options?: { preserveCase?: boolean }): boolean;
  isSensitive(filePath: string): boolean;
}

export interface ReviewScopeFileStat {
  kind: 'directory' | 'file' | 'symbolic-link' | 'other';
  linkCount: number;
}

export interface ReviewScopeFileSystemPort {
  stat(filePath: string): Promise<ReviewScopeFileStat>;
  lstat(filePath: string): Promise<ReviewScopeFileStat>;
  realpath(filePath: string): Promise<string>;
  cleanupOwnedTemporaryLinks(filePath: string): Promise<void>;
  isOwnedTransactionHardlink(
    filePath: string,
    reviewedPaths: string[],
    rootPaths: string[]
  ): Promise<boolean>;
}

export interface ReviewScopeAuthorizationDependencies {
  validators: ReviewIdentityValidators;
  config: ReviewScopeConfigPort;
  changes: ReviewScopeChangesPort;
  content: ReviewScopeContentPort;
  paths: ReviewScopePathPort;
  files: ReviewScopeFileSystemPort;
}
