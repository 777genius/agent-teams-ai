import { ReviewDecisionPersistenceApplication } from '../application/ReviewDecisionPersistenceApplication';

import type { ReviewDecisionPersistenceDependencies } from '../application/ReviewDecisionPersistencePorts';

export type ReviewDecisionPersistenceFeatureDependencies = ReviewDecisionPersistenceDependencies;

export function createReviewDecisionPersistenceFeature(
  dependencies: ReviewDecisionPersistenceFeatureDependencies
): ReviewDecisionPersistenceApplication {
  return new ReviewDecisionPersistenceApplication(dependencies);
}
