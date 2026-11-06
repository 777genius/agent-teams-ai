import {
  assertBoundedReviewValue,
  BOUND_REVIEW_TEAM,
  captureReviewWriterRequest,
  InvalidReviewTransport,
  isReviewQueryMethod,
  parseReviewOriginScope,
  parseReviewQuery,
  parseReviewWriterRequest,
} from '@agent-teams/task-change-ledger/review-transport';

import type {
  BackendReviewOperation,
  BackendReviewOperationPayloads,
} from '../../../contracts/review';

export function isBackendReviewOperation(operation: string): operation is BackendReviewOperation {
  return (
    operation === 'review.invoke' ||
    operation === 'review.lookup' ||
    (operation.startsWith('review.') && isReviewQueryMethod(operation.slice(7)))
  );
}
export function parseBackendReviewPayload(
  operation: BackendReviewOperation,
  value: unknown
): BackendReviewOperationPayloads[BackendReviewOperation] {
  assertBoundedReviewValue(value);
  if (operation === 'review.lookup') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'scope' && key !== 'expected')
    )
      throw new InvalidReviewTransport();
    const row = value as Record<string, unknown>;
    return {
      scope: parseReviewOriginScope(row.scope),
      ...(row.expected === undefined
        ? {}
        : {
            expected: captureReviewWriterRequest(
              parseReviewWriterRequest(row.expected),
              BOUND_REVIEW_TEAM
            ),
          }),
    };
  }
  if (operation === 'review.invoke') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'scope' && key !== 'request')
    )
      throw new InvalidReviewTransport();
    const row = value as Record<string, unknown>;
    return {
      scope: parseReviewOriginScope(row.scope),
      request: captureReviewWriterRequest(parseReviewWriterRequest(row.request), BOUND_REVIEW_TEAM),
    };
  }
  const method = operation.slice(7);
  if (!isReviewQueryMethod(method)) throw new InvalidReviewTransport();
  return parseReviewQuery(method, value);
}
