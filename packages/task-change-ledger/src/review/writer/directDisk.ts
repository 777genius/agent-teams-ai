import { getAuthoritativeRenameStepFile } from './authoritativeReviewFiles.js';
import type { ReviewWriterContext } from './ports.js';
import type {
  ReviewDirectDiskMutationStep,
  ReviewPersistedStateSnapshot,
  ReviewFileScope,
  ReviewMutationDiskPostimage,
} from '../../contracts.js';
import type { ReviewPathAuthorization } from './displayedSnapshots.js';
import type {
  ReviewMutationJournalDiskStep,
  ReviewMutationJournalRecord,
} from '../storage/ReviewMutationJournalStore.js';
import {
  validateAuthorizedReviewFilePath,
  resolveAuthoritativeFileContent,
  assertExpectedAuthoritativeRename,
  invalidateAuthoritativeReviewContent,
} from './scopeAuthorization.js';
import { parseReviewRenameRecoveryExpectation, validateSnippetPaths } from './validation.js';
import { mergeReviewMutationDiskPostimages } from './decisionBatch.js';

export async function normalizeDirectReviewMutationSteps(
  env: Pick<ReviewWriterContext, 'assertActive' | 'content'>,
  steps: readonly ReviewDirectDiskMutationStep[],
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization,
  history: Pick<ReviewPersistedStateSnapshot, 'reviewActionHistory' | 'reviewRedoHistory'>
): Promise<ReviewMutationJournalDiskStep[]> {
  const ids = new Set<string>();
  const normalized: ReviewMutationJournalDiskStep[] = [];
  const actions = [
    ...history.reviewActionHistory,
    ...history.reviewRedoHistory.map((entry) => entry.action),
  ];
  for (const step of steps) {
    if (
      !step ||
      typeof step.id !== 'string' ||
      step.id.length === 0 ||
      step.id.length > 256 ||
      ids.has(step.id)
    ) {
      throw new Error('Invalid or duplicate review mutation step id');
    }
    ids.add(step.id);
    const filePath = await validateAuthorizedReviewFilePath(authorization, step.filePath, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    if (step.type === 'write') {
      if (
        typeof step.content !== 'string' ||
        (step.expectedContent !== null && typeof step.expectedContent !== 'string')
      ) {
        throw new Error('Invalid review write mutation');
      }
      normalized.push({ ...step, filePath, status: 'pending' });
      continue;
    }
    if (step.type === 'delete') {
      if (typeof step.expectedContent !== 'string') {
        throw new Error('Invalid review delete mutation');
      }
      normalized.push({ ...step, filePath, status: 'pending' });
      continue;
    }
    if (step.type !== 'restore-rejected-rename' && step.type !== 'reapply-rejected-rename') {
      throw new Error('Invalid review mutation step');
    }
    const expectation = parseReviewRenameRecoveryExpectation(step.expectation);
    const authoritativeContent = await resolveAuthoritativeFileContent(
      env,
      scope,
      authorization,
      filePath,
      getAuthoritativeRenameStepFile(authorization, step, actions)
    );
    await validateSnippetPaths(authorization, authoritativeContent.snippets, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    assertExpectedAuthoritativeRename(authoritativeContent, expectation);
    normalized.push({
      ...step,
      filePath,
      expectation,
      authoritativeContent,
      status: 'pending',
    });
  }
  return normalized;
}

export async function buildDirectReviewMutationDiskPostimages(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive'>,
  steps: readonly ReviewMutationJournalDiskStep[]
): Promise<ReviewMutationDiskPostimage[]> {
  const postimages = new Map<string, ReviewMutationDiskPostimage>();
  for (const step of steps) {
    if (step.type === 'write') {
      mergeReviewMutationDiskPostimages(postimages, [
        { filePath: step.filePath, content: step.content },
      ]);
      continue;
    }
    if (step.type === 'delete') {
      mergeReviewMutationDiskPostimages(postimages, [{ filePath: step.filePath, content: null }]);
      continue;
    }
    const content = step.authoritativeContent;
    if (!content) throw new Error('Rename recovery content is unavailable');
    mergeReviewMutationDiskPostimages(
      postimages,
      await (env.assertActive(),
      env.applier.getRejectedRenamePostimages(
        content.originalFullContent,
        content.modifiedFullContent,
        content.snippets,
        step.type === 'restore-rejected-rename' ? 'restore' : 'reapply'
      ))
    );
  }
  return [...postimages.values()];
}

export async function buildJournalRecoveryDiskPostimages(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive'>,
  record: ReviewMutationJournalRecord
): Promise<ReviewMutationDiskPostimage[]> {
  if (record.diskSteps) return buildDirectReviewMutationDiskPostimages(env, record.diskSteps);
  const postimages = new Map<string, ReviewMutationDiskPostimage>();
  for (const [index, content] of record.fileContents.entries()) {
    const transitions = (record.decisionTransitions?.[index] ?? []).filter(
      (transition) => transition.beforeContent !== transition.afterContent || transition.operation
    );
    const hasRename = content.snippets.some(
      (snippet) => snippet.ledger?.relation?.kind === 'rename' && !snippet.isError
    );
    if (hasRename && transitions.length > 0) {
      mergeReviewMutationDiskPostimages(
        postimages,
        await (env.assertActive(),
        env.applier.getRejectedRenamePostimages(
          content.originalFullContent,
          content.modifiedFullContent,
          content.snippets,
          'reapply'
        ))
      );
      continue;
    }
    for (const transition of transitions) {
      if (transition.operation === 'move' && transition.relatedFilePath) {
        mergeReviewMutationDiskPostimages(postimages, [
          { filePath: transition.filePath, content: null },
          { filePath: transition.relatedFilePath, content: transition.afterContent },
        ]);
      } else {
        mergeReviewMutationDiskPostimages(postimages, [
          { filePath: transition.filePath, content: transition.afterContent },
        ]);
      }
    }
  }
  return [...postimages.values()];
}

export type DirectReviewMutationState = 'before' | 'after' | 'both' | 'intermediate';

export async function classifyDirectReviewMutationStep(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive'>,
  step: ReviewMutationJournalDiskStep
): Promise<DirectReviewMutationState> {
  if (step.type === 'write') {
    return (
      env.assertActive(),
      env.applier.classifyEditedFileTransition(step.filePath, step.expectedContent, step.content)
    );
  }
  if (step.type === 'delete') {
    return (
      env.assertActive(),
      env.applier.classifyEditedFileTransition(step.filePath, step.expectedContent, null)
    );
  }
  const content = step.authoritativeContent;
  if (!content) throw new Error('Rename recovery content is unavailable');
  const state = await (env.assertActive(),
  env.applier.classifyRejectedRenameTransition(
    step.filePath,
    content.originalFullContent,
    content.modifiedFullContent,
    content.snippets
  ));
  if (state === 'both') return 'both';
  const beforeState = step.type === 'restore-rejected-rename' ? 'rejected' : 'accepted';
  const afterState = step.type === 'restore-rejected-rename' ? 'accepted' : 'rejected';
  if (state === beforeState) return 'before';
  if (state === afterState) return 'after';
  const recoverableIntermediate =
    (step.type === 'restore-rejected-rename' && state === 'restoring') ||
    (step.type === 'reapply-rejected-rename' &&
      (state === 'reapplying' || state === 'legacy-reapplying'));
  if (recoverableIntermediate) return 'intermediate';
  throw new Error('Ledger rename is not in the expected durable mutation state');
}

export async function assertDirectReviewMutationPreimages(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive'>,
  steps: readonly ReviewMutationJournalDiskStep[]
): Promise<void> {
  for (const step of steps) {
    const state = await classifyDirectReviewMutationStep(env, step);
    if (state !== 'before' && state !== 'both') {
      throw new Error('Review mutation preflight failed; no files were changed');
    }
  }
}

export async function finalizeDirectReviewMutationArtifacts(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive'>,
  step: ReviewMutationJournalDiskStep
): Promise<void> {
  if (step.type === 'write') {
    await (env.assertActive(),
    env.applier.finalizeEditedFileTransaction?.(step.filePath, step.expectedContent, step.content));
    return;
  }
  if (step.type === 'delete') {
    await (env.assertActive(),
    env.applier.finalizeEditedFileTransaction?.(step.filePath, step.expectedContent, null));
    return;
  }
  const content = step.authoritativeContent;
  if (!content) return;
  await (env.assertActive(),
  env.applier.finalizeRejectedRenameTransaction?.(
    step.filePath,
    content.originalFullContent,
    content.modifiedFullContent,
    content.snippets,
    step.type === 'restore-rejected-rename' ? 'restore' : 'reapply'
  ));
}

export async function applyDirectReviewMutationDisk(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive' | 'content' | 'journal' | 'logger'>,
  record: ReviewMutationJournalRecord
): Promise<ReviewMutationJournalRecord> {
  let current = record;
  const steps = current.diskSteps;
  if (!steps?.length) return current;
  try {
    const alreadyAtPostimage = new Set<number>();
    for (const [index, step] of steps.entries()) {
      const state = await classifyDirectReviewMutationStep(env, step);
      if (step.status === 'applied') {
        if (state !== 'after' && state !== 'both') {
          throw new Error('Applied review mutation changed after crash; refusing recovery');
        }
      } else if (state === 'after' || state === 'both') {
        alreadyAtPostimage.add(index);
      }
    }
    if (alreadyAtPostimage.size > 0) {
      current = await (env.assertActive(),
      env.journal.checkpoint({
        ...current,
        diskSteps: current.diskSteps!.map((step, index) =>
          alreadyAtPostimage.has(index) ? { ...step, status: 'applied' as const } : step
        ),
      }));
      for (const index of alreadyAtPostimage) {
        const appliedStep = current.diskSteps?.[index];
        if (appliedStep) await finalizeDirectReviewMutationArtifacts(env, appliedStep);
      }
    }
  } catch (error) {
    await (env.assertActive(), env.journal.markFailed(current, error)).catch((journalError) => {
      env.logger.error('Unable to preserve drifted direct review mutation:', journalError);
    });
    throw error;
  }
  for (let index = 0; index < steps.length; index++) {
    const step = current.diskSteps?.[index];
    if (!step || step.status === 'applied') continue;
    try {
      if (step.type === 'write') {
        await (env.assertActive(),
        env.applier.saveEditedFile(step.filePath, step.content, step.expectedContent));
      } else if (step.type === 'delete') {
        await (env.assertActive(),
        env.applier.deleteEditedFile(step.filePath, step.expectedContent));
      } else {
        const content = step.authoritativeContent;
        if (!content) throw new Error('Rename recovery content is unavailable');
        if (step.type === 'restore-rejected-rename') {
          await (env.assertActive(),
          env.applier.restoreRejectedRename(
            step.filePath,
            content.originalFullContent,
            content.modifiedFullContent,
            content.snippets
          ));
        } else {
          await (env.assertActive(),
          env.applier.reapplyRejectedRename(
            step.filePath,
            content.originalFullContent,
            content.snippets
          ));
        }
      }
      const postState = await classifyDirectReviewMutationStep(env, step);
      if (postState !== 'after' && postState !== 'both') {
        throw new Error('Review mutation did not reach its durable postimage');
      }
    } catch (error) {
      await (env.assertActive(), env.journal.markFailed(current, error)).catch((journalError) => {
        env.logger.error('Unable to mark failed direct review mutation:', journalError);
      });
      throw error;
    }
    const nextSteps = current.diskSteps!.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, status: 'applied' as const } : candidate
    );
    current = await (env.assertActive(),
    env.journal.checkpoint({ ...current, diskSteps: nextSteps }));
    await finalizeDirectReviewMutationArtifacts(env, step);
    if (step.authoritativeContent) {
      invalidateAuthoritativeReviewContent(env, step.authoritativeContent);
    } else {
      env.assertActive();
      env.content.invalidateFile(step.filePath);
    }
  }
  return current;
}
