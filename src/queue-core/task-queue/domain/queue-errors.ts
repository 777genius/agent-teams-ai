export enum SubscriptionQueueErrorCodeKind {
  Closed = "subscription_queue_closed",
  Duplicate = "subscription_queue_duplicate",
  JobNotFound = "subscription_queue_job_not_found",
  InvalidRetryPolicy = "subscription_queue_invalid_retry_policy",
  ProcessorNotStarted = "subscription_queue_processor_not_started",
}

export type SubscriptionQueueErrorCode = `${SubscriptionQueueErrorCodeKind}`;

export class SubscriptionQueueError extends Error {
  constructor(
    readonly code: SubscriptionQueueErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SubscriptionQueueError";
  }
}
