import type {
  SubscriptionQueueEnqueueInput,
  SubscriptionQueueEnqueueResult,
  SubscriptionRetryPolicy,
} from "@vioxen/subscription-runtime/queue-core";
import { encodeBullSubscriptionRuntimeJob } from "./bull-runtime-envelope";
import type { BullLikeQueue } from "./bull-types";

export type BullSubscriptionTaskQueueOptions<Job> = {
  readonly queue: BullLikeQueue<Job>;
  readonly jobName?: string;
  readonly retryPolicy?: SubscriptionRetryPolicy;
  readonly removeOnComplete?: boolean | number;
  readonly removeOnFail?: boolean | number;
};

export class BullSubscriptionTaskQueue<Job> {
  constructor(
    private readonly options: BullSubscriptionTaskQueueOptions<Job>,
  ) {}

  async enqueue(
    input: SubscriptionQueueEnqueueInput<Job>,
  ): Promise<SubscriptionQueueEnqueueResult> {
    const delay = input.runAfter
      ? Math.max(0, input.runAfter.getTime() - Date.now())
      : undefined;
    const jobId = input.taskId ?? input.idempotencyKey;
    const options = {
      ...(jobId ? { jobId } : {}),
      attempts: input.maxAttempts ?? this.options.retryPolicy?.maxAttempts ?? 3,
      ...(delay !== undefined ? { delay } : {}),
      ...(this.options.retryPolicy
        ? {
            backoff: {
              type: "exponential" as const,
              delay: this.options.retryPolicy.baseDelayMs,
            },
          }
        : {}),
      removeOnComplete: this.options.removeOnComplete ?? true,
      removeOnFail: this.options.removeOnFail ?? false,
    };
    const job = await this.options.queue.add(
      this.options.jobName ?? "subscription-runtime-task",
      encodeBullSubscriptionRuntimeJob(input) as Job,
      options,
    );
    return {
      status: "accepted",
      taskId: String(job.id ?? jobId ?? ""),
    };
  }

  async size(): Promise<number | null> {
    return this.options.queue.count ? this.options.queue.count() : null;
  }
}
