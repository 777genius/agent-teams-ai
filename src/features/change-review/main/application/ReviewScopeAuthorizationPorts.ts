import type {
  ReviewIdentityValidators,
  ReviewRootConfig,
} from '../../core/domain/reviewScopePolicy';
import type { FileChangeSummary, FileChangeWithContent, SnippetDiff } from '@shared/types/review';

export interface AuthorizedReviewRoot {
  lexicalPath: string;
  realPath: string;
}

export interface ReviewPathAuthorization {
  roots: AuthorizedReviewRoot[];
  reviewedFiles: Map<string, FileChangeSummary> | null;
  resolutionMemberName: string;
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

export interface ReviewScopePathPort {
  normalize(filePath: string): string;
  dirname(filePath: string): string;
  isAbsolute(filePath: string): boolean;
  isWithinRoot(filePath: string, rootPath: string): boolean;
  isSensitive(filePath: string): boolean;
  normalizeIdentity(filePath: string): string;
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
  isOwnedTransactionHardlink(filePath: string): Promise<boolean>;
}

export interface ReviewScopeAuthorizationDependencies {
  validators: ReviewIdentityValidators;
  config: ReviewScopeConfigPort;
  changes: ReviewScopeChangesPort;
  content: ReviewScopeContentPort;
  paths: ReviewScopePathPort;
  files: ReviewScopeFileSystemPort;
}
