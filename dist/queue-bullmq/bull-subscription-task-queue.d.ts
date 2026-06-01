import type { SubscriptionQueueEnqueueInput, SubscriptionQueueEnqueueResult, SubscriptionRetryPolicy } from "@777genius/subscription-runtime/queue-core";
import type { BullLikeQueue } from "./bull-types";
export type BullSubscriptionTaskQueueOptions<Job> = {
    readonly queue: BullLikeQueue<Job>;
    readonly jobName?: string;
    readonly retryPolicy?: SubscriptionRetryPolicy;
    readonly removeOnComplete?: boolean | number;
    readonly removeOnFail?: boolean | number;
};
export declare class BullSubscriptionTaskQueue<Job> {
    private readonly options;
    constructor(options: BullSubscriptionTaskQueueOptions<Job>);
    enqueue(input: SubscriptionQueueEnqueueInput<Job>): Promise<SubscriptionQueueEnqueueResult>;
    size(): Promise<number | null>;
}
//# sourceMappingURL=bull-subscription-task-queue.d.ts.map