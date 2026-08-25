import { ReviewDecisionBatchApplication } from '../application/ReviewDecisionBatchApplication';

import type { ReviewDecisionBatchDependencies } from '../application/ReviewMutationRecoveryPorts';

export type ReviewDecisionBatchFeatureDependencies = ReviewDecisionBatchDependencies;

export function createReviewDecisionBatchFeature(
  dependencies: ReviewDecisionBatchFeatureDependencies
): ReviewDecisionBatchApplication {
  return new ReviewDecisionBatchApplication(dependencies);
}
