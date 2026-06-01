export type SubscriptionQueueErrorCode = "subscription_queue_closed" | "subscription_queue_duplicate" | "subscription_queue_job_not_found" | "subscription_queue_invalid_retry_policy" | "subscription_queue_processor_not_started";
export declare class SubscriptionQueueError extends Error {
    readonly code: SubscriptionQueueErrorCode;
    constructor(code: SubscriptionQueueErrorCode, message: string, options?: {
        readonly cause?: unknown;
    });
}
//# sourceMappingURL=errors.d.ts.map