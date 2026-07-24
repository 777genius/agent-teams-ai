import { ReviewMutationApplyResultError } from '../../core/application/ReviewMutationApplyResultError';
import { mergeReviewMutationDiskPostimages } from '../../core/domain/reviewDecisionBatch';
import {
  assertCurrentReviewDecisionRevision,
  assertExactApplyReviewHistoryTransition,
} from '../../core/domain/reviewDecisionCommandPolicy';

import type { ReviewDecisionCommandDependencies } from './ReviewDecisionCommandPorts';
import type { ReviewMutationPathAuthorization } from './ReviewMutationRecoveryPorts';
import type {
  ApplyReviewRequest,
  ApplyReviewResult,
  ConflictCheckResult,
  FileChangeWithContent,
  FileReviewDecision,
  RejectResult,
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
  ReviewMutationDiskPostimage,
  ReviewPersistedStateSnapshot,
  SnippetDiff,
} from '@shared/types/review';

interface DisplayedReviewSnapshot {
  teamName: string;
  filePath: string;
  snippetFingerprint: string;
  content: FileChangeWithContent;
  expiresAt: number;
}

const REVIEW_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const MAX_DISPLAYED_REVIEW_SNAPSHOTS = 2_000;

export class ReviewDecisionCommandApplication {
  private readonly displayedReviewSnapshots = new Map<string, DisplayedReviewSnapshot>();

  constructor(private readonly dependencies: ReviewDecisionCommandDependencies) {}

  registerDisplayedReviewSnapshot(
    teamName: string,
    filePath: string,
    snippets: SnippetDiff[],
    content: FileChangeWithContent
  ): FileChangeWithContent {
    const now = this.dependencies.snapshots.now();
    for (const [token, snapshot] of this.displayedReviewSnapshots) {
      if (snapshot.expiresAt <= now) this.displayedReviewSnapshots.delete(token);
    }
    while (this.displayedReviewSnapshots.size >= MAX_DISPLAYED_REVIEW_SNAPSHOTS) {
      const oldestToken = this.displayedReviewSnapshots.keys().next().value;
      if (!oldestToken) break;
      this.displayedReviewSnapshots.delete(oldestToken);
    }

    const token = this.dependencies.snapshots.createToken();
    const snapshotContent = { ...content, reviewSnapshotToken: token };
    this.displayedReviewSnapshots.set(token, {
      teamName,
      filePath: this.dependencies.scope.normalizeIdentityPath(filePath),
      snippetFingerprint: this.dependencies.snapshots.fingerprintSnippets(snippets),
      content: snapshotContent,
      expiresAt: now + REVIEW_SNAPSHOT_TTL_MS,
    });
    return snapshotContent;
  }

  async checkConflict(
    scopeValue: unknown,
    filePathValue: unknown,
    expectedModified: string
  ): Promise<ConflictCheckResult> {
    const { authorization } = await this.dependencies.scope.resolve(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await this.dependencies.scope.validateFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    return this.dependencies.applier.checkConflict(filePath, expectedModified);
  }

  async rejectHunks(
    scopeValue: unknown,
    filePathValue: unknown,
    hunkIndices: number[]
  ): Promise<RejectResult> {
    const { scope, authorization } = await this.dependencies.scope.resolve(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await this.dependencies.scope.validateFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await this.requireAuthoritativeContents(
      scope,
      authorization,
      filePath
    );
    return this.dependencies.applier.rejectHunks(
      scope.teamName,
      filePath,
      authoritativeContent.originalFullContent,
      authoritativeContent.modifiedFullContent,
      hunkIndices,
      authoritativeContent.snippets
    );
  }

  async rejectFile(scopeValue: unknown, filePathValue: unknown): Promise<RejectResult> {
    const { scope, authorization } = await this.dependencies.scope.resolve(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await this.dependencies.scope.validateFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await this.requireAuthoritativeContents(
      scope,
      authorization,
      filePath
    );
    return this.dependencies.applier.rejectFile(
      scope.teamName,
      filePath,
      authoritativeContent.originalFullContent,
      authoritativeContent.modifiedFullContent
    );
  }

  previewReject(
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Promise<{ preview: string; hasConflicts: boolean }> {
    return this.dependencies.applier.previewReject(
      filePath,
      original,
      modified,
      hunkIndices,
      snippets
    );
  }

  async applyDecisions(request: ApplyReviewRequest): Promise<ApplyReviewResult> {
    const { scope, authorization } = await this.dependencies.scope.resolve(request, {
      requireIdentity: true,
    });
    const persistenceScope = this.dependencies.scope.parsePersistenceScope(
      request.decisionPersistenceScope,
      scope
    );
    const validatedDecisions: FileReviewDecision[] = [];
    const fileContents = new Map<string, FileChangeWithContent>();
    const decisionPaths = new Set<string>();
    const decisionReviewKeys = new Set<string>();
    for (const decision of request.decisions) {
      this.dependencies.scope.assertDecisionShape(decision);
      const filePath = await this.dependencies.scope.validateFilePath(
        authorization,
        decision.filePath,
        { requireReviewedFile: true, rejectHardlinks: true }
      );
      const authoritativeFile = this.dependencies.scope.getAuthoritativeFile(
        authorization,
        filePath
      );
      const authoritativeReviewKey = authoritativeFile.changeKey ?? authoritativeFile.filePath;
      const normalizedDecisionPath = this.dependencies.scope.normalizeIdentityPath(filePath);
      if (
        decisionPaths.has(normalizedDecisionPath) ||
        decisionReviewKeys.has(authoritativeReviewKey)
      ) {
        throw new Error('Duplicate reviewed file in Apply decisions');
      }
      decisionPaths.add(normalizedDecisionPath);
      decisionReviewKeys.add(authoritativeReviewKey);
      if (persistenceScope && decision.reviewKey !== authoritativeReviewKey) {
        throw new Error('Durable reviewKey does not match the authoritative review identity');
      }
      this.dependencies.scope.assertSnippetShapes(authoritativeFile.snippets);
      await this.dependencies.scope.validateSnippets(authorization, authoritativeFile.snippets, {
        requireReviewedFile: true,
        rejectHardlinks: true,
      });
      const hasLedgerSnapshot = authoritativeFile.snippets.some(
        (snippet) => !!snippet.ledger && !snippet.isError
      );
      fileContents.set(
        filePath,
        hasLedgerSnapshot
          ? await this.dependencies.scope.resolveAuthoritativeContent(
              scope,
              authorization,
              filePath
            )
          : this.resolveDisplayedReviewSnapshot(
              decision.contentSnapshotToken,
              scope.teamName,
              filePath,
              authoritativeFile.snippets
            )
      );
      validatedDecisions.push({
        filePath,
        ...(decision.reviewKey ? { reviewKey: decision.reviewKey } : {}),
        fileDecision: decision.fileDecision,
        hunkDecisions: decision.hunkDecisions,
        ...(decision.hunkContextHashes ? { hunkContextHashes: decision.hunkContextHashes } : {}),
      });
    }
    const validatedRequest: ApplyReviewRequest = {
      teamName: scope.teamName,
      ...(scope.taskId ? { taskId: scope.taskId } : {}),
      ...(authorization.resolutionMemberName
        ? { memberName: authorization.resolutionMemberName }
        : {}),
      ...(persistenceScope ? { decisionPersistenceScope: persistenceScope } : {}),
      decisions: validatedDecisions,
    };

    let result: ApplyReviewResult;
    if (!persistenceScope) {
      result = await this.dependencies.applier.applyReviewDecisions(validatedRequest, fileContents);
    } else {
      if (validatedDecisions.some((decision) => !decision.reviewKey)) {
        throw new Error('Durable review mutation requires a stable reviewKey');
      }
      if (!request.persistedState) {
        throw new Error('Durable review mutation requires an exact post-operation state');
      }
      if (
        !Number.isSafeInteger(request.expectedDecisionRevision) ||
        request.expectedDecisionRevision! < 0
      ) {
        throw new Error('Durable review mutation requires an exact decision revision');
      }
      this.dependencies.persistence.assertValidSnapshot(request.persistedState);
      this.dependencies.batch.assertPersistedStateIncludesDecisions(
        request.persistedState,
        validatedDecisions
      );
      result = await this.applyDecisionsWithDurableJournal(
        scope,
        authorization,
        persistenceScope,
        validatedDecisions as (FileReviewDecision & { reviewKey: string })[],
        fileContents,
        request.persistedState,
        request.expectedDecisionRevision!
      );
    }

    try {
      for (const decision of validatedRequest.decisions) {
        this.dependencies.cache.invalidateFile(decision.filePath);
      }
    } catch (error) {
      this.dependencies.logger.debug('applyDecisions cache invalidation failed:', error);
    }
    return result;
  }

  private resolveDisplayedReviewSnapshot(
    token: string | undefined,
    teamName: string,
    filePath: string,
    authoritativeSnippets: SnippetDiff[]
  ): FileChangeWithContent {
    if (!token) {
      throw new Error('Displayed review snapshot is unavailable; reload Changes before rejecting.');
    }
    const snapshot = this.displayedReviewSnapshots.get(token);
    if (
      !snapshot ||
      snapshot.expiresAt <= this.dependencies.snapshots.now() ||
      snapshot.teamName !== teamName ||
      snapshot.filePath !== this.dependencies.scope.normalizeIdentityPath(filePath) ||
      snapshot.snippetFingerprint !==
        this.dependencies.snapshots.fingerprintSnippets(authoritativeSnippets)
    ) {
      this.displayedReviewSnapshots.delete(token);
      throw new Error('Displayed review snapshot is stale; reload Changes before rejecting.');
    }
    snapshot.expiresAt = this.dependencies.snapshots.now() + REVIEW_SNAPSHOT_TTL_MS;
    return {
      ...snapshot.content,
      filePath,
      snippets: authoritativeSnippets,
    };
  }

  private async requireAuthoritativeContents(
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization,
    filePath: string
  ): Promise<FileChangeWithContent & { originalFullContent: string; modifiedFullContent: string }> {
    const content = await this.dependencies.scope.resolveAuthoritativeContent(
      scope,
      authorization,
      filePath
    );
    if (content.originalFullContent === null || content.modifiedFullContent === null) {
      throw new Error('Authoritative review contents are unavailable');
    }
    return content as FileChangeWithContent & {
      originalFullContent: string;
      modifiedFullContent: string;
    };
  }

  private async applyDecisionsWithDurableJournal(
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization,
    persistenceScope: ReviewDecisionPersistenceScope,
    decisions: (FileReviewDecision & { reviewKey: string })[],
    fileContents: Map<string, FileChangeWithContent>,
    persistedState: ReviewPersistedStateSnapshot,
    expectedDecisionRevision: number
  ): Promise<ApplyReviewResult> {
    const normalizePath = (filePath: string): string =>
      this.dependencies.scope.normalizeIdentityPath(filePath);
    return this.dependencies.persistence.withLock(scope.teamName, persistenceScope, async () => {
      const diskPostimages = new Map<string, ReviewMutationDiskPostimage>();
      try {
        await this.dependencies.recovery.recoverPending(scope.teamName, persistenceScope);
        const current = await this.dependencies.persistence.load(scope.teamName, persistenceScope);
        assertCurrentReviewDecisionRevision(current, expectedDecisionRevision);
        assertExactApplyReviewHistoryTransition(persistedState, current, decisions, {
          resolveFile: (filePath) =>
            this.dependencies.scope.getAuthoritativeFile(authorization, filePath),
          normalizePath,
        });
        const boundPersistedState = await this.dependencies.history.bindNewHistorySnapshots(
          persistedState,
          current,
          scope,
          authorization
        );
        let result: ApplyReviewResult | null = null;
        await this.dependencies.coordinator.execute(
          {
            teamName: scope.teamName,
            persistenceScope,
            reviewScope: scope,
            kind: decisions.length > 1 ? 'bulk' : 'reject',
            decisions,
            fileContents: decisions.map((decision) => {
              const content = fileContents.get(decision.filePath);
              if (!content) throw new Error('Review mutation content is unavailable');
              return content;
            }),
            persistedState: boundPersistedState,
            expectedDecisionRevision,
          },
          {
            applyDisk: (record) =>
              this.dependencies.batch.applyDisk(
                record,
                (nextResult) => {
                  result = nextResult;
                },
                (postimages) =>
                  mergeReviewMutationDiskPostimages(diskPostimages, postimages, normalizePath)
              ),
            commitDecisions: (record) => this.dependencies.batch.commit(record),
          }
        );
        const committed = await this.dependencies.persistence.load(
          scope.teamName,
          persistenceScope
        );
        return {
          ...(result ?? { applied: 0, skipped: 0, conflicts: 0, errors: [] }),
          decisionRevision: committed?.revision ?? expectedDecisionRevision,
          committedReviewAction: committed?.reviewActionHistory.at(-1),
          diskPostimages: [...diskPostimages.values()],
        };
      } catch (error) {
        if (error instanceof ReviewMutationApplyResultError) {
          return { ...error.result, diskPostimages: [...diskPostimages.values()] };
        }
        throw error;
      }
    });
  }
}
