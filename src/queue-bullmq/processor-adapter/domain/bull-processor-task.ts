import { decodeBullSubscriptionRuntimeJob } from "../../runtime-envelope";
import type { BullLikeJob } from "../../shared";

export type BullSubscriptionProcessorTaskMapper<Job> = (
  job: BullLikeJob<Job>,
) => Job;

export type BullSubscriptionProcessorIdempotencyKeyResolver<Job> = (
  job: BullLikeJob<Job>,
) => string | undefined;

export type ResolveBullSubscriptionProcessorTaskOptions<Job> = {
  readonly job: BullLikeJob<Job>;
  readonly mapJob?: BullSubscriptionProcessorTaskMapper<Job>;
  readonly getIdempotencyKey?: BullSubscriptionProcessorIdempotencyKeyResolver<Job>;
};

export type ResolvedBullSubscriptionProcessorTask<Job> = {
  readonly task: Job;
  readonly idempotencyKey?: string;
};

export function resolveBullSubscriptionProcessorTask<Job>(
  options: ResolveBullSubscriptionProcessorTaskOptions<Job>,
): ResolvedBullSubscriptionProcessorTask<Job> {
  const decoded = decodeBullSubscriptionRuntimeJob(options.job.data);
  const mappedJob = decoded.isEnvelope
    ? {
        ...options.job,
        data: decoded.job,
      }
    : options.job;
  const task = options.mapJob ? options.mapJob(mappedJob) : decoded.job;
  const idempotencyKey =
    options.getIdempotencyKey?.(mappedJob) ??
    decoded.idempotencyKey ??
    (options.job.id === undefined ? undefined : String(options.job.id));

  return idempotencyKey ? { task, idempotencyKey } : { task };
}
