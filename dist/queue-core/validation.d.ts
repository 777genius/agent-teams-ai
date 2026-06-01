import type { SubscriptionRetryPolicy } from "./types";
export declare const defaultSubscriptionRetryPolicy: SubscriptionRetryPolicy;
export declare function assertRetryPolicy(policy: SubscriptionRetryPolicy): void;
export declare function computeBackoffDelayMs(input: {
    readonly attempt: number;
    readonly policy: SubscriptionRetryPolicy;
    readonly random?: () => number;
}): number;
//# sourceMappingURL=validation.d.ts.map