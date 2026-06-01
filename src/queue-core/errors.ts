export type SubscriptionQueueErrorCode =
  | "subscription_queue_closed"
  | "subscription_queue_duplicate"
  | "subscription_queue_job_not_found"
  | "subscription_queue_invalid_retry_policy"
  | "subscription_queue_processor_not_started";

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
