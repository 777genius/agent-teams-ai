import { ReviewQueryApplication } from '../application/ReviewQueryApplication';

import type { ReviewQueryDependencies } from '../application/ReviewQueryPorts';

export function createReviewQueryFeature(
  dependencies: ReviewQueryDependencies
): ReviewQueryApplication {
  return new ReviewQueryApplication(dependencies);
}
