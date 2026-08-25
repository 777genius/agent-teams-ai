import { ReviewDecisionCommandApplication } from '../application/ReviewDecisionCommandApplication';
import { nodeReviewDecisionCommandSnapshotIdentity } from '../infrastructure/nodeReviewDecisionCommandSnapshotIdentity';

import type { ReviewDecisionCommandDependencies } from '../application/ReviewDecisionCommandPorts';

export type ReviewDecisionCommandFeatureDependencies = Omit<
  ReviewDecisionCommandDependencies,
  'snapshots'
>;

export function createReviewDecisionCommandFeature(
  dependencies: ReviewDecisionCommandFeatureDependencies
): ReviewDecisionCommandApplication {
  return new ReviewDecisionCommandApplication({
    ...dependencies,
    snapshots: nodeReviewDecisionCommandSnapshotIdentity,
  });
}
