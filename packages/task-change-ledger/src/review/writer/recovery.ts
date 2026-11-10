import { assertReviewRecoveryContent } from '../apply/reviewReplayEvidence.js';
import type { ReviewWriterContext } from './ports.js';
import { ReviewMutationJournalStore } from '../storage/ReviewMutationJournalStore.js';
import {
  assertReviewDecisionShape,
  assertSnippetShapes,
  parseReviewFileScope,
  parseDecisionPersistenceScope,
  validateSnippetPaths,
} from './validation.js';
import type {
  ReviewDecisionPersistenceScope,
  RetryReviewMutationRecoveryResult,
  RetryReviewMutationRecoveryRequest,
  ReviewMutationDiskPostimage,
} from '../../contracts.js';
import {
  applyDirectReviewMutationDisk,
  buildJournalRecoveryDiskPostimages,
  normalizeDirectReviewMutationSteps,
  classifyDirectReviewMutationStep,
  buildDirectReviewMutationDiskPostimages,
} from './directDisk.js';
import {
  commitReviewMutationDecisions,
  applyJournalDecisionBatchDisk,
  isDurableReviewEqual,
} from './decisionBatch.js';
import {
  resolveReviewPathAuthorization,
  validateAuthorizedReviewFilePath,
} from './scopeAuthorization.js';
import { MAX_REVIEW_MUTATION_STEPS } from './limits.js';
import { withReviewDecisionPersistenceLock } from './persistenceLock.js';

import * as path from 'path';

// --- Decision Persistence Handlers ---
export function assertRecoverableJournalContent(
  env: Pick<ReviewWriterContext, 'assertActive' | 'decisions'>,
  record: Awaited<ReturnType<ReviewMutationJournalStore['list']>>[number]
): void {
  if (
    record.persistedState &&
    (!Number.isSafeInteger(record.expectedDecisionRevision) || record.expectedDecisionRevision! < 0)
  ) {
    throw new Error('Review mutation recovery revision is unavailable');
  }
  if (record.diskSteps?.length) {
    if (!record.persistedState) {
      throw new Error('Review mutation recovery state is unavailable');
    }
    env.assertActive();
    env.decisions.assertValidSnapshot(record.persistedState);
    return;
  }
  if (
    (record.kind === 'undo' ||
      record.kind === 'redo' ||
      record.kind === 'reload-external' ||
      record.kind === 'restore-history') &&
    record.decisions.length === 0 &&
    record.fileContents.length === 0 &&
    record.persistedState
  ) {
    env.assertActive();
    env.decisions.assertValidSnapshot(record.persistedState);
    return;
  }
  if (record.decisions.length === 0 || record.decisions.length !== record.fileContents.length) {
    throw new Error('Invalid review mutation recovery batch');
  }
  for (const [index, decision] of record.decisions.entries()) {
    const fileContent = record.fileContents[index];
    assertReviewDecisionShape(decision);
    assertSnippetShapes(fileContent?.snippets);
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

export async function recoverReviewMutationJournal(
  env: Pick<
    ReviewWriterContext,
    | 'applier'
    | 'assertActive'
    | 'authorization'
    | 'changes'
    | 'content'
    | 'coordinator'
    | 'decisions'
    | 'journal'
    | 'logger'
  >,
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope
): Promise<void> {
  const records = await (env.assertActive(), env.journal.list(teamName, persistenceScope));
  for (const record of records) {
    if (record.blocked) {
      throw new Error(
        'A previous review update did not finish safely. Retry recovery or discard saved review state.'
      );
    }
    assertRecoverableJournalContent(env, record);
    const parsedScope = parseReviewFileScope(record.reviewScope);
    if (!parsedScope.taskId && !parsedScope.memberName) {
      throw new Error('Review mutation recovery requires taskId or memberName');
    }
    const scope = parsedScope;
    if (scope.teamName !== teamName) {
      throw new Error('Review mutation recovery scope mismatch');
    }
    parseDecisionPersistenceScope(persistenceScope, scope);
    if (
      !record.diskSteps?.length &&
      record.decisions.length === 0 &&
      (record.kind === 'undo' ||
        record.kind === 'redo' ||
        record.kind === 'reload-external' ||
        record.kind === 'restore-history')
    ) {
      await (env.assertActive(),
      env.coordinator.resume(record, {
        applyDisk: applyDirectReviewMutationDisk.bind(null, env),
        commitDecisions: commitReviewMutationDecisions.bind(null, env),
      }));
      continue;
    }
    if (record.diskSteps?.length) {
      const { authorization } = await resolveReviewPathAuthorization(env, scope, {
        requireIdentity: true,
      });
      for (const step of record.diskSteps) {
        const filePath = await validateAuthorizedReviewFilePath(authorization, step.filePath, {
          requireReviewedFile: false,
          rejectHardlinks: true,
        });
        if (filePath !== path.resolve(path.normalize(step.filePath)))
          throw new Error('Review mutation recovery file mismatch');
        if (step.authoritativeContent) {
          await validateSnippetPaths(authorization, step.authoritativeContent.snippets, {
            requireReviewedFile: false,
            rejectHardlinks: true,
          });
        }
      }
      await (env.assertActive(),
      env.coordinator.resume(record, {
        applyDisk: applyDirectReviewMutationDisk.bind(null, env),
        commitDecisions: commitReviewMutationDecisions.bind(null, env),
      }));
      continue;
    }
    await (env.assertActive(),
    env.coordinator.resume(record, {
      applyDisk: async (current) => {
        const { authorization } = await resolveReviewPathAuthorization(env, scope, {
          requireIdentity: true,
        });
        for (const [index, savedDecision] of current.decisions.entries()) {
          const savedContent = current.fileContents[index];
          const filePath = await validateAuthorizedReviewFilePath(
            authorization,
            savedDecision.filePath,
            { requireReviewedFile: false, rejectHardlinks: true }
          );
          await validateSnippetPaths(authorization, savedContent.snippets, {
            requireReviewedFile: false,
            rejectHardlinks: true,
          });
          if (filePath !== path.resolve(path.normalize(savedContent.filePath))) {
            throw new Error('Review mutation recovery file mismatch');
          }
          assertReviewRecoveryContent(savedDecision, savedContent, current.decisionStatuses?.[index] === 'applied');
        }
        return applyJournalDecisionBatchDisk(env, current);
      },
      commitDecisions: commitReviewMutationDecisions.bind(null, env),
    }));
  }
}

export async function handleRetryReviewMutationRecovery(
  env: Pick<
    ReviewWriterContext,
    | 'applier'
    | 'assertActive'
    | 'authorization'
    | 'changes'
    | 'content'
    | 'coordinator'
    | 'decisions'
    | 'journal'
    | 'locks'
    | 'logger'
    | 'queues'
  >,
  requestValue: unknown
): Promise<RetryReviewMutationRecoveryResult> {
  return (async () => {
    if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
      throw new Error('Invalid review mutation recovery request');
    }
    const request = requestValue as RetryReviewMutationRecoveryRequest;
    const { scope, authorization } = await resolveReviewPathAuthorization(env, request.scope, {
      requireIdentity: true,
    });
    const persistenceScope = parseDecisionPersistenceScope(request.decisionPersistenceScope, scope);
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
      env.assertActive();
      env.decisions.assertValidSnapshot(expectedRestore.persistedState);
    }
    return withReviewDecisionPersistenceLock(env, scope.teamName, persistenceScope, async () => {
      const records = await (env.assertActive(),
      env.journal.list(scope.teamName, persistenceScope));
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
        const committed = await (env.assertActive(),
        env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
        return {
          decisionRevision: committed?.revision ?? 0,
          recoveredMutation: false,
          recoveredRestoreHistory: false,
          differentMutationPending: true,
          persistedState: committed
            ? {
                hunkDecisions: committed.hunkDecisions,
                fileDecisions: committed.fileDecisions,
                hunkContextHashesByFile: committed.hunkContextHashesByFile,
                reviewActionHistory: committed.reviewActionHistory,
                reviewRedoHistory: committed.reviewRedoHistory,
              }
            : null,
          expectedRestoreCompleted: false,
          diskPostimages: [],
          retried: false,
        };
      }
      let diskPostimages: ReviewMutationDiskPostimage[] = [];
      let postimagesResolved = false;
      if (record) {
        try {
          diskPostimages = await buildJournalRecoveryDiskPostimages(env, record);
          postimagesResolved = true;
        } catch (error) {
          env.logger.warn('Unable to resolve interrupted review mutation postimages:', error);
        }
      }
      const retried = Boolean(record?.blocked);
      if (record?.blocked) await (env.assertActive(), env.journal.unblock(record));
      await recoverReviewMutationJournal(env, scope.teamName, persistenceScope);
      const committed = await (env.assertActive(),
      env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
      const persistedState = committed
        ? {
            hunkDecisions: committed.hunkDecisions,
            fileDecisions: committed.fileDecisions,
            hunkContextHashesByFile: committed.hunkContextHashesByFile,
            reviewActionHistory: committed.reviewActionHistory,
            reviewRedoHistory: committed.reviewRedoHistory,
          }
        : null;
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
          const normalizedSteps = await normalizeDirectReviewMutationSteps(
            env,
            expectedRestore.diskSteps,
            scope,
            authorization,
            expectedRestore.persistedState
          );
          const postimageStates = await Promise.all(
            normalizedSteps.map((step) => classifyDirectReviewMutationStep(env, step))
          );
          if (postimageStates.some((state) => state !== 'after' && state !== 'both')) {
            throw new Error('Completed Restore disk postimage is no longer present');
          }
          diskPostimages = await buildDirectReviewMutationDiskPostimages(env, normalizedSteps);
          postimagesResolved = true;
        } catch (error) {
          env.logger.warn('Unable to verify completed Restore postimages:', error);
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
  })();
}
