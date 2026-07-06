import type {
  SubscriptionQueueClaim,
  SubscriptionQueueEnqueueInput,
  SubscriptionQueueEnqueueResult,
  SubscriptionQueueFailResult,
  SubscriptionRetryPolicy,
} from "../domain";

export interface SubscriptionTaskQueuePort<Job, Result = unknown> {
  readonly queueId: string;

  enqueue(
    input: SubscriptionQueueEnqueueInput<Job>,
  ): Promise<SubscriptionQueueEnqueueResult>;

  claim(input: {
    readonly leaseTtlMs: number;
    readonly now?: Date;
  }): Promise<SubscriptionQueueClaim<Job> | null>;

  release?(input: {
    readonly taskId: string;
    readonly leaseId: string;
  }): Promise<void>;

  complete(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly result: Result;
  }): Promise<void>;

  fail(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly error: unknown;
    readonly retryPolicy: SubscriptionRetryPolicy;
    readonly now?: Date;
  }): Promise<SubscriptionQueueFailResult>;

  size(input?: { readonly includeDelayed?: boolean }): Promise<number>;
}
