import {
  assertRetryPolicy,
  assertSubscriptionQueueEnqueueInput,
  type SubscriptionQueueEnqueueInput,
  type SubscriptionRetryPolicy,
} from "@vioxen/subscription-runtime/queue-core";
import {
  encodeBullSubscriptionRuntimeJob,
  type BullSubscriptionRuntimeJobData,
} from "../../runtime-envelope";
import type { BullLikeQueueAddOptions } from "../../shared";

export const defaultBullSubscriptionTaskJobName =
  "subscription-runtime-task";

export type BullSubscriptionQueueAddRequest<Job> = {
  readonly name: string;
  readonly data: BullSubscriptionRuntimeJobData<Job>;
  readonly options: BullLikeQueueAddOptions;
};

export type BuildBullSubscriptionQueueAddRequestOptions<Job> = {
  readonly input: SubscriptionQueueEnqueueInput<Job>;
  readonly jobName?: string;
  readonly retryPolicy?: SubscriptionRetryPolicy;
  readonly removeOnComplete?: boolean | number;
  readonly removeOnFail?: boolean | number;
  readonly now?: Date;
};

export function buildBullSubscriptionQueueAddRequest<Job>(
  options: BuildBullSubscriptionQueueAddRequestOptions<Job>,
): BullSubscriptionQueueAddRequest<Job> {
  assertSubscriptionQueueEnqueueInput(options.input);
  if (options.retryPolicy) {
    assertRetryPolicy(options.retryPolicy);
  }

  const delay = options.input.runAfter
    ? Math.max(
        0,
        options.input.runAfter.getTime() -
          (options.now ? options.now.getTime() : Date.now()),
      )
    : undefined;
  const jobId = options.input.taskId ?? options.input.idempotencyKey;
  const attempts =
    options.input.maxAttempts ?? options.retryPolicy?.maxAttempts ?? 3;

  return {
    name: options.jobName ?? defaultBullSubscriptionTaskJobName,
    data: encodeBullSubscriptionRuntimeJob(options.input),
    options: {
      ...(jobId ? { jobId } : {}),
      attempts,
      ...(delay !== undefined ? { delay } : {}),
      ...(options.retryPolicy
        ? {
            backoff: {
              type: "exponential" as const,
              delay: options.retryPolicy.baseDelayMs,
            },
          }
        : {}),
      removeOnComplete: options.removeOnComplete ?? true,
      removeOnFail: options.removeOnFail ?? false,
    },
  };
}
