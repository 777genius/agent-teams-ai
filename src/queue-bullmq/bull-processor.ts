import type { BoundedSubscriptionWorkerPool } from "@vioxen/subscription-runtime/worker-core";
import { decodeBullSubscriptionRuntimeJob } from "./bull-runtime-envelope";
import type { BullLikeJob } from "./bull-types";

export type BullSubscriptionProcessorOptions<Job, Result> = {
  readonly workerPool: Pick<
    BoundedSubscriptionWorkerPool<Job, Result>,
    "run" | "stats"
  >;
  readonly mapJob?: (job: BullLikeJob<Job>) => Job;
  readonly getIdempotencyKey?: (job: BullLikeJob<Job>) => string | undefined;
};

export function createBullSubscriptionProcessor<Job, Result>(
  options: BullSubscriptionProcessorOptions<Job, Result>,
): (job: BullLikeJob<Job>) => Promise<Result> {
  return async (job) => {
    const decoded = decodeBullSubscriptionRuntimeJob(job.data);
    const mappedJob = decoded.isEnvelope
      ? {
          ...job,
          data: decoded.job,
        }
      : job;
    const task = options.mapJob ? options.mapJob(mappedJob) : decoded.job;
    const idempotencyKey =
      options.getIdempotencyKey?.(mappedJob) ??
      decoded.idempotencyKey ??
      (job.id === undefined ? undefined : String(job.id));
    return options.workerPool.run(
      task,
      idempotencyKey ? { idempotencyKey } : {},
    );
  };
}
