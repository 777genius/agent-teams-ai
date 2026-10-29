import type { ReviewWriterContext, ReviewApplierPort } from './ports.js';
import type {
  ApplyReviewDiskTransition,
  ApplyReviewRequest,
  ApplyReviewResult,
  FileChangeWithContent,
  RejectResult,
} from '../../contracts.js';
import {
  reviewApplyMutationContext,
  type ReviewApplyMutationContext,
} from '../apply/applyContext.js';
import { getReviewFileTransactionFromTransition } from '../apply/reviewFileTransition.js';
import { inspectReviewFileTransaction } from '../io/index.js';

type StandaloneContext = Pick<
  ReviewWriterContext,
  'applier' | 'assertActive' | 'markStandaloneUncertain'
>;
type StandaloneReject =
  | { method: 'rejectHunks'; args: Parameters<ReviewApplierPort['rejectHunks']> }
  | { method: 'rejectFile'; args: Parameters<ReviewApplierPort['rejectFile']> };
type StandaloneRename =
  | {
      method: 'restoreRejectedRename';
      args: Parameters<ReviewApplierPort['restoreRejectedRename']>;
    }
  | {
      method: 'reapplyRejectedRename';
      args: Parameters<ReviewApplierPort['reapplyRejectedRename']>;
    };

function createStandaloneContext(): ReviewApplyMutationContext {
  if (reviewApplyMutationContext.getStore()) {
    throw new Error('Standalone review cannot settle a parent mutation');
  }
  return { observedPreimages: new Map(), plannedTransitions: new Map() };
}

async function retainUncertainTransactions(
  env: StandaloneContext,
  transitions: readonly ApplyReviewDiskTransition[]
): Promise<void> {
  for (const transition of transitions) {
    const transaction = getReviewFileTransactionFromTransition(transition);
    // No transaction was created for ordinary preflight/conflict failures.
    if (!transaction) continue;
    env.assertActive();
    const state = await inspectReviewFileTransaction(transaction);
    env.assertActive();
    // Prepared with neither detached nor before inode is an actual no-detach proof.
    // Other states follow a captured prepared transaction and a possible execute attempt.
    if (state !== 'prepared') {
      env.markStandaloneUncertain?.();
      return;
    }
  }
}

/** Only public direct mutations own this settlement; parent WAL primitives never call it. */
export async function rejectStandalone(
  env: StandaloneContext,
  request: StandaloneReject
): Promise<RejectResult> {
  const context = createStandaloneContext();
  const result = await reviewApplyMutationContext.run(context, () => {
    env.assertActive();
    return request.method === 'rejectHunks'
      ? env.applier.rejectHunks(...request.args)
      : env.applier.rejectFile(...request.args);
  });
  if (result.success) {
    env.assertActive();
    await env.applier.finalizeReviewDiskTransitions([...context.plannedTransitions.values()]);
  } else {
    await retainUncertainTransactions(env, [...context.plannedTransitions.values()]);
  }
  return result;
}

export async function renameStandalone(
  env: StandaloneContext,
  request: StandaloneRename
): Promise<{ success: true }> {
  const context = createStandaloneContext();
  const result = await reviewApplyMutationContext.run(context, () => {
    env.assertActive();
    return request.method === 'restoreRejectedRename'
      ? env.applier.restoreRejectedRename(...request.args)
      : env.applier.reapplyRejectedRename(...request.args);
  });
  env.assertActive();
  await env.applier.finalizeReviewDiskTransitions([...context.plannedTransitions.values()]);
  return result;
}

export async function applyStandaloneDecisions(
  env: StandaloneContext,
  request: ApplyReviewRequest,
  fileContents: Map<string, FileChangeWithContent>
): Promise<ApplyReviewResult> {
  createStandaloneContext();
  let transitions: readonly ApplyReviewDiskTransition[] = [];
  const publishedCreates = new Set<string>();
  env.assertActive();
  const result = await env.applier.applyReviewDecisions(request, fileContents, {
    async checkpointDiskTransitions(recorded) {
      // Applier supplies actual transaction identity and disk preimage, including merged edits.
      transitions = recorded;
    },
    publishedCreate(filePath) {
      // Runs immediately after the actual no-clobber link, before late authority checks.
      publishedCreates.add(filePath);
    },
  });
  const failedPaths = new Set(
    result.errors.flatMap(({ filePath }) => [
      filePath,
      ...(fileContents.get(filePath)?.snippets.map((snippet) => snippet.filePath) ?? []),
    ])
  );
  const completed = transitions.filter(
    (transition) =>
      !failedPaths.has(transition.filePath) &&
      (!transition.relatedFilePath || !failedPaths.has(transition.relatedFilePath))
  );
  env.assertActive();
  await env.applier.finalizeReviewDiskTransitions(completed);
  if ([...publishedCreates].some((filePath) => failedPaths.has(filePath))) {
    env.markStandaloneUncertain?.();
    return result;
  }
  await retainUncertainTransactions(
    env,
    transitions.filter((transition) => !completed.includes(transition))
  );
  // Failed paths retain their evidence. Preserve the original known-partial result shape.
  return result;
}
