export const REVIEW_MUTATION_PHASES = [
  'prepared',
  'disk_applied',
  'decisions_committed',
  'complete',
] as const;

export type ReviewMutationPhase = (typeof REVIEW_MUTATION_PHASES)[number];

export const REVIEW_MUTATION_KINDS = [
  'reject',
  'restore',
  'rename',
  'bulk',
  'undo',
  'redo',
  'reload-external',
  'restore-history',
] as const;

export type ReviewMutationKind = (typeof REVIEW_MUTATION_KINDS)[number];

export interface PhasedReviewMutation {
  id: string;
  phase: ReviewMutationPhase;
}

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
