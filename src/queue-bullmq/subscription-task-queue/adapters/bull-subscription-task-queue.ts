import {
  SubscriptionQueueEnqueueStatus,
  type SubscriptionQueueEnqueueInput,
  type SubscriptionQueueEnqueueResult,
  type SubscriptionRetryPolicy,
} from "@vioxen/subscription-runtime/queue-core";
import {
  buildBullSubscriptionQueueAddRequest,
  defaultBullSubscriptionTaskJobName,
} from "../domain";
import type { BullLikeQueue } from "../../shared";

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
    const request = buildBullSubscriptionQueueAddRequest({
      input,
      jobName: this.options.jobName ?? defaultBullSubscriptionTaskJobName,
      ...(this.options.retryPolicy
        ? { retryPolicy: this.options.retryPolicy }
        : {}),
      ...(this.options.removeOnComplete !== undefined
        ? { removeOnComplete: this.options.removeOnComplete }
        : {}),
      ...(this.options.removeOnFail !== undefined
        ? { removeOnFail: this.options.removeOnFail }
        : {}),
    });
    const job = await this.options.queue.add(
      request.name,
      request.data as Job,
      request.options,
    );
    return {
      status: SubscriptionQueueEnqueueStatus.Accepted,
      taskId: String(job.id ?? request.options.jobId ?? ""),
    };
  }

  async size(): Promise<number | null> {
    return this.options.queue.count ? this.options.queue.count() : null;
  }
}
