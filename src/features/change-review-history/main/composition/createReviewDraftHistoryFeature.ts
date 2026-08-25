import { ReviewDraftHistoryApplication } from '../../core/application/ReviewDraftHistoryApplication';
import { ReviewDraftHistoryStore } from '../infrastructure/ReviewDraftHistoryStore';

import type {
  ReviewDraftHistoryAuthorizationPort,
  ReviewDraftHistoryPersistenceLockPort,
} from '../../core/application/ports';

export interface ReviewDraftHistoryFeatureDependencies {
  lock: ReviewDraftHistoryPersistenceLockPort;
  authorization: ReviewDraftHistoryAuthorizationPort;
}

export function createReviewDraftHistoryFeature(
  dependencies: ReviewDraftHistoryFeatureDependencies
): ReviewDraftHistoryApplication {
  const store = new ReviewDraftHistoryStore();
  return new ReviewDraftHistoryApplication({
    ...dependencies,
    queries: store,
    conflictMutations: store,
    entryMutations: store,
  });
}
