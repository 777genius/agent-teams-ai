import type {
  ApplyReviewResult,
  ReviewMutationDiskPostimage,
  ApplyReviewDiskTransition,
  ReviewDecisionPersistenceScope,
} from '../../contracts.js';
import {
  normalizeReviewPathForIdentity,
  invalidateAuthoritativeReviewContent,
} from './scopeAuthorization.js';
import type {
  ReviewMutationJournalPathTransition,
  ReviewMutationJournalRecord,
} from '../storage/ReviewMutationJournalStore.js';
import { threeWayTextMerge } from '../apply/threeWayTextMerge.js';
import type { ReviewWriterContext } from './ports.js';
import { parseReviewFileScope } from './validation.js';
import {
  assertReviewMutationPathPostimages,
  readReviewMutationPathPostimages,
  reconcileLatestReviewActionPostimages,
} from './postimages.js';
import { ReviewMutationApplyResultError } from './apply.js';
import { ReviewMutationJournalStore } from '../storage/ReviewMutationJournalStore.js';
import { isDeepStrictEqual } from 'util';

export function mergeReviewApplyResults(
  current: ApplyReviewResult,
  next: ApplyReviewResult
): ApplyReviewResult {
  return {
    applied: current.applied + next.applied,
    skipped: current.skipped + next.skipped,
    conflicts: current.conflicts + next.conflicts,
    errors: [...current.errors, ...next.errors],
  };
}

export function mergeReviewMutationDiskPostimages(
  target: Map<string, ReviewMutationDiskPostimage>,
  postimages: readonly ReviewMutationDiskPostimage[]
): void {
  for (const postimage of postimages) {
    target.set(normalizeReviewPathForIdentity(postimage.filePath), postimage);
  }
}

export function composeReviewDiskTransitions(
  existing: readonly ReviewMutationJournalPathTransition[],
  next: readonly ApplyReviewDiskTransition[]
): ReviewMutationJournalPathTransition[] {
  const composed = new Map(
    existing.map((transition) => [normalizeReviewPathForIdentity(transition.filePath), transition])
  );
  for (const transition of next) {
    const key = normalizeReviewPathForIdentity(transition.filePath);
    const previous = composed.get(key);
    if (!previous) {
      composed.set(key, { ...transition });
      continue;
    }
    if (
      previous.beforeContent === transition.beforeContent &&
      previous.afterContent === transition.afterContent
    ) {
      composed.set(key, { ...previous, ...transition });
      continue;
    }
    if (
      transition.beforeContent === transition.afterContent &&
      previous.afterContent === transition.beforeContent
    ) {
      continue;
    }
    if (
      typeof previous.afterContent !== 'string' ||
      typeof transition.beforeContent !== 'string' ||
      typeof previous.beforeContent !== 'string'
    ) {
      throw new Error(
        `Review mutation file presence changed during recovery; refusing ${transition.filePath}`
      );
    }
    const merged = threeWayTextMerge(
      previous.afterContent,
      transition.beforeContent,
      previous.beforeContent
    );
    if (merged.hasConflicts) {
      throw new Error(
        `Review mutation concurrent edits cannot be preserved safely; refusing ${transition.filePath}`
      );
    }
    composed.set(key, {
      ...previous,
      ...transition,
      filePath: transition.filePath,
      beforeContent: merged.content,
      afterContent: transition.afterContent,
    });
  }
  return [...composed.values()];
}

export async function applyJournalDecisionBatchDisk(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive' | 'content' | 'journal' | 'logger'>,
  record: ReviewMutationJournalRecord,
  onResult?: (result: ApplyReviewResult) => void,
  onPostimages?: (postimages: readonly ReviewMutationDiskPostimage[]) => void
): Promise<ReviewMutationJournalRecord> {
  let current = record;
  let aggregate: ApplyReviewResult = { applied: 0, skipped: 0, conflicts: 0, errors: [] };
  const scope = parseReviewFileScope(current.reviewScope);
  const initialStatuses =
    current.decisionStatuses ?? current.decisions.map(() => 'pending' as const);
  try {
    for (const [index, status] of initialStatuses.entries()) {
      if (status !== 'applied') continue;
      const postimages = current.decisionPostimages?.[index];
      if (!postimages) {
        throw new Error('Applied review mutation is missing durable postimage evidence');
      }
      await assertReviewMutationPathPostimages(postimages);
      await (env.assertActive(),
      env.applier.finalizeReviewDiskTransitions(current.decisionTransitions?.[index] ?? [])).catch(
        (error) => {
          env.logger.warn('Unable to finalize applied review file transaction:', error);
        }
      );
    }
  } catch (error) {
    await (env.assertActive(), env.journal.markFailed(current, error)).catch((journalError) => {
      env.logger.error('Unable to preserve drifted review mutation journal:', journalError);
    });
    throw error;
  }
  for (let index = 0; index < current.decisions.length; index++) {
    if (initialStatuses[index] === 'applied') continue;
    const decision = current.decisions[index];
    const fileContent = current.fileContents[index];
    if (!decision || !fileContent || fileContent.filePath !== decision.filePath) {
      throw new Error('Review mutation recovery content is unavailable');
    }
    let stepResult: ApplyReviewResult;
    try {
      stepResult = await (env.assertActive(),
      env.applier.applyReviewDecisions(
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
            decisionTransitions[index] = composeReviewDiskTransitions(existing, transitions);
            current = await (env.assertActive(),
            env.journal.checkpoint({
              ...current,
              decisionTransitions,
            }));
          },
        }
      ));
    } catch (error) {
      await (env.assertActive(), env.journal.markFailed(current, error)).catch((journalError) => {
        env.logger.error('Unable to mark failed review mutation journal:', journalError);
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
        await (env.assertActive(), env.journal.remove(current)).catch((error) => {
          env.logger.error('Unable to remove cleanly-conflicted review mutation journal:', error);
        });
      } else {
        await (env.assertActive(),
        env.journal.markFailed(current, stepResult.errors[0]?.error)).catch((error) => {
          env.logger.error('Unable to preserve failed review mutation journal:', error);
        });
      }
      throw new ReviewMutationApplyResultError(aggregate);
    }
    try {
      const decisionStatuses = [...(current.decisionStatuses ?? initialStatuses)];
      decisionStatuses[index] = 'applied';
      const pathPostimages = await readReviewMutationPathPostimages(fileContent);
      const decisionPostimages = [
        ...(current.decisionPostimages ?? current.decisions.map(() => null)),
      ];
      decisionPostimages[index] = pathPostimages.durable;
      const decisionTransitions = [
        ...(current.decisionTransitions ?? current.decisions.map(() => null)),
      ];
      const mutatedPaths = new Set<string>();
      for (const transition of decisionTransitions[index] ?? []) {
        if (transition.beforeContent === transition.afterContent && !transition.operation) continue;
        mutatedPaths.add(normalizeReviewPathForIdentity(transition.filePath));
        if (transition.relatedFilePath) {
          mutatedPaths.add(normalizeReviewPathForIdentity(transition.relatedFilePath));
        }
      }
      onPostimages?.(
        [...pathPostimages.contents]
          .filter(([filePath]) => mutatedPaths.has(normalizeReviewPathForIdentity(filePath)))
          .map(([filePath, content]) => ({ filePath, content }))
      );
      let persistedState = current.persistedState;
      if (persistedState) {
        persistedState = await reconcileLatestReviewActionPostimages(
          persistedState,
          pathPostimages.contents,
          decisionTransitions[index] ?? []
        );
      }
      current = await (env.assertActive(),
      env.journal.checkpoint({
        ...current,
        decisionStatuses,
        decisionPostimages,
        decisionTransitions,
        persistedState,
      }));
      await (env.assertActive(),
      env.applier.finalizeReviewDiskTransitions(decisionTransitions[index] ?? [])).catch(
        (error) => {
          env.logger.warn('Unable to finalize review file transaction:', error);
        }
      );
    } catch (error) {
      await (env.assertActive(), env.journal.markFailed(current, error)).catch((journalError) => {
        env.logger.error('Unable to checkpoint review mutation postimage:', journalError);
      });
      throw error;
    }
    invalidateAuthoritativeReviewContent(env, fileContent);
  }
  return current;
}

export async function commitReviewMutationDecisions(
  env: Pick<ReviewWriterContext, 'assertActive' | 'decisions'>,
  record: Awaited<ReturnType<ReviewMutationJournalStore['list']>>[number]
): Promise<void> {
  const { teamName, persistenceScope } = record;
  if (record.persistedState) {
    await (env.assertActive(),
    env.decisions.save(teamName, persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      ...record.persistedState,
      expectedRevision: record.expectedDecisionRevision,
      mutationId: record.id,
    }));
    return;
  }
  // Version-1 journal compatibility. Once recovered, the record is completed and removed.
  for (const decision of record.decisions) {
    await (env.assertActive(),
    env.decisions.mergeFileDecisionPatch(
      teamName,
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      decision
    ));
  }
}

export async function assertCurrentReviewDecisionRevision(
  env: Pick<ReviewWriterContext, 'assertActive' | 'decisions'>,
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope,
  expectedRevision: number
): Promise<void> {
  const current = await (env.assertActive(),
  env.decisions.load(teamName, persistenceScope.scopeKey, persistenceScope.scopeToken));
  if ((current?.revision ?? 0) !== expectedRevision) {
    throw new Error('Review decisions changed; refusing stale state overwrite');
  }
}

export function toDurableReviewValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => toDurableReviewValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, toDurableReviewValue(entry)])
  );
}

export function isDurableReviewEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(toDurableReviewValue(left), toDurableReviewValue(right));
}
