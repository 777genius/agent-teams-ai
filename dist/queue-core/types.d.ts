export type SubscriptionTaskStatus = "queued" | "leased" | "completed" | "retry_scheduled" | "dead_lettered";
export type SubscriptionRetryPolicy = {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio?: number;
};
export type SubscriptionQueueTask<Job> = {
    readonly taskId: string;
    readonly job: Job;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly idempotencyKey?: string;
    readonly runAfter: Date;
    readonly createdAt: Date;
    readonly metadata: Readonly<Record<string, string>>;
};
export type SubscriptionQueueClaim<Job> = {
    readonly task: SubscriptionQueueTask<Job>;
    readonly leaseId: string;
    readonly leaseExpiresAt: Date;
};
export type SubscriptionQueueEnqueueInput<Job> = {
    readonly taskId?: string;
    readonly job: Job;
    readonly idempotencyKey?: string;
    readonly runAfter?: Date;
    readonly maxAttempts?: number;
    readonly metadata?: Readonly<Record<string, string>>;
};
export type SubscriptionQueueEnqueueResult = {
    readonly status: "accepted";
    readonly taskId: string;
} | {
    readonly status: "idempotent_replay";
    readonly taskId: string;
};
export type SubscriptionQueueFailResult = {
    readonly status: "retry_scheduled";
    readonly nextAttempt: number;
    readonly runAfter: Date;
} | {
    readonly status: "dead_lettered";
};
export interface SubscriptionTaskQueuePort<Job, Result = unknown> {
    readonly queueId: string;
    enqueue(input: SubscriptionQueueEnqueueInput<Job>): Promise<SubscriptionQueueEnqueueResult>;
    claim(input: {
        readonly leaseTtlMs: number;
        readonly now?: Date;
    }): Promise<SubscriptionQueueClaim<Job> | null>;
    release?(input: {
        readonly taskId: string;
        readonly leaseId: string;
    }): Promise<void>;
    complete(input: {
        readonly taskId: string;
        readonly leaseId: string;
        readonly result: Result;
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
}
export type QueueProcessorState = "created" | "running" | "stopping" | "stopped";
export type QueueProcessorStats = {
    readonly state: QueueProcessorState;
    readonly claimed: number;
    readonly completed: number;
    readonly retried: number;
    readonly deadLettered: number;
    readonly failed: number;
};
//# sourceMappingURL=types.d.ts.map