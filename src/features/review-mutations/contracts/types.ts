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
