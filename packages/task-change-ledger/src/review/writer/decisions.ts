import type { ReviewWriterContext } from './ports.js';
import type {
  HunkDecision,
  ReviewUndoAction,
  ReviewRedoAction,
  ReviewDecisionConflictCandidateSummary,
  ReviewConflictResolution,
  SaveReviewDecisionsResult,
  ReviewPersistedStateSnapshot,
} from '../../contracts.js';
import { withReviewDecisionPersistenceLock } from './persistenceLock.js';
import { recoverReviewMutationJournal } from './recovery.js';
import {
  parseReviewScopeKey,
  assertReviewCandidateWithinAuthorization,
  hasNewReviewDiskHistory,
  isGenericReviewSnapshotContainedByCurrent,
  bindNewReviewHistorySnapshots,
  getNewReviewHistoryActions,
} from './historyBinding.js';
import { resolveReviewPathAuthorization } from './scopeAuthorization.js';
import { isDurableReviewEqual } from './decisionBatch.js';
import { assertExactGenericReviewHistoryTransition } from './historyAdmission.js';

export async function handleLoadDecisions(
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
  teamName: string,
  scopeKey: string,
  scopeToken: string | null = null
): Promise<{
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
  revision: number;
} | null> {
  return (async () => {
    if (!scopeToken) {
      return (env.assertActive(), env.decisions.load(teamName, scopeKey));
    }
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      await recoverReviewMutationJournal(env, teamName, persistenceScope);
      return (env.assertActive(), env.decisions.load(teamName, scopeKey, scopeToken));
    });
  })();
}

export async function handleLoadDecisionConflictCandidates(
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
  teamName: string,
  scopeKey: string,
  scopeToken: string
): Promise<ReviewDecisionConflictCandidateSummary[]> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const scope = parseReviewScopeKey(teamName, scopeKey);
      await resolveReviewPathAuthorization(env, scope, {
        requireIdentity: true,
      });
      await recoverReviewMutationJournal(env, teamName, persistenceScope);
      return (
        env.assertActive(),
        env.decisions.loadConflictCandidateSummaries(teamName, scopeKey, scopeToken)
      );
    });
  })();
}

export async function handleResolveDecisionConflictCandidate(
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
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  candidateId: string,
  resolution: ReviewConflictResolution,
  expectedCurrentRevision: number
): Promise<{
  revision: number;
}> {
  return (async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      const scope = parseReviewScopeKey(teamName, scopeKey);
      const { authorization } = await resolveReviewPathAuthorization(env, scope, {
        requireIdentity: true,
      });
      await recoverReviewMutationJournal(env, teamName, persistenceScope);
      if (resolution === 'recover-candidate') {
        const candidate = await (env.assertActive(),
        env.decisions.loadConflictCandidate(teamName, scopeKey, scopeToken, candidateId));
        if (candidate.origin !== 'current-snapshot') {
          throw new Error(
            'Recovery copy belongs to a different review snapshot; only discard is safe'
          );
        }
        assertReviewCandidateWithinAuthorization(candidate.state, authorization);
      }
      const revision = await (env.assertActive(),
      env.decisions.resolveConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId,
        resolution,
        expectedCurrentRevision
      ));
      return { revision };
    });
  })();
}

export async function handleSaveDecisions(
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
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  hunkDecisions: Record<string, HunkDecision>,
  fileDecisions: Record<string, HunkDecision>,
  hunkContextHashesByFile: Record<string, Record<number, string>> | null = null,
  reviewActionHistory: ReviewUndoAction[] = [],
  expectedRevision: number | undefined = undefined,
  reviewRedoHistory: ReviewRedoAction[] = []
): Promise<SaveReviewDecisionsResult> {
  return (async () => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 0) {
      throw new Error('Saving review decisions requires an exact decision revision');
    }
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      await recoverReviewMutationJournal(env, teamName, persistenceScope);
      const incomingState: ReviewPersistedStateSnapshot = {
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile: hunkContextHashesByFile ?? undefined,
        reviewActionHistory,
        reviewRedoHistory,
      };
      env.assertActive();
      env.decisions.assertValidSnapshot(incomingState);
      const current = await (env.assertActive(),
      env.decisions.load(teamName, scopeKey, scopeToken));
      if (hasNewReviewDiskHistory(incomingState, current)) {
        throw new Error('Disk review history must be committed atomically with its mutation');
      }
      const currentRevision = current?.revision ?? 0;
      if (expectedRevision !== currentRevision) {
        const currentSnapshot = current && {
          hunkDecisions: current.hunkDecisions,
          fileDecisions: current.fileDecisions,
          hunkContextHashesByFile: current.hunkContextHashesByFile,
          reviewActionHistory: current.reviewActionHistory,
          reviewRedoHistory: current.reviewRedoHistory,
        };
        if (currentSnapshot && isDurableReviewEqual(incomingState, currentSnapshot)) {
          return { revision: currentRevision };
        }
        const scope = parseReviewScopeKey(teamName, scopeKey);
        const { authorization } = await resolveReviewPathAuthorization(env, scope, {
          requireIdentity: true,
        });
        if (isGenericReviewSnapshotContainedByCurrent(incomingState, current, authorization)) {
          if (!current) {
            throw new Error('Canonical review state disappeared during retry reconciliation');
          }
          return {
            revision: currentRevision,
            reconciledState: {
              hunkDecisions: current.hunkDecisions,
              fileDecisions: current.fileDecisions,
              hunkContextHashesByFile: current.hunkContextHashesByFile,
              reviewActionHistory: current.reviewActionHistory,
              reviewRedoHistory: current.reviewRedoHistory,
            },
          };
        }
        assertReviewCandidateWithinAuthorization(incomingState, authorization);
        const boundCandidate = await bindNewReviewHistorySnapshots(
          env,
          incomingState,
          current,
          scope,
          authorization
        );
        // The store publishes the losing branch durably before reporting the stale CAS.
        // This call intentionally throws after the sidecar is committed.
        const revision = await (env.assertActive(),
        env.decisions.save(teamName, scopeKey, {
          scopeToken,
          ...boundCandidate,
          expectedRevision: expectedRevision!,
        }));
        return { revision };
      }
      const newActions = getNewReviewHistoryActions(incomingState, current);
      if (newActions.length > 0) {
        const scope = parseReviewScopeKey(teamName, scopeKey);
        const { authorization } = await resolveReviewPathAuthorization(env, scope, {
          requireIdentity: true,
        });
        assertExactGenericReviewHistoryTransition(
          incomingState,
          current,
          authorization,
          newActions
        );
      }
      if (
        newActions.length === 0 &&
        (!isDurableReviewEqual(
          incomingState.reviewActionHistory ?? [],
          current?.reviewActionHistory ?? []
        ) ||
          !isDurableReviewEqual(
            incomingState.reviewRedoHistory ?? [],
            current?.reviewRedoHistory ?? []
          ))
      ) {
        throw new Error('Generic saves cannot remove, reorder, or move durable review history');
      }
      const boundState = await bindNewReviewHistorySnapshots(
        env,
        incomingState,
        current,
        null,
        null
      );
      const revision = await (env.assertActive(),
      env.decisions.save(teamName, scopeKey, {
        scopeToken,
        ...boundState,
        expectedRevision,
      }));
      return { revision };
    });
  })();
}

export async function handleClearDecisions(
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
  teamName: string,
  scopeKey: string,
  scopeToken: string | null = null,
  expectedRevision: number | undefined = undefined
): Promise<{
  revision: number;
}> {
  return (async () => {
    if (!scopeToken) {
      await (env.assertActive(), env.decisions.clear(teamName, scopeKey));
      return { revision: 0 };
    }
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(env, teamName, persistenceScope, async () => {
      if (expectedRevision === undefined) {
        // Only the explicit "discard unreadable state" UI uses this recovery escape hatch.
        const inspection = await (env.assertActive(),
        env.journal.inspectForRecoveryDiscard(teamName, persistenceScope));
        if (
          inspection.records.some(
            (record) => record.decisions.length > 0 || (record.diskSteps?.length ?? 0) > 0
          )
        ) {
          throw new Error(
            'Cannot discard a disk mutation that may be partially applied. Retry recovery instead.'
          );
        }
        await (env.assertActive(),
        env.decisions.clearUnreadableExactScope(teamName, scopeKey, scopeToken));
        if (inspection.corruptRecordCount > 0) {
          await (env.assertActive(),
          env.journal.quarantineCorruptScope(teamName, persistenceScope));
        } else {
          await (env.assertActive(), env.journal.clearScope(teamName, persistenceScope));
        }
        return { revision: 0 };
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('Clearing review decisions requires an exact decision revision');
      }
      await recoverReviewMutationJournal(env, teamName, persistenceScope);
      const revision = await (env.assertActive(),
      env.decisions.save(teamName, scopeKey, {
        scopeToken,
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
        expectedRevision,
      }));
      return { revision };
    });
  })();
}
