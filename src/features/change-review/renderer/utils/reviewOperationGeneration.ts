export interface ReviewOperationScopeToken {
  readonly hydrationKey: string;
  readonly generation: symbol;
}

/** Object identity prevents an A -> B -> A scope transition from reviving stale work. */
export function createReviewOperationScopeToken(hydrationKey: string): ReviewOperationScopeToken {
  return Object.freeze({ hydrationKey, generation: Symbol(hydrationKey) });
}

export function isReviewOperationScopeCurrent(
  current: ReviewOperationScopeToken | null,
  operation: ReviewOperationScopeToken | null
): operation is ReviewOperationScopeToken {
  return current !== null && current === operation;
}
