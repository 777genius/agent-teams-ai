import { decodeBullSubscriptionRuntimeJob } from "./bull-runtime-envelope.js";
export function createBullSubscriptionProcessor(options) {
    return async (job) => {
        const decoded = decodeBullSubscriptionRuntimeJob(job.data);
        const mappedJob = decoded.isEnvelope
            ? {
                ...job,
                data: decoded.job,
            }
            : job;
        const task = options.mapJob ? options.mapJob(mappedJob) : decoded.job;
        const idempotencyKey = options.getIdempotencyKey?.(mappedJob) ??
            decoded.idempotencyKey ??
            (job.id === undefined ? undefined : String(job.id));
        return options.workerPool.run(task, idempotencyKey ? { idempotencyKey } : {});
    };
}
//# sourceMappingURL=bull-processor.js.map