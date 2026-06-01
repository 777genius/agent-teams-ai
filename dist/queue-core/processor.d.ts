import type { BoundedSubscriptionWorkerPool } from "@777genius/subscription-runtime/worker-core";
import type { QueueProcessorState, QueueProcessorStats, SubscriptionRetryPolicy, SubscriptionTaskQueuePort } from "./types";
export type SubscriptionQueueProcessorOptions<Job, Result> = {
    readonly queue: SubscriptionTaskQueuePort<Job, Result>;
    readonly workerPool: Pick<BoundedSubscriptionWorkerPool<Job, Result>, "run" | "stats">;
    readonly retryPolicy?: SubscriptionRetryPolicy;
    readonly leaseTtlMs?: number;
    readonly idleDelayMs?: number;
    readonly shutdownGraceMs?: number;
    readonly abortSignal?: AbortSignal;
};
export declare class SubscriptionQueueProcessor<Job, Result> {
    private readonly options;
    private processorState;
    private loop;
    private stopController;
    private currentTaskController;
    private shutdownGraceTimer;
    private readonly counters;
    constructor(options: SubscriptionQueueProcessorOptions<Job, Result>);
    get state(): QueueProcessorState;
    start(): void;
    stop(): Promise<void>;
    stats(): QueueProcessorStats;
    private runLoop;
    private releaseClaim;
    private armCurrentTaskShutdownGrace;
    private clearShutdownGraceTimer;
}
//# sourceMappingURL=processor.d.ts.map