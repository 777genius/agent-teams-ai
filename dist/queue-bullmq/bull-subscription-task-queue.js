import { encodeBullSubscriptionRuntimeJob } from "./bull-runtime-envelope.js";
export class BullSubscriptionTaskQueue {
    options;
    constructor(options) {
        this.options = options;
    }
    async enqueue(input) {
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
                        type: "exponential",
                        delay: this.options.retryPolicy.baseDelayMs,
                    },
                }
                : {}),
            removeOnComplete: this.options.removeOnComplete ?? true,
            removeOnFail: this.options.removeOnFail ?? false,
        };
        const job = await this.options.queue.add(this.options.jobName ?? "subscription-runtime-task", encodeBullSubscriptionRuntimeJob(input), options);
        return {
            status: "accepted",
            taskId: String(job.id ?? jobId ?? ""),
        };
    }
    async size() {
        return this.options.queue.count ? this.options.queue.count() : null;
    }
}
//# sourceMappingURL=bull-subscription-task-queue.js.map