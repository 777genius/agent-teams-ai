import type { ReviewMutationPhase } from '../../contracts';

const NEXT_PHASE: Readonly<Partial<Record<ReviewMutationPhase, ReviewMutationPhase>>> = {
  prepared: 'disk_applied',
  disk_applied: 'decisions_committed',
  decisions_committed: 'complete',
};

export function getNextReviewMutationPhase(phase: ReviewMutationPhase): ReviewMutationPhase | null {
  return NEXT_PHASE[phase] ?? null;
}

export function assertReviewMutationTransition(
  current: ReviewMutationPhase,
  next: ReviewMutationPhase
): void {
  if (getNextReviewMutationPhase(current) !== next) {
    throw new Error(`Invalid review mutation phase transition: ${current} -> ${next}`);
  }
}
