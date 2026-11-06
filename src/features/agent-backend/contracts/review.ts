import type {
  ReviewCommandLookup,
  ReviewOriginScope,
  ReviewQueryInputMap,
  ReviewQueryValue,
  ReviewWatchAuthorization,
  ReviewWriterResponse,
  ReviewWriterWireRequest,
} from '@agent-teams/task-change-ledger/review-transport';
type QueryPayloads = {
  [M in keyof ReviewQueryInputMap as `review.${M}`]: ReviewQueryInputMap[M];
};
/** Filesystem paths are data; the retained Team handle is the authority for every operation. */
export interface BackendReviewOperationPayloads extends QueryPayloads {
  'review.lookup': { scope: ReviewOriginScope; expected?: ReviewWriterWireRequest };
  'review.invoke': {
    scope: ReviewOriginScope;
    request: ReviewWriterWireRequest;
  };
}
export type BackendReviewOperation = keyof BackendReviewOperationPayloads;
export type BackendReviewWatchAuthorization = ReviewWatchAuthorization;
export type BackendReviewValue = ReviewWriterResponse | ReviewQueryValue | ReviewCommandLookup;
