import type { ReviewPathAuthorization } from './ReviewScopeAuthorizationPorts';
import type {
  FileChangeSummary,
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
} from '@shared/types/review';

export interface ReviewDecisionPersistenceScopePort {
  parse(value: unknown): ReviewFileScope;
  resolve(
    value: unknown,
    options: { requireIdentity: true }
  ): Promise<{ scope: ReviewFileScope; authorization: ReviewPathAuthorization }>;
  normalizeIdentityPath(filePath: string): string;
  validateFilePath(
    authorization: ReviewPathAuthorization,
    filePath: unknown,
    options: { requireReviewedFile: true }
  ): Promise<string>;
  getAuthoritativeFile(authorization: ReviewPathAuthorization, filePath: string): FileChangeSummary;
}

export interface ReviewDecisionPersistencePathPort {
  isAbsoluteNormalized(filePath: string): boolean;
}

export interface ReviewDecisionPersistenceLockPort {
  withLogicalScopeLock<T>(
    teamName: string,
    scopeKey: string,
    operation: () => Promise<T>
  ): Promise<T>;
  withPersistenceScopeLock<T>(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope,
    operation: () => Promise<T>
  ): Promise<T>;
}

export interface ReviewDecisionPersistenceDependencies {
  scope: ReviewDecisionPersistenceScopePort;
  paths: ReviewDecisionPersistencePathPort;
  locks: ReviewDecisionPersistenceLockPort;
}

export interface ReviewDraftHistoryScopeAuthorization {
  isCurrentReviewedFile(filePath: string): boolean;
  assertCurrentReviewedFile(filePath: string): Promise<void>;
}

export interface ReviewDecisionHistoryScopeAuthorization {
  files: FileChangeSummary[] | null;
  normalizePath(filePath: string): string;
  resolveFile(filePath: string): FileChangeSummary;
}
