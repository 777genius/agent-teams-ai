import type { SubscriptionWorkerPrewarmResult, SubscriptionWorkerState, WorkerPoolHealth, WorkerPoolOptions, WorkerPoolRestartOptions, WorkerPoolRunOptions, WorkerPoolStats } from "./types";
export declare class BoundedSubscriptionWorkerPool<Job, Result> {
    private readonly options;
    private readonly slots;
    private readonly queue;
    private poolState;
    private completedCount;
    private failedCount;
    private restartedCount;
    private inFlightCount;
    constructor(options: WorkerPoolOptions<Job, Result>);
    get poolId(): string;
    get state(): SubscriptionWorkerState;
    start(): Promise<void>;
    prewarm(): Promise<readonly SubscriptionWorkerPrewarmResult[]>;
    run(job: Job, options?: WorkerPoolRunOptions): Promise<Result>;
    restartSlot(slotIndex: number, options?: WorkerPoolRestartOptions): Promise<void>;
    health(): Promise<WorkerPoolHealth>;
    stats(): WorkerPoolStats;
    dispose(): Promise<void>;
    private runOnSlot;
    private createSlot;
    private drainQueue;
    private assertRunnable;
    private rejectQueued;
    private disposeStartedSlots;
    private emit;
}
//# sourceMappingURL=worker-pool.d.ts.map