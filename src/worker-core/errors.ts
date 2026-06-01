export type SubscriptionWorkerErrorCode =
  | "subscription_worker_not_started"
  | "subscription_worker_already_started"
  | "subscription_worker_disposed"
  | "subscription_worker_start_failed"
  | "subscription_worker_prewarm_failed"
  | "subscription_worker_run_failed"
  | "subscription_worker_health_failed"
  | "subscription_worker_shutdown_timeout"
  | "subscription_worker_pool_draining"
  | "subscription_worker_pool_queue_full"
  | "subscription_worker_pool_run_aborted"
  | "subscription_worker_pool_empty"
  | "subscription_worker_pool_slot_busy"
  | "subscription_worker_pool_slot_not_found"
  | "subscription_worker_pool_slot_restart_failed"
  | "subscription_worker_pool_slot_failed";

export class SubscriptionWorkerError extends Error {
  constructor(
    readonly code: SubscriptionWorkerErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SubscriptionWorkerError";
    this.details = options.details ?? {};
  }

  readonly details: Readonly<Record<string, string>>;
}

export function isSubscriptionWorkerError(
  error: unknown,
): error is SubscriptionWorkerError {
  return error instanceof SubscriptionWorkerError;
}
