import type { SubscriptionQueueEnqueueInput } from "@777genius/subscription-runtime/queue-core";
declare const envelopeMarker = "__subscriptionRuntime";
declare const envelopeVersion = 1;
type BullSubscriptionRuntimeEnvelope<Job> = {
    readonly [envelopeMarker]: {
        readonly version: typeof envelopeVersion;
        readonly job: Job;
        readonly idempotencyKey: string;
    };
};
export type DecodedBullSubscriptionRuntimeJob<Job> = {
    readonly job: Job;
    readonly idempotencyKey?: string;
    readonly isEnvelope: boolean;
};
export declare function encodeBullSubscriptionRuntimeJob<Job>(input: SubscriptionQueueEnqueueInput<Job>): Job | BullSubscriptionRuntimeEnvelope<Job>;
export declare function decodeBullSubscriptionRuntimeJob<Job>(data: Job): DecodedBullSubscriptionRuntimeJob<Job>;
export {};
//# sourceMappingURL=bull-runtime-envelope.d.ts.map