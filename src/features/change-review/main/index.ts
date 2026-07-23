export {
  assertHunkIndices,
  assertNonEmptyString,
  assertOptionalString,
  assertSnippetShapes,
  MAX_REVIEW_HUNK_DECISIONS_PER_FILE,
  MAX_REVIEW_SNIPPETS_PER_FILE,
} from '../core/domain/reviewScopePolicy';
export { ReviewScopeAuthorizationApplication } from './application/ReviewScopeAuthorizationApplication';
export type {
  AuthorizedReviewRoot,
  ReviewPathAuthorization,
  ReviewScopeAuthorizationDependencies,
  ReviewScopeChangesPort,
  ReviewScopeConfigPort,
  ReviewScopeContentPort,
  ReviewScopeFileStat,
  ReviewScopeFileSystemPort,
  ReviewScopePathPort,
} from './application/ReviewScopeAuthorizationPorts';
export {
  createReviewScopeAuthorizationFeature,
  type ReviewScopeAuthorizationFeatureDependencies,
} from './composition/createReviewScopeAuthorizationFeature';
