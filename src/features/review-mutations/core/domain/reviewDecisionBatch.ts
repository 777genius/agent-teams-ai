import type { ReviewMutationJournalPathTransition } from '../application/ReviewMutationJournalTypes';
import type {
  ApplyReviewDiskTransition,
  ApplyReviewResult,
  FileReviewDecision,
  ReviewMutationDiskPostimage,
  ReviewPersistedStateSnapshot,
} from '@shared/types/review';

export function assertPersistedStateIncludesDecisions(
  state: ReviewPersistedStateSnapshot,
  decisions: readonly FileReviewDecision[]
): void {
  for (const decision of decisions) {
    const reviewKey = decision.reviewKey;
    if (!reviewKey) throw new Error('Durable review mutation requires a stable reviewKey');
    const actualFileDecision =
      state.fileDecisions[reviewKey] ?? state.fileDecisions[decision.filePath] ?? 'pending';
    if (actualFileDecision !== decision.fileDecision) {
      throw new Error('Durable review state does not match the requested file decision');
    }
    for (const [index, expected] of Object.entries(decision.hunkDecisions)) {
      const actual =
        state.hunkDecisions[`${reviewKey}:${index}`] ??
        state.hunkDecisions[`${decision.filePath}:${index}`] ??
        'pending';
      if (actual !== expected) {
        throw new Error('Durable review state does not match the requested hunk decision');
      }
    }
  }
}

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
  postimages: readonly ReviewMutationDiskPostimage[],
  normalizePath: (filePath: string) => string
): void {
  for (const postimage of postimages) {
    target.set(normalizePath(postimage.filePath), postimage);
  }
}

export function composeReviewDiskTransitions(
  existing: readonly ReviewMutationJournalPathTransition[],
  next: readonly ApplyReviewDiskTransition[],
  normalizePath: (filePath: string) => string,
  mergeText: (
    base: string,
    current: string,
    incoming: string
  ) => { content: string; hasConflicts: boolean }
): ReviewMutationJournalPathTransition[] {
  const composed = new Map(
    existing.map((transition) => [normalizePath(transition.filePath), transition])
  );
  for (const transition of next) {
    const key = normalizePath(transition.filePath);
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
    const merged = mergeText(
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
