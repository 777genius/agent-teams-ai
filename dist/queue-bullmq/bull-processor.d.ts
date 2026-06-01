import type { BoundedSubscriptionWorkerPool } from "@777genius/subscription-runtime/worker-core";
import type { BullLikeJob } from "./bull-types";
export type BullSubscriptionProcessorOptions<Job, Result> = {
    readonly workerPool: Pick<BoundedSubscriptionWorkerPool<Job, Result>, "run" | "stats">;
    readonly mapJob?: (job: BullLikeJob<Job>) => Job;
    readonly getIdempotencyKey?: (job: BullLikeJob<Job>) => string | undefined;
};
export declare function createBullSubscriptionProcessor<Job, Result>(options: BullSubscriptionProcessorOptions<Job, Result>): (job: BullLikeJob<Job>) => Promise<Result>;
//# sourceMappingURL=bull-processor.d.ts.map