import type { SubscriptionQueueClaim, SubscriptionQueueEnqueueInput, SubscriptionQueueEnqueueResult, SubscriptionQueueFailResult, SubscriptionRetryPolicy, SubscriptionTaskQueuePort } from "./types";
export declare class InMemorySubscriptionTaskQueue<Job, Result = unknown> implements SubscriptionTaskQueuePort<Job, Result> {
    readonly queueId: string;
    private readonly records;
    private readonly idempotency;
    private closed;
    constructor(options: {
        readonly queueId: string;
    });
    enqueue(input: SubscriptionQueueEnqueueInput<Job>): Promise<SubscriptionQueueEnqueueResult>;
    claim(input: {
        readonly leaseTtlMs: number;
        readonly now?: Date;
    }): Promise<SubscriptionQueueClaim<Job> | null>;
    complete(input: {
        readonly taskId: string;
        readonly leaseId: string;
        readonly result: Result;
    }): Promise<void>;
    release(input: {
        readonly taskId: string;
        readonly leaseId: string;
    }): Promise<void>;
    fail(input: {
        readonly taskId: string;
        readonly leaseId: string;
        readonly error: unknown;
        readonly retryPolicy: SubscriptionRetryPolicy;
        readonly now?: Date;
    }): Promise<SubscriptionQueueFailResult>;
    size(input?: {
        readonly includeDelayed?: boolean;
    }): Promise<number>;
    close(): void;
    private requireLeased;
    private assertOpen;
}
//# sourceMappingURL=in-memory-task-queue.d.ts.map