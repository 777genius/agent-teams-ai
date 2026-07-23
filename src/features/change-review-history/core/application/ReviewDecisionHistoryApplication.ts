import { isDurableReviewEqual } from '@features/review-mutations';

import {
  assertExactGenericReviewHistoryTransition,
  assertReviewCandidateWithinAuthorization,
  bindTrustedReviewHistory,
  getNewReviewHistoryActions,
  hasNewReviewDiskHistory,
  isGenericReviewSnapshotContainedByCurrent,
} from '../domain/reviewDecisionHistoryPolicy';

import type {
  LoadedReviewDecisionState,
  ReviewDecisionHistoryDependencies,
} from './ReviewDecisionHistoryPorts';
import type {
  HunkDecision,
  ReviewConflictResolution,
  ReviewDecisionConflictCandidateSummary,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
  SaveReviewDecisionsResult,
} from '@shared/types/review';

export class ReviewDecisionHistoryApplication {
  constructor(private readonly dependencies: ReviewDecisionHistoryDependencies) {}

  load(
    teamName: string,
    scopeKey: string,
    scopeToken: string | null = null
  ): Promise<LoadedReviewDecisionState | null> {
    if (!scopeToken) {
      return this.dependencies.queries.load(teamName, scopeKey);
    }
    const persistenceScope = { scopeKey, scopeToken };
    return this.dependencies.lock.run(teamName, persistenceScope, async () => {
      await this.dependencies.recovery.recover(teamName, persistenceScope);
      return this.dependencies.queries.load(teamName, scopeKey, scopeToken);
    });
  }

  loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidateSummary[]> {
    const persistenceScope = { scopeKey, scopeToken };
    return this.dependencies.lock.run(teamName, persistenceScope, async () => {
      await this.dependencies.authorization.authorize(teamName, scopeKey);
      await this.dependencies.recovery.recover(teamName, persistenceScope);
      return this.dependencies.queries.loadConflictCandidateSummaries(
        teamName,
        scopeKey,
        scopeToken
      );
    });
  }

  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number
  ): Promise<{ revision: number }> {
    const persistenceScope = { scopeKey, scopeToken };
    return this.dependencies.lock.run(teamName, persistenceScope, async () => {
      const authorization = await this.dependencies.authorization.authorize(teamName, scopeKey);
      await this.dependencies.recovery.recover(teamName, persistenceScope);
      if (resolution === 'recover-candidate') {
        const candidate = await this.dependencies.queries.loadConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          candidateId
        );
        if (candidate.origin !== 'current-snapshot') {
          throw new Error(
            'Recovery copy belongs to a different review snapshot; only discard is safe'
          );
        }
        assertReviewCandidateWithinAuthorization(candidate.state, authorization);
      }
      const revision = await this.dependencies.mutations.resolveConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId,
        resolution,
        expectedCurrentRevision
      );
      return { revision };
    });
  }

  save(
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
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 0) {
      throw new Error('Saving review decisions requires an exact decision revision');
    }
    const persistenceScope = { scopeKey, scopeToken };
    return this.dependencies.lock.run(teamName, persistenceScope, async () => {
      await this.dependencies.recovery.recover(teamName, persistenceScope);
      const incomingState: ReviewPersistedStateSnapshot = {
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile: hunkContextHashesByFile ?? undefined,
        reviewActionHistory,
        reviewRedoHistory,
      };
      this.dependencies.validation.assertValidSnapshot(incomingState);
      const current = await this.dependencies.queries.load(teamName, scopeKey, scopeToken);
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
        const authorization = await this.dependencies.authorization.authorize(teamName, scopeKey);
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
        const boundCandidate = bindTrustedReviewHistory(incomingState, current);
        const revision = await this.dependencies.mutations.save(teamName, scopeKey, {
          scopeToken,
          ...boundCandidate,
          expectedRevision: expectedRevision!,
        });
        return { revision };
      }
      const newActions = getNewReviewHistoryActions(incomingState, current);
      if (newActions.length > 0) {
        const authorization = await this.dependencies.authorization.authorize(teamName, scopeKey);
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
      const boundState = bindTrustedReviewHistory(incomingState, current);
      const revision = await this.dependencies.mutations.save(teamName, scopeKey, {
        scopeToken,
        ...boundState,
        expectedRevision,
      });
      return { revision };
    });
  }

  async clear(
    teamName: string,
    scopeKey: string,
    scopeToken: string | null = null,
    expectedRevision: number | undefined = undefined
  ): Promise<{ revision: number }> {
    if (!scopeToken) {
      await this.dependencies.mutations.clear(teamName, scopeKey);
      return { revision: 0 };
    }
    const persistenceScope = { scopeKey, scopeToken };
    return this.dependencies.lock.run(teamName, persistenceScope, async () => {
      if (expectedRevision === undefined) {
        const inspection = await this.dependencies.recovery.inspectForDiscard(
          teamName,
          persistenceScope
        );
        if (inspection.containsPotentialDiskMutation) {
          throw new Error(
            'Cannot discard a disk mutation that may be partially applied. Retry recovery instead.'
          );
        }
        await this.dependencies.mutations.clearUnreadableExactScope(teamName, scopeKey, scopeToken);
        if (inspection.corruptRecordCount > 0) {
          await this.dependencies.recovery.quarantineCorruptScope(teamName, persistenceScope);
        } else {
          await this.dependencies.recovery.clearScope(teamName, persistenceScope);
        }
        return { revision: 0 };
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('Clearing review decisions requires an exact decision revision');
      }
      await this.dependencies.recovery.recover(teamName, persistenceScope);
      const revision = await this.dependencies.mutations.save(teamName, scopeKey, {
        scopeToken,
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
        expectedRevision,
      });
      return { revision };
    });
  }
}
