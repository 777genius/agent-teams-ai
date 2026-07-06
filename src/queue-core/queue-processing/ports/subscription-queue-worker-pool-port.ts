export type SubscriptionQueueWorkerRunOptions = {
  readonly idempotencyKey?: string;
  readonly abortSignal?: AbortSignal;
};

export interface SubscriptionQueueWorkerPoolPort<Job, Result> {
  run(
    job: Job,
    options?: SubscriptionQueueWorkerRunOptions,
  ): Promise<Result>;

  stats(): unknown;
}
