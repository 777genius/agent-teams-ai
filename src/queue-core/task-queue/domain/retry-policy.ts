import {
  SubscriptionQueueError,
  SubscriptionQueueErrorCodeKind,
} from "./queue-errors";

export type SubscriptionRetryPolicy = {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio?: number;
};

export const defaultSubscriptionRetryPolicy: SubscriptionRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.1,
};

export function assertRetryPolicy(policy: SubscriptionRetryPolicy): void {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    !Number.isFinite(policy.baseDelayMs) ||
    policy.baseDelayMs < 0 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs ||
    (policy.jitterRatio !== undefined &&
      (!Number.isFinite(policy.jitterRatio) ||
        policy.jitterRatio < 0 ||
        policy.jitterRatio > 1))
  ) {
    throw new SubscriptionQueueError(
      SubscriptionQueueErrorCodeKind.InvalidRetryPolicy,
      "Invalid subscription queue retry policy.",
    );
  }
}

export function computeBackoffDelayMs(input: {
  readonly attempt: number;
  readonly policy: SubscriptionRetryPolicy;
  readonly random?: () => number;
}): number {
  assertRetryPolicy(input.policy);
  const exponent = Math.max(0, input.attempt - 1);
  const raw = Math.min(
    input.policy.maxDelayMs,
    input.policy.baseDelayMs * 2 ** exponent,
  );
  const jitterRatio = input.policy.jitterRatio ?? 0;
  if (jitterRatio === 0) return raw;
  const random = input.random?.() ?? Math.random();
  const jitter = raw * jitterRatio * (random * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}
