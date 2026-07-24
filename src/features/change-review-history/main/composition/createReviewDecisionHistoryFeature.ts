import { ReviewDecisionHistoryApplication } from '../../core/application/ReviewDecisionHistoryApplication';

import type { ReviewDecisionHistoryDependencies } from '../../core/application/ReviewDecisionHistoryPorts';

export function createReviewDecisionHistoryFeature(
  dependencies: ReviewDecisionHistoryDependencies
): ReviewDecisionHistoryApplication {
  return new ReviewDecisionHistoryApplication(dependencies);
}
