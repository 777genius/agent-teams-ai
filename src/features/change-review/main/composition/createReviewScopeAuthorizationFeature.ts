import { ReviewScopeAuthorizationApplication } from '../application/ReviewScopeAuthorizationApplication';
import {
  nodeReviewScopeFileSystemPort,
  nodeReviewScopePathPort,
} from '../infrastructure/nodeReviewScopeAuthorization';

import type { ReviewScopeAuthorizationDependencies } from '../application/ReviewScopeAuthorizationPorts';

export type ReviewScopeAuthorizationFeatureDependencies = Omit<
  ReviewScopeAuthorizationDependencies,
  'files' | 'paths'
>;

export function createReviewScopeAuthorizationFeature(
  dependencies: ReviewScopeAuthorizationFeatureDependencies
): ReviewScopeAuthorizationApplication {
  return new ReviewScopeAuthorizationApplication({
    ...dependencies,
    files: nodeReviewScopeFileSystemPort,
    paths: nodeReviewScopePathPort,
  });
}
