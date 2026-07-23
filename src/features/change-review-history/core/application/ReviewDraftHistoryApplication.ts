import type {
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
} from '../../contracts';
import type {
  ReviewDraftHistoryAuthorization,
  ReviewDraftHistoryAuthorizationPort,
  ReviewDraftHistoryConflictMutationPort,
  ReviewDraftHistoryEntryMutationPort,
  ReviewDraftHistoryPersistenceLockPort,
  ReviewDraftHistoryPersistenceScope,
  ReviewDraftHistoryQueryPort,
} from './ports';
import type { ReviewConflictResolution } from '@shared/types/review';

export interface ReviewDraftHistoryApplicationDependencies {
  lock: ReviewDraftHistoryPersistenceLockPort;
  authorization: ReviewDraftHistoryAuthorizationPort;
  queries: ReviewDraftHistoryQueryPort;
  conflictMutations: ReviewDraftHistoryConflictMutationPort;
  entryMutations: ReviewDraftHistoryEntryMutationPort;
}

export class ReviewDraftHistoryApplication {
  constructor(private readonly dependencies: ReviewDraftHistoryApplicationDependencies) {}

  private runAuthorized<T>(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    operation: (authorization: ReviewDraftHistoryAuthorization) => Promise<T>
  ): Promise<T> {
    const persistenceScope: ReviewDraftHistoryPersistenceScope = { scopeKey, scopeToken };
    return this.dependencies.lock.run(teamName, persistenceScope, async () => {
      const authorization = await this.dependencies.authorization.authorize(teamName, scopeKey);
      return operation(authorization);
    });
  }

  load(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistorySnapshot | null> {
    return this.runAuthorized(teamName, scopeKey, scopeToken, async (authorization) => {
      const snapshot = await this.dependencies.queries.load(teamName, scopeKey, scopeToken);
      for (const filePath of Object.keys(snapshot?.entries ?? {})) {
        await authorization.assertCurrentReviewedFile(filePath);
      }
      return snapshot;
    });
  }

  loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidateSummary[]> {
    return this.runAuthorized(teamName, scopeKey, scopeToken, async (authorization) => {
      const candidates = await this.dependencies.queries.loadConflictCandidateSummaries(
        teamName,
        scopeKey,
        scopeToken
      );
      return Promise.all(
        candidates.map(async (candidate) => {
          if (
            candidate.origin === 'prior-snapshot' &&
            !authorization.isCurrentReviewedFile(candidate.filePath)
          ) {
            return { ...candidate, recoverability: 'file-not-in-current-review' as const };
          }
          await authorization.assertCurrentReviewedFile(candidate.filePath);
          return candidate;
        })
      );
    });
  }

  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryEntry | null> {
    return this.runAuthorized(teamName, scopeKey, scopeToken, async (authorization) => {
      const candidate = await this.dependencies.queries.loadConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId
      );
      if (resolution === 'recover-candidate') {
        await authorization.assertCurrentReviewedFile(candidate.filePath);
      }
      return this.dependencies.conflictMutations.resolveConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId,
        resolution,
        expectedCurrentRevision,
        expectedCurrentGeneration
      );
    });
  }

  replaceConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryConflictCandidateSummary> {
    return this.runAuthorized(teamName, scopeKey, scopeToken, async (authorization) => {
      await authorization.assertCurrentReviewedFile(expectedEntry.filePath);
      if (replacementEntry.filePath !== expectedEntry.filePath) {
        throw new Error('Manual-edit recovery update changed file identity');
      }
      const replacement = await this.dependencies.conflictMutations.replaceConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        expectedEntry,
        replacementEntry,
        expectedCurrentRevision,
        expectedCurrentGeneration
      );
      return {
        id: replacement.id,
        capturedAt: replacement.capturedAt,
        origin: replacement.origin,
        recoverability: 'recoverable',
        filePath: replacement.filePath,
        expectedRevision: replacement.expectedRevision,
        expectedGeneration: replacement.expectedGeneration,
        observedCurrentRevision: replacement.observedCurrentRevision,
        observedCurrentGeneration: replacement.observedCurrentGeneration,
        entryRevision: replacement.entry?.revision ?? null,
      };
    });
  }

  saveEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedRevision: number,
    expectedGeneration: string | null
  ): Promise<ReviewDraftHistoryEntry> {
    return this.runAuthorized(teamName, scopeKey, scopeToken, async (authorization) => {
      await authorization.assertCurrentReviewedFile(entry.filePath);
      return this.dependencies.entryMutations.saveEntry(teamName, scopeKey, scopeToken, {
        ...entry,
        expectedRevision,
        expectedGeneration,
      });
    });
  }

  clear(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath: string | null = null,
    expectedRevision: number | null = null,
    expectedGeneration: string | null = null
  ): Promise<void> {
    return this.runAuthorized(teamName, scopeKey, scopeToken, async (authorization) => {
      if (filePath === null) {
        await this.dependencies.entryMutations.clearUnreadableScope(teamName, scopeKey, scopeToken);
        return;
      }
      if (expectedRevision === null) {
        throw new Error('Clearing review draft history requires an exact revision');
      }
      await authorization.assertCurrentReviewedFile(filePath);
      await this.dependencies.entryMutations.clearEntry(
        teamName,
        scopeKey,
        scopeToken,
        filePath,
        expectedRevision,
        expectedGeneration
      );
    });
  }
}
