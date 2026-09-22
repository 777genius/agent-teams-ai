import { ReviewHistoryMutationApplication } from '../application/ReviewHistoryMutationApplication';

import type { ReviewHistoryMutationDependencies } from '../application/ReviewHistoryMutationPorts';

export type ReviewHistoryMutationFeatureDependencies = ReviewHistoryMutationDependencies;

export function createReviewHistoryMutationFeature(
  dependencies: ReviewHistoryMutationFeatureDependencies
): ReviewHistoryMutationApplication {
  return new ReviewHistoryMutationApplication(dependencies);
}
