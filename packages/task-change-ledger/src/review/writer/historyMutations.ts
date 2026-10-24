import type { ReviewWriterContext } from './ports.js';
import type {
  ExecuteReviewMutationResult,
  ExecuteReviewMutationRequest,
  RestoreReviewHistoryRequest,
  RestoreReviewHistoryResult,
  ReviewPersistedStateSnapshot,
} from '../../contracts.js';
import { MAX_REVIEW_MUTATION_STEPS } from './limits.js';
import {
  resolveReviewPathAuthorization,
  getAuthoritativeReviewedFile,
} from './scopeAuthorization.js';
import { parseDecisionPersistenceScope } from './validation.js';
import { withReviewDecisionPersistenceLock } from './persistenceLock.js';
import { recoverReviewMutationJournal } from './recovery.js';
import {
  assertCurrentReviewDecisionRevision,
  commitReviewMutationDecisions,
} from './decisionBatch.js';
import {
  assertExactReviewHistoryTransition,
  assertAuthoritativeForwardReviewMutation,
} from './historyAdmission.js';
import {
  normalizeDirectReviewMutationSteps,
  buildDirectReviewMutationDiskPostimages,
  assertDirectReviewMutationPreimages,
  applyDirectReviewMutationDisk,
} from './directDisk.js';
import { buildReviewHistoryRestorePlan } from './reviewHistoryDecisions.js';
import { assertAuthoritativelyBoundReviewAction } from './historyBinding.js';
import { buildReviewHistoryRestoreDiskSteps } from './reviewHistoryDiskSteps.js';

export async function handleExecuteReviewMutation(
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
): Promise<ExecuteReviewMutationResult> {
  if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
    throw new Error('Invalid review mutation request');
  }
  const request = requestValue as ExecuteReviewMutationRequest;
  const allowsEmptyDiskMutation =
    request.kind === 'undo' || request.kind === 'redo' || request.kind === 'reload-external';
  if (
    (request.kind !== 'restore' &&
      request.kind !== 'rename' &&
      request.kind !== 'undo' &&
      request.kind !== 'redo' &&
      request.kind !== 'reload-external') ||
    !Array.isArray(request.diskSteps) ||
    (!allowsEmptyDiskMutation && request.diskSteps.length === 0) ||
    request.diskSteps.length > MAX_REVIEW_MUTATION_STEPS
  ) {
    throw new Error('Invalid review mutation request');
  }
  return (async () => {
    const { scope, authorization } = await resolveReviewPathAuthorization(env, request.scope, {
      requireIdentity: true,
    });
    const persistenceScope = parseDecisionPersistenceScope(request.decisionPersistenceScope, scope);
    if (!persistenceScope) throw new Error('Review mutation requires an exact decision scope');
    env.assertActive();
    env.decisions.assertValidSnapshot(request.persistedState);
    if (
      !Number.isSafeInteger(request.expectedDecisionRevision) ||
      request.expectedDecisionRevision < 0
    ) {
      throw new Error('Review mutation requires an exact decision revision');
    }
    return withReviewDecisionPersistenceLock(env, scope.teamName, persistenceScope, async () => {
      await recoverReviewMutationJournal(env, scope.teamName, persistenceScope);
      await assertCurrentReviewDecisionRevision(
        env,
        scope.teamName,
        persistenceScope,
        request.expectedDecisionRevision
      );
      const current = await (env.assertActive(),
      env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
      assertExactReviewHistoryTransition(request, current, authorization);
      const persistedState = await assertAuthoritativeForwardReviewMutation(
        env,
        request,
        current,
        scope,
        authorization
      );
      // Recovery can change disk state and invalidate authoritative review content.
      // Resolve this operation only after every older WAL record is complete.
      const diskSteps = await normalizeDirectReviewMutationSteps(
        env,
        request.diskSteps,
        scope,
        authorization
      );
      const diskPostimages = await buildDirectReviewMutationDiskPostimages(env, diskSteps);
      await assertDirectReviewMutationPreimages(env, diskSteps);
      await (env.assertActive(),
      env.coordinator.execute(
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
          applyDisk: applyDirectReviewMutationDisk.bind(null, env),
          commitDecisions: commitReviewMutationDecisions.bind(null, env),
        }
      ));
      const committed = await (env.assertActive(),
      env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
      return {
        decisionRevision: committed?.revision ?? request.expectedDecisionRevision,
        diskPostimages,
        ...(request.kind === 'restore' || request.kind === 'rename'
          ? { committedReviewAction: committed?.reviewActionHistory.at(-1) }
          : {}),
      };
    });
  })();
}

export function parseReviewHistoryRestoreTarget(
  value: unknown
): RestoreReviewHistoryRequest['target'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review history restore target');
  }
  const target = value as Record<string, unknown>;
  if (target.kind === 'start') return { kind: 'start' };
  if (
    target.kind !== 'after-action' ||
    (target.stack !== 'undo' && target.stack !== 'redo') ||
    typeof target.actionId !== 'string' ||
    target.actionId.length === 0 ||
    target.actionId.length > 256
  ) {
    throw new Error('Invalid review history restore target');
  }
  return { kind: 'after-action', stack: target.stack, actionId: target.actionId };
}

export async function handleRestoreReviewHistory(
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
): Promise<RestoreReviewHistoryResult> {
  return (async () => {
    if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
      throw new Error('Invalid review history restore request');
    }
    const request = requestValue as RestoreReviewHistoryRequest;
    const target = parseReviewHistoryRestoreTarget(request.target);
    if (
      !Number.isSafeInteger(request.expectedDecisionRevision) ||
      request.expectedDecisionRevision < 0
    ) {
      throw new Error('Review history restore requires an exact decision revision');
    }
    const { scope, authorization } = await resolveReviewPathAuthorization(env, request.scope, {
      requireIdentity: true,
    });
    const persistenceScope = parseDecisionPersistenceScope(request.decisionPersistenceScope, scope);
    if (!persistenceScope) {
      throw new Error('Review history restore requires an exact decision scope');
    }
    return withReviewDecisionPersistenceLock(env, scope.teamName, persistenceScope, async () => {
      await recoverReviewMutationJournal(env, scope.teamName, persistenceScope);
      await assertCurrentReviewDecisionRevision(
        env,
        scope.teamName,
        persistenceScope,
        request.expectedDecisionRevision
      );
      const current = await (env.assertActive(),
      env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
      if (!current) throw new Error('Review history is unavailable');
      const currentState: ReviewPersistedStateSnapshot = {
        hunkDecisions: current.hunkDecisions,
        fileDecisions: current.fileDecisions,
        hunkContextHashesByFile: current.hunkContextHashesByFile,
        reviewActionHistory: current.reviewActionHistory,
        reviewRedoHistory: current.reviewRedoHistory,
      };
      const plan = buildReviewHistoryRestorePlan(currentState, target, (filePath) =>
        getAuthoritativeReviewedFile(authorization, filePath)
      );
      if (plan.actionCount === 0) {
        return {
          decisionRevision: current.revision,
          persistedState: currentState,
          direction: 'none' as const,
          actionCount: 0,
          diskPostimages: [],
        };
      }
      if (plan.direction === 'none') {
        throw new Error('Review history restore plan is inconsistent');
      }
      const direction = plan.direction;
      for (const action of plan.orderedActions) assertAuthoritativelyBoundReviewAction(action);
      env.assertActive();
      env.decisions.assertValidSnapshot(plan.persistedState);
      const plannedDiskSteps = buildReviewHistoryRestoreDiskSteps(
        plan.orderedActions.map((action) => ({ direction, action }))
      );
      const diskSteps = await normalizeDirectReviewMutationSteps(
        env,
        plannedDiskSteps,
        scope,
        authorization
      );
      const diskPostimages = await buildDirectReviewMutationDiskPostimages(env, diskSteps);
      await assertDirectReviewMutationPreimages(env, diskSteps);
      await (env.assertActive(),
      env.coordinator.execute(
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
          applyDisk: applyDirectReviewMutationDisk.bind(null, env),
          commitDecisions: commitReviewMutationDecisions.bind(null, env),
        }
      ));
      const committed = await (env.assertActive(),
      env.decisions.load(scope.teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
      if (!committed) throw new Error('Restored review history was not committed');
      return {
        decisionRevision: committed.revision,
        persistedState: {
          hunkDecisions: committed.hunkDecisions,
          fileDecisions: committed.fileDecisions,
          hunkContextHashesByFile: committed.hunkContextHashesByFile,
          reviewActionHistory: committed.reviewActionHistory,
          reviewRedoHistory: committed.reviewRedoHistory,
        },
        direction,
        actionCount: plan.actionCount,
        diskPostimages,
      };
    });
  })();
}
