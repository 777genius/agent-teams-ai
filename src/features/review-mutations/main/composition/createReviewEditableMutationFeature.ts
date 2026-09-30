import { ReviewEditableMutationApplication } from '../application/ReviewEditableMutationApplication';

import type { ReviewEditableMutationDependencies } from '../application/ReviewEditableMutationPorts';

export type ReviewEditableMutationFeatureDependencies = ReviewEditableMutationDependencies;

export function createReviewEditableMutationFeature(
  dependencies: ReviewEditableMutationFeatureDependencies
): ReviewEditableMutationApplication {
  return new ReviewEditableMutationApplication(dependencies);
}
