import type { ReviewMutationJournalRecord } from '../../core/application/ReviewMutationJournalTypes';
import {
  isDecisionlessReviewRecoveryKind,
  parseReviewHistoryRestoreTarget,
} from '../../core/domain/reviewHistoryRestoreTarget';
import { buildReviewHistoryRestorePlan } from '../../core/domain/reviewHistoryDecisions';
import { buildReviewHistoryRestoreDiskSteps } from '../../core/domain/reviewHistoryDiskSteps';
import { isDurableReviewEqual } from '../../core/domain/durableReviewValue';
import type {
  LoadedReviewMutationDecisions,
  ReviewMutationPathAuthorization,
  ReviewMutationRecoveryDependencies,
} from './ReviewMutationRecoveryPorts';
import type {
  ExecuteReviewMutationRequest,
  ExecuteReviewMutationResult,
  RestoreReviewHistoryRequest,
  RestoreReviewHistoryResult,
  RetryReviewMutationRecoveryRequest,
  RetryReviewMutationRecoveryResult,
  ReviewDecisionPersistenceScope,
  ReviewMutationDiskPostimage,
  ReviewPersistedStateSnapshot,
} from '@shared/types/review';

export const MAX_REVIEW_MUTATION_STEPS = 2_000;

export class ReviewMutationRecoveryApplication {
  constructor(private readonly dependencies: ReviewMutationRecoveryDependencies) {}

  async execute(request: ExecuteReviewMutationRequest): Promise<ExecuteReviewMutationResult> {
    const { scope, authorization } = await this.dependencies.scope.resolve(request.scope, {
      requireIdentity: true,
    });
    const persistenceScope = this.dependencies.scope.parsePersistenceScope(
      request.decisionPersistenceScope,
      scope
    );
    if (!persistenceScope) throw new Error('Review mutation requires an exact decision scope');
    this.dependencies.decisions.assertValidSnapshot(request.persistedState);
    if (
      !Number.isSafeInteger(request.expectedDecisionRevision) ||
      request.expectedDecisionRevision < 0
    ) {
      throw new Error('Review mutation requires an exact decision revision');
    }

    return this.dependencies.decisions.withLock(scope.teamName, persistenceScope, async () => {
      await this.recoverPending(scope.teamName, persistenceScope);
      await this.dependencies.decisions.assertCurrentRevision(
        scope.teamName,
        persistenceScope,
        request.expectedDecisionRevision
      );
      const current = await this.dependencies.decisions.load(scope.teamName, persistenceScope);
      this.dependencies.decisions.assertExactTransition(request, current, authorization);
      const persistedState = await this.dependencies.decisions.bindAuthoritativeForwardMutation(
        request,
        current,
        scope,
        authorization
      );
      const diskSteps = await this.dependencies.disk.normalize(
        request.diskSteps,
        scope,
        authorization
      );
      const diskPostimages = await this.dependencies.disk.buildPostimages(diskSteps);
      await this.dependencies.disk.assertPreimages(diskSteps);
      await this.dependencies.coordinator.execute(
        {
          teamName: scope.teamName,
          persistenceScope,
          reviewScope: scope,
          kind: request.kind,
          decisions: [],
          fileContents: [],
          diskSteps,
          persistedState,
          expectedDecisionRevision: request.expectedDecisionRevision,
        },
        {
          applyDisk: (record) => this.dependencies.disk.apply(record),
          commitDecisions: (record) => this.dependencies.decisions.commit(record),
        }
      );
      const committed = await this.dependencies.decisions.load(scope.teamName, persistenceScope);
      return {
        decisionRevision: committed?.revision ?? request.expectedDecisionRevision,
        diskPostimages,
        ...(request.kind === 'restore' || request.kind === 'rename'
          ? { committedReviewAction: committed?.reviewActionHistory.at(-1) }
          : {}),
      };
    });
  }

  async restoreHistory(request: RestoreReviewHistoryRequest): Promise<RestoreReviewHistoryResult> {
    const target = parseReviewHistoryRestoreTarget(request.target);
    if (
      !Number.isSafeInteger(request.expectedDecisionRevision) ||
      request.expectedDecisionRevision < 0
    ) {
      throw new Error('Review history restore requires an exact decision revision');
    }
    const { scope, authorization } = await this.dependencies.scope.resolve(request.scope, {
      requireIdentity: true,
    });
    const persistenceScope = this.dependencies.scope.parsePersistenceScope(
      request.decisionPersistenceScope,
      scope
    );
    if (!persistenceScope) {
      throw new Error('Review history restore requires an exact decision scope');
    }

    return this.dependencies.decisions.withLock(scope.teamName, persistenceScope, async () => {
      await this.recoverPending(scope.teamName, persistenceScope);
      await this.dependencies.decisions.assertCurrentRevision(
        scope.teamName,
        persistenceScope,
        request.expectedDecisionRevision
      );
      const current = await this.dependencies.decisions.load(scope.teamName, persistenceScope);
      if (!current) throw new Error('Review history is unavailable');
      const currentState = this.toPersistedState(current);
      const plan = buildReviewHistoryRestorePlan(currentState, target, (filePath) =>
        this.dependencies.scope.getAuthoritativeFile(authorization, filePath)
      );
      if (plan.actionCount === 0) {
        return {
          decisionRevision: current.revision,
          persistedState: currentState,
          direction: 'none',
          actionCount: 0,
          diskPostimages: [],
        };
      }
      if (plan.direction === 'none') {
        throw new Error('Review history restore plan is inconsistent');
      }
      const direction = plan.direction;
      for (const action of plan.orderedActions) {
        this.dependencies.decisions.assertAuthoritativelyBoundAction(action);
      }
      this.dependencies.decisions.assertValidSnapshot(plan.persistedState);
      const plannedDiskSteps = buildReviewHistoryRestoreDiskSteps(
        plan.orderedActions.map((action) => ({ direction, action }))
      );
      const diskSteps = await this.dependencies.disk.normalize(
        plannedDiskSteps,
        scope,
        authorization
      );
      const diskPostimages = await this.dependencies.disk.buildPostimages(diskSteps);
      await this.dependencies.disk.assertPreimages(diskSteps);
      await this.dependencies.coordinator.execute(
        {
          teamName: scope.teamName,
          persistenceScope,
          reviewScope: scope,
          kind: 'restore-history',
          decisions: [],
          fileContents: [],
          diskSteps,
          persistedState: plan.persistedState,
          expectedDecisionRevision: request.expectedDecisionRevision,
        },
        {
          applyDisk: (record) => this.dependencies.disk.apply(record),
          commitDecisions: (record) => this.dependencies.decisions.commit(record),
        }
      );
      const committed = await this.dependencies.decisions.load(scope.teamName, persistenceScope);
      if (!committed) throw new Error('Restored review history was not committed');
      return {
        decisionRevision: committed.revision,
        persistedState: this.toPersistedState(committed),
        direction,
        actionCount: plan.actionCount,
        diskPostimages,
      };
    });
  }

  async retryRecovery(
    request: RetryReviewMutationRecoveryRequest
  ): Promise<RetryReviewMutationRecoveryResult> {
    const { scope, authorization } = await this.dependencies.scope.resolve(request.scope, {
      requireIdentity: true,
    });
    const persistenceScope = this.dependencies.scope.parsePersistenceScope(
      request.decisionPersistenceScope,
      scope
    );
    if (!persistenceScope) {
      throw new Error('Review mutation recovery requires an exact decision scope');
    }
    const expectedRestore = request.expectedRestore;
    if (expectedRestore) {
      if (
        !Number.isSafeInteger(expectedRestore.expectedDecisionRevision) ||
        expectedRestore.expectedDecisionRevision < 0 ||
        !Array.isArray(expectedRestore.diskSteps) ||
        expectedRestore.diskSteps.length > MAX_REVIEW_MUTATION_STEPS
      ) {
        throw new Error('Invalid expected review history Restore recovery');
      }
      this.dependencies.decisions.assertValidSnapshot(expectedRestore.persistedState);
    }

    return this.dependencies.decisions.withLock(scope.teamName, persistenceScope, async () => {
      const records = await this.dependencies.journal.list(scope.teamName, persistenceScope);
      if (records.length > 1) {
        throw new Error('Multiple review mutations require manual recovery');
      }
      const record = records[0];
      const recordDiskSteps = (record?.diskSteps ?? []).map(
        ({ status: _status, authoritativeContent: _authoritativeContent, ...step }) => step
      );
      const matchesExpectedRestore =
        !record ||
        !expectedRestore ||
        (record.kind === 'restore-history' &&
          record.expectedDecisionRevision === expectedRestore.expectedDecisionRevision &&
          isDurableReviewEqual(record.persistedState, expectedRestore.persistedState) &&
          isDurableReviewEqual(recordDiskSteps, expectedRestore.diskSteps));
      if (!matchesExpectedRestore) {
        const committed = await this.dependencies.decisions.load(scope.teamName, persistenceScope);
        return {
          decisionRevision: committed?.revision ?? 0,
          recoveredMutation: false,
          recoveredRestoreHistory: false,
          differentMutationPending: true,
          persistedState: committed ? this.toPersistedState(committed) : null,
          expectedRestoreCompleted: false,
          diskPostimages: [],
          retried: false,
        };
      }

      let diskPostimages: ReviewMutationDiskPostimage[] = [];
      let postimagesResolved = false;
      if (record) {
        try {
          diskPostimages = await this.dependencies.disk.buildRecoveryPostimages(record);
          postimagesResolved = true;
        } catch (error) {
          this.dependencies.logger.warn(
            'Unable to resolve interrupted review mutation postimages:',
            error
          );
        }
      }
      const retried = Boolean(record?.blocked);
      if (record?.blocked) await this.dependencies.journal.unblock(record);
      await this.recoverPending(scope.teamName, persistenceScope);
      const committed = await this.dependencies.decisions.load(scope.teamName, persistenceScope);
      const persistedState = committed ? this.toPersistedState(committed) : null;
      const expectedRestoreStateCompleted = Boolean(
        expectedRestore &&
        committed &&
        committed.revision === expectedRestore.expectedDecisionRevision + 1 &&
        persistedState &&
        isDurableReviewEqual(persistedState, expectedRestore.persistedState) &&
        (!record || record.kind === 'restore-history')
      );
      if (expectedRestoreStateCompleted && !record && expectedRestore) {
        try {
          const normalizedSteps = await this.dependencies.disk.normalize(
            expectedRestore.diskSteps,
            scope,
            authorization
          );
          const postimageStates = await Promise.all(
            normalizedSteps.map((step) => this.dependencies.disk.classify(step))
          );
          if (postimageStates.some((state) => state !== 'after' && state !== 'both')) {
            throw new Error('Completed Restore disk postimage is no longer present');
          }
          diskPostimages = await this.dependencies.disk.buildPostimages(normalizedSteps);
          postimagesResolved = true;
        } catch (error) {
          this.dependencies.logger.warn('Unable to verify completed Restore postimages:', error);
          diskPostimages = [];
        }
      }
      const expectedRestoreCompleted = Boolean(
        expectedRestoreStateCompleted &&
        expectedRestore &&
        (expectedRestore.diskSteps.length === 0 || postimagesResolved)
      );
      return {
        decisionRevision: committed?.revision ?? 0,
        recoveredMutation: Boolean(record),
        recoveredRestoreHistory: record?.kind === 'restore-history',
        differentMutationPending: false,
        persistedState,
        expectedRestoreCompleted,
        diskPostimages:
          expectedRestoreCompleted || (Boolean(record) && postimagesResolved) ? diskPostimages : [],
        retried,
      };
    });
  }

  async recoverPending(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<void> {
    const records = await this.dependencies.journal.list(teamName, persistenceScope);
    for (const record of records) {
      if (record.blocked) {
        throw new Error(
          'A previous review update did not finish safely. Retry recovery or discard saved review state.'
        );
      }
      this.assertRecoverableJournalContent(record);
      const scope = this.dependencies.scope.parse(record.reviewScope);
      if (!scope.taskId && !scope.memberName) {
        throw new Error('Review mutation recovery requires taskId or memberName');
      }
      if (scope.teamName !== teamName) {
        throw new Error('Review mutation recovery scope mismatch');
      }
      this.dependencies.scope.parsePersistenceScope(persistenceScope, scope);

      if (
        !record.diskSteps?.length &&
        record.decisions.length === 0 &&
        isDecisionlessReviewRecoveryKind(record.kind)
      ) {
        await this.resumeDirectRecord(record);
        continue;
      }
      if (record.diskSteps?.length) {
        const { authorization } = await this.dependencies.scope.resolve(scope, {
          requireIdentity: true,
        });
        await this.assertAuthorizedRecoverySteps(record, authorization);
        await this.resumeDirectRecord(record);
        continue;
      }
      await this.dependencies.coordinator.resume(record, {
        applyDisk: async (current) => {
          const { authorization } = await this.dependencies.scope.resolve(scope, {
            requireIdentity: true,
          });
          for (const [index, savedDecision] of current.decisions.entries()) {
            const savedContent = current.fileContents[index];
            const filePath = await this.dependencies.scope.validateFilePath(
              authorization,
              savedDecision.filePath,
              { requireReviewedFile: false, rejectHardlinks: true }
            );
            await this.dependencies.scope.validateSnippets(authorization, savedContent.snippets, {
              requireReviewedFile: false,
              rejectHardlinks: true,
            });
            if (
              filePath !== this.dependencies.scope.normalizeFilesystemPath(savedContent.filePath)
            ) {
              throw new Error('Review mutation recovery file mismatch');
            }
          }
          return this.dependencies.applyDecisionBatchDisk(current);
        },
        commitDecisions: (current) => this.dependencies.decisions.commit(current),
      });
    }
  }

  private async assertAuthorizedRecoverySteps(
    record: ReviewMutationJournalRecord,
    authorization: ReviewMutationPathAuthorization
  ): Promise<void> {
    for (const step of record.diskSteps ?? []) {
      const filePath = await this.dependencies.scope.validateFilePath(
        authorization,
        step.filePath,
        { requireReviewedFile: false, rejectHardlinks: true }
      );
      if (filePath !== this.dependencies.scope.normalizeFilesystemPath(step.filePath)) {
        throw new Error('Review mutation recovery file mismatch');
      }
      if (step.authoritativeContent) {
        await this.dependencies.scope.validateSnippets(
          authorization,
          step.authoritativeContent.snippets,
          { requireReviewedFile: false, rejectHardlinks: true }
        );
      }
    }
  }

  private async resumeDirectRecord(record: ReviewMutationJournalRecord): Promise<void> {
    await this.dependencies.coordinator.resume(record, {
      applyDisk: (current) => this.dependencies.disk.apply(current),
      commitDecisions: (current) => this.dependencies.decisions.commit(current),
    });
  }

  private assertRecoverableJournalContent(record: ReviewMutationJournalRecord): void {
    if (
      record.persistedState &&
      (!Number.isSafeInteger(record.expectedDecisionRevision) ||
        record.expectedDecisionRevision! < 0)
    ) {
      throw new Error('Review mutation recovery revision is unavailable');
    }
    if (record.diskSteps?.length) {
      if (!record.persistedState) {
        throw new Error('Review mutation recovery state is unavailable');
      }
      this.dependencies.decisions.assertValidSnapshot(record.persistedState);
      return;
    }
    if (
      isDecisionlessReviewRecoveryKind(record.kind) &&
      record.decisions.length === 0 &&
      record.fileContents.length === 0 &&
      record.persistedState
    ) {
      this.dependencies.decisions.assertValidSnapshot(record.persistedState);
      return;
    }
    if (record.decisions.length === 0 || record.decisions.length !== record.fileContents.length) {
      throw new Error('Invalid review mutation recovery batch');
    }
    for (const [index, decision] of record.decisions.entries()) {
      const fileContent = record.fileContents[index];
      this.dependencies.scope.assertDecisionShape(decision);
      this.dependencies.scope.assertSnippetShapes(fileContent?.snippets);
      if (
        !fileContent ||
        fileContent.filePath !== decision.filePath ||
        (fileContent.originalFullContent !== null &&
          typeof fileContent.originalFullContent !== 'string') ||
        (fileContent.modifiedFullContent !== null &&
          typeof fileContent.modifiedFullContent !== 'string') ||
        typeof fileContent.isNewFile !== 'boolean'
      ) {
        throw new Error('Invalid review mutation recovery content');
      }
    }
  }

  private toPersistedState(committed: LoadedReviewMutationDecisions): ReviewPersistedStateSnapshot {
    return {
      hunkDecisions: committed.hunkDecisions,
      fileDecisions: committed.fileDecisions,
      hunkContextHashesByFile: committed.hunkContextHashesByFile,
      reviewActionHistory: committed.reviewActionHistory,
      reviewRedoHistory: committed.reviewRedoHistory,
    };
  }
}
