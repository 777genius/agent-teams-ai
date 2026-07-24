import { createHash } from 'node:crypto';

import { threeWayTextMerge } from '@shared/utils/threeWayTextMerge';

import { ReviewMutationApplyResultError } from '../../core/application/ReviewMutationApplyResultError';
import {
  assertPersistedStateIncludesDecisions,
  composeReviewDiskTransitions,
  mergeReviewApplyResults,
} from '../../core/domain/reviewDecisionBatch';

import type {
  ReviewMutationJournalPathPostimage,
  ReviewMutationJournalPathTransition,
  ReviewMutationJournalRecord,
} from '../../core/application/ReviewMutationJournalTypes';
import type {
  ReviewDecisionBatchDependencies,
  ReviewDecisionBatchFileTransaction,
} from './ReviewMutationRecoveryPorts';
import type {
  ApplyReviewResult,
  FileChangeWithContent,
  FileReviewDecision,
  ReviewDiskUndoSnapshot,
  ReviewMutationDiskPostimage,
  ReviewPersistedStateSnapshot,
} from '@shared/types/review';

export class ReviewDecisionBatchApplication {
  constructor(private readonly dependencies: ReviewDecisionBatchDependencies) {}

  assertPersistedStateIncludesDecisions(
    state: ReviewPersistedStateSnapshot,
    decisions: readonly FileReviewDecision[]
  ): void {
    assertPersistedStateIncludesDecisions(state, decisions);
  }

  async applyDisk(
    record: ReviewMutationJournalRecord,
    onResult?: (result: ApplyReviewResult) => void,
    onPostimages?: (postimages: readonly ReviewMutationDiskPostimage[]) => void
  ): Promise<ReviewMutationJournalRecord> {
    let current = record;
    let aggregate: ApplyReviewResult = { applied: 0, skipped: 0, conflicts: 0, errors: [] };
    const scope = this.dependencies.scope.parse(current.reviewScope);
    const initialStatuses =
      current.decisionStatuses ?? current.decisions.map(() => 'pending' as const);

    try {
      for (const [index, status] of initialStatuses.entries()) {
        if (status !== 'applied') continue;
        const postimages = current.decisionPostimages?.[index];
        if (!postimages) {
          throw new Error('Applied review mutation is missing durable postimage evidence');
        }
        await this.assertPathPostimages(postimages);
        await this.dependencies.applier
          .finalizeReviewDiskTransitions?.(current.decisionTransitions?.[index] ?? [])
          .catch((error) => {
            this.dependencies.logger.warn(
              'Unable to finalize applied review file transaction:',
              error
            );
          });
      }
    } catch (error) {
      await this.dependencies.journal.markFailed(current, error).catch((journalError) => {
        this.dependencies.logger.error(
          'Unable to preserve drifted review mutation journal:',
          journalError
        );
      });
      throw error;
    }

    for (let index = 0; index < current.decisions.length; index++) {
      if (initialStatuses[index] === 'applied') continue;
      const decision = current.decisions[index];
      const fileContent = current.fileContents[index];
      if (!decision || fileContent?.filePath !== decision.filePath) {
        throw new Error('Review mutation recovery content is unavailable');
      }

      let stepResult: ApplyReviewResult;
      try {
        stepResult = await this.dependencies.applier.applyReviewDecisions(
          {
            teamName: current.teamName,
            ...(scope.taskId ? { taskId: scope.taskId } : {}),
            ...(scope.memberName ? { memberName: scope.memberName } : {}),
            decisions: [decision],
          },
          new Map([[decision.filePath, fileContent]]),
          {
            initialDiskTransitions: current.decisionTransitions?.[index] ?? undefined,
            checkpointDiskTransitions: async (transitions) => {
              const decisionTransitions = [
                ...(current.decisionTransitions ?? current.decisions.map(() => null)),
              ];
              const existing = decisionTransitions[index] ?? [];
              decisionTransitions[index] = composeReviewDiskTransitions(
                existing,
                transitions,
                (filePath) => this.dependencies.scope.normalizeIdentityPath(filePath),
                threeWayTextMerge
              );
              current = await this.dependencies.journal.checkpoint({
                ...current,
                decisionTransitions,
              });
            },
          }
        );
      } catch (error) {
        await this.dependencies.journal.markFailed(current, error).catch((journalError) => {
          this.dependencies.logger.error(
            'Unable to mark failed review mutation journal:',
            journalError
          );
        });
        throw error;
      }

      aggregate = mergeReviewApplyResults(aggregate, stepResult);
      onResult?.(aggregate);
      if (stepResult.errors.length > 0) {
        const transitionEvidence = current.decisionTransitions?.[index];
        if (
          initialStatuses[index] === 'pending' &&
          (!transitionEvidence || transitionEvidence.length === 0)
        ) {
          await this.dependencies.journal.remove(current).catch((error) => {
            this.dependencies.logger.error(
              'Unable to remove cleanly-conflicted review mutation journal:',
              error
            );
          });
        } else {
          await this.dependencies.journal
            .markFailed(current, stepResult.errors[0]?.error)
            .catch((error) => {
              this.dependencies.logger.error(
                'Unable to preserve failed review mutation journal:',
                error
              );
            });
        }
        throw new ReviewMutationApplyResultError(aggregate);
      }

      try {
        const decisionStatuses = [...(current.decisionStatuses ?? initialStatuses)];
        decisionStatuses[index] = 'applied';
        const pathPostimages = await this.readPathPostimages(fileContent);
        const decisionPostimages = [
          ...(current.decisionPostimages ?? current.decisions.map(() => null)),
        ];
        decisionPostimages[index] = pathPostimages.durable;
        const decisionTransitions = [
          ...(current.decisionTransitions ?? current.decisions.map(() => null)),
        ];
        const mutatedPaths = new Set<string>();
        for (const transition of decisionTransitions[index] ?? []) {
          if (transition.beforeContent === transition.afterContent && !transition.operation) {
            continue;
          }
          mutatedPaths.add(this.dependencies.scope.normalizeIdentityPath(transition.filePath));
          if (transition.relatedFilePath) {
            mutatedPaths.add(
              this.dependencies.scope.normalizeIdentityPath(transition.relatedFilePath)
            );
          }
        }
        onPostimages?.(
          [...pathPostimages.contents]
            .filter(([filePath]) =>
              mutatedPaths.has(this.dependencies.scope.normalizeIdentityPath(filePath))
            )
            .map(([filePath, content]) => ({ filePath, content }))
        );
        let persistedState = current.persistedState;
        if (persistedState) {
          persistedState = await this.reconcileLatestActionPostimages(
            persistedState,
            pathPostimages.contents,
            decisionTransitions[index] ?? []
          );
        }
        current = await this.dependencies.journal.checkpoint({
          ...current,
          decisionStatuses,
          decisionPostimages,
          decisionTransitions,
          persistedState,
        });
        await this.dependencies.applier
          .finalizeReviewDiskTransitions?.(decisionTransitions[index] ?? [])
          .catch((error) => {
            this.dependencies.logger.warn('Unable to finalize review file transaction:', error);
          });
      } catch (error) {
        await this.dependencies.journal.markFailed(current, error).catch((journalError) => {
          this.dependencies.logger.error(
            'Unable to checkpoint review mutation postimage:',
            journalError
          );
        });
        throw error;
      }
      this.dependencies.cache.invalidateAuthoritativeContent(fileContent);
    }

    return current;
  }

  async commit(record: ReviewMutationJournalRecord): Promise<void> {
    const { teamName, persistenceScope } = record;
    if (record.persistedState) {
      await this.dependencies.persistence.save(teamName, persistenceScope.scopeKey, {
        scopeToken: persistenceScope.scopeToken,
        ...record.persistedState,
        expectedRevision: record.expectedDecisionRevision,
        mutationId: record.id,
      });
      return;
    }
    // Version-1 journal compatibility. Once recovered, the record is completed and removed.
    for (const decision of record.decisions) {
      await this.dependencies.persistence.mergeFileDecisionPatch(
        teamName,
        persistenceScope.scopeKey,
        persistenceScope.scopeToken,
        decision
      );
    }
  }

  private async readPathPostimages(fileContent: FileChangeWithContent): Promise<{
    durable: ReviewMutationJournalPathPostimage[];
    contents: Map<string, string | null>;
  }> {
    const paths = new Map<string, string>();
    for (const filePath of [
      fileContent.filePath,
      ...fileContent.snippets.map((snippet) => snippet.filePath),
    ]) {
      paths.set(this.dependencies.scope.normalizeIdentityPath(filePath), filePath);
    }
    const durable: ReviewMutationJournalPathPostimage[] = [];
    const contents = new Map<string, string | null>();
    for (const filePath of paths.values()) {
      try {
        const content = await this.dependencies.files.readText(filePath);
        contents.set(filePath, content);
        durable.push({ filePath, sha256: this.hashContent(content) });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          contents.set(filePath, null);
          durable.push({ filePath, sha256: null });
        } else {
          throw error;
        }
      }
    }
    return { durable, contents };
  }

  private async assertPathPostimages(
    postimages: readonly ReviewMutationJournalPathPostimage[]
  ): Promise<void> {
    if (postimages.length === 0) {
      throw new Error('Applied review mutation has no durable postimage evidence');
    }
    for (const postimage of postimages) {
      let currentSha256: string | null;
      try {
        currentSha256 = this.hashContent(
          await this.dependencies.files.readText(postimage.filePath)
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') currentSha256 = null;
        else throw error;
      }
      if (currentSha256 !== postimage.sha256) {
        throw new Error(
          `Review mutation postimage changed after crash; refusing recovery for ${postimage.filePath}`
        );
      }
    }
  }

  private async reconcileLatestActionPostimages(
    state: ReviewPersistedStateSnapshot,
    postimages: ReadonlyMap<string, string | null>,
    transitions: readonly ReviewMutationJournalPathTransition[]
  ): Promise<ReviewPersistedStateSnapshot> {
    const latest = state.reviewActionHistory.at(-1);
    if (!latest) return state;
    const resolvePostimage = (filePath: string): string | null | undefined => {
      for (const [candidatePath, content] of postimages) {
        if (
          this.dependencies.scope.normalizeIdentityPath(candidatePath) ===
          this.dependencies.scope.normalizeIdentityPath(filePath)
        ) {
          return content;
        }
      }
      return undefined;
    };
    const resolveTransition = (filePath: string): ReviewMutationJournalPathTransition | undefined =>
      transitions.find(
        (transition) =>
          this.dependencies.scope.normalizeIdentityPath(transition.filePath) ===
          this.dependencies.scope.normalizeIdentityPath(filePath)
      );
    const getTransaction = (
      transition: ReviewMutationJournalPathTransition
    ): ReviewDecisionBatchFileTransaction | null => {
      const { operation, transactionId, beforeContent, afterContent } = transition;
      if (!operation || !transactionId || beforeContent === null) return null;
      if (operation === 'move') {
        if (!transition.relatedFilePath || afterContent === null) return null;
        return {
          id: transactionId,
          kind: 'move' as const,
          sourcePath: transition.filePath,
          targetPath: transition.relatedFilePath,
          expectedContent: beforeContent,
          nextContent: afterContent,
        };
      }
      return {
        id: transactionId,
        kind: operation,
        sourcePath: transition.filePath,
        targetPath: transition.filePath,
        expectedContent: beforeContent,
        nextContent: operation === 'delete' ? null : afterContent,
      };
    };
    const hasPublishedTransaction = async (
      transition: ReviewMutationJournalPathTransition | undefined
    ): Promise<boolean> => {
      if (!transition) return false;
      const transaction = getTransaction(transition);
      return transaction
        ? (await this.dependencies.files.inspectTransaction(transaction)) === 'published'
        : transition.operation === undefined;
    };
    const reconcileSnapshot = async (
      snapshot: ReviewDiskUndoSnapshot
    ): Promise<ReviewDiskUndoSnapshot> => {
      if (snapshot.renameExpectation) {
        const transition =
          resolveTransition(snapshot.filePath) ??
          transitions.find(
            (candidate) =>
              candidate.transactionId &&
              candidate.operation &&
              this.dependencies.scope.normalizeIdentityPath(candidate.relatedFilePath ?? '') ===
                this.dependencies.scope.normalizeIdentityPath(snapshot.filePath)
          );
        if (!(await hasPublishedTransaction(transition))) {
          return {
            ...snapshot,
            restoreConflict:
              'Reject rename provenance is unavailable; refusing an unsafe Undo or Restore.',
          };
        }
        return { ...snapshot, restoreConflict: undefined };
      }

      const actual = resolvePostimage(snapshot.filePath);
      if (actual === undefined) return snapshot;
      const transition = resolveTransition(snapshot.filePath);
      if (!transition) {
        return {
          ...snapshot,
          afterContent: actual,
          restoreConflict:
            'Reject lock preimage is unavailable; refusing an unsafe Undo or Restore.',
        };
      }
      if (
        transition.beforeContent === transition.afterContent &&
        (snapshot.restoreMode === 'create-file' || snapshot.restoreMode === 'delete-file')
      ) {
        return {
          ...snapshot,
          afterContent: actual,
          restoreConflict:
            'Reject did not prove this file-presence change; refusing an unsafe Undo or Restore.',
        };
      }
      if (!(await hasPublishedTransaction(transition))) {
        return {
          ...snapshot,
          afterContent: actual,
          restoreConflict:
            'Reject filesystem transaction is not durably published; refusing an unsafe Undo or Restore.',
        };
      }

      let beforeContent = transition.beforeContent;
      if (actual !== transition.afterContent) {
        if (
          typeof actual !== 'string' ||
          typeof transition.afterContent !== 'string' ||
          typeof transition.beforeContent !== 'string'
        ) {
          return {
            ...snapshot,
            afterContent: actual,
            restoreConflict:
              'Reject postimage changed across a file-presence transition; refusing an unsafe Undo or Restore.',
          };
        }
        const merged = threeWayTextMerge(transition.afterContent, actual, transition.beforeContent);
        if (!merged.hasConflicts) {
          beforeContent = merged.content;
        } else {
          return {
            ...snapshot,
            afterContent: actual,
            restoreConflict:
              'Reject preserved concurrent edits that cannot be reconstructed safely; refusing Undo or Restore.',
          };
        }
      }
      return {
        ...snapshot,
        beforeContent: beforeContent ?? '',
        afterContent: actual,
        authoritativeBeforeSha256: beforeContent === null ? null : this.hashContent(beforeContent),
        restoreConflict: undefined,
      };
    };

    let reconciled = latest;
    if (latest.kind === 'disk') {
      const snapshot = await reconcileSnapshot(latest.action.snapshot);
      if (snapshot !== latest.action.snapshot) {
        reconciled = {
          ...latest,
          action: {
            ...latest.action,
            snapshot,
          },
        };
      }
    } else if (latest.kind === 'bulk') {
      reconciled = {
        ...latest,
        diskSnapshots: await Promise.all(latest.diskSnapshots.map(reconcileSnapshot)),
      };
    }
    if (reconciled === latest) return state;
    return {
      ...state,
      reviewActionHistory: [...state.reviewActionHistory.slice(0, -1), reconciled],
    };
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
