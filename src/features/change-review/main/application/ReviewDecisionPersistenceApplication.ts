import {
  assertReviewDecisionShape,
  parseReviewDecisionPersistenceScope,
  parseReviewHistoryScopeIdentity,
} from '../../core/domain/reviewDecisionPersistencePolicy';

import type {
  ReviewDecisionHistoryScopeAuthorization,
  ReviewDecisionPersistenceDependencies,
  ReviewDraftHistoryScopeAuthorization,
} from './ReviewDecisionPersistencePorts';
import type { ReviewPathAuthorization } from './ReviewScopeAuthorizationPorts';
import type {
  FileReviewDecision,
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
} from '@shared/types/review';

export class ReviewDecisionPersistenceApplication {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: ReviewDecisionPersistenceDependencies) {}

  assertDecisionShape(value: unknown): asserts value is FileReviewDecision {
    assertReviewDecisionShape(value);
  }

  parsePersistenceScope(
    value: unknown,
    scope: ReviewFileScope
  ): ReviewDecisionPersistenceScope | null {
    return parseReviewDecisionPersistenceScope(value, scope);
  }

  async withLock<T>(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${teamName}:${persistenceScope.scopeKey}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queueTail = previous.then(
      () => current,
      () => current
    );
    this.queues.set(key, queueTail);

    await previous.catch(() => undefined);
    try {
      return await this.dependencies.locks.withLogicalScopeLock(
        teamName,
        persistenceScope.scopeKey,
        () =>
          this.dependencies.locks.withPersistenceScopeLock(teamName, persistenceScope, operation)
      );
    } finally {
      release();
      if (this.queues.get(key) === queueTail) {
        this.queues.delete(key);
      }
    }
  }

  async authorizeDraftHistoryScope(
    teamName: string,
    scopeKey: string
  ): Promise<ReviewDraftHistoryScopeAuthorization> {
    const authorization = await this.resolveHistoryAuthorization(teamName, scopeKey);
    return {
      isCurrentReviewedFile: (filePath) =>
        this.dependencies.paths.isAbsoluteNormalized(filePath) &&
        Boolean(
          authorization.reviewedFiles?.has(this.dependencies.scope.normalizeIdentityPath(filePath))
        ),
      assertCurrentReviewedFile: async (filePath) => {
        await this.dependencies.scope.validateFilePath(authorization, filePath, {
          requireReviewedFile: true,
        });
      },
    };
  }

  async authorizeDecisionHistoryScope(
    teamName: string,
    scopeKey: string
  ): Promise<ReviewDecisionHistoryScopeAuthorization> {
    const authorization = await this.resolveHistoryAuthorization(teamName, scopeKey);
    return {
      files: authorization.reviewedFiles ? [...authorization.reviewedFiles.values()] : null,
      normalizePath: (filePath) => this.dependencies.scope.normalizeIdentityPath(filePath),
      resolveFile: (filePath) =>
        this.dependencies.scope.getAuthoritativeFile(authorization, filePath),
    };
  }

  private async resolveHistoryAuthorization(
    teamName: string,
    scopeKey: string
  ): Promise<ReviewPathAuthorization> {
    const scope = this.dependencies.scope.parse({
      teamName,
      ...parseReviewHistoryScopeIdentity(scopeKey),
    });
    const { authorization } = await this.dependencies.scope.resolve(scope, {
      requireIdentity: true,
    });
    return authorization;
  }
}
