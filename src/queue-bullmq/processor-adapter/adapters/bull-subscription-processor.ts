import type { BoundedSubscriptionWorkerPool } from "@vioxen/subscription-runtime/worker-core";
import {
  resolveBullSubscriptionProcessorTask,
  type BullSubscriptionProcessorIdempotencyKeyResolver,
  type BullSubscriptionProcessorTaskMapper,
} from "../domain/bull-processor-task";
import type { BullLikeJob } from "../../shared";

export type BullSubscriptionProcessorOptions<Job, Result> = {
  readonly workerPool: Pick<
    BoundedSubscriptionWorkerPool<Job, Result>,
    "run" | "stats"
  >;
  readonly mapJob?: BullSubscriptionProcessorTaskMapper<Job>;
  readonly getIdempotencyKey?: BullSubscriptionProcessorIdempotencyKeyResolver<Job>;
};

export function createBullSubscriptionProcessor<Job, Result>(
  options: BullSubscriptionProcessorOptions<Job, Result>,
): (job: BullLikeJob<Job>) => Promise<Result> {
  return async (job) => {
    const resolved = resolveBullSubscriptionProcessorTask({
      job,
      ...(options.mapJob ? { mapJob: options.mapJob } : {}),
      ...(options.getIdempotencyKey
        ? { getIdempotencyKey: options.getIdempotencyKey }
        : {}),
    });
    return options.workerPool.run(
      resolved.task,
      resolved.idempotencyKey
        ? { idempotencyKey: resolved.idempotencyKey }
        : {},
    );
  };
}
