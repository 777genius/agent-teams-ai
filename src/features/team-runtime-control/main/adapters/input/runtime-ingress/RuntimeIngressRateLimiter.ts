export interface RuntimeIngressRateLimitPolicy {
  readonly globalRequestsPerWindow: number;
  readonly credentialRequestsPerWindow: number;
  readonly windowMs: number;
  readonly maxCredentialBuckets: number;
}

export interface RuntimeIngressRateLimitDecision {
  readonly admitted: boolean;
  readonly retryAfterSeconds: number;
}

interface RateBucket {
  count: number;
  windowStartedAtMs: number;
  lastSeenAtMs: number;
}

const DEFAULT_POLICY: RuntimeIngressRateLimitPolicy = Object.freeze({
  globalRequestsPerWindow: 200,
  credentialRequestsPerWindow: 30,
  windowMs: 1_000,
  maxCredentialBuckets: 1_024,
});

/**
 * A bounded in-memory admission fence. Verified credential IDs, not caller
 * IPs, select per-lane buckets; a separate global bucket bounds forged churn.
 */
export class RuntimeIngressRateLimiter {
  private readonly credentialBuckets = new Map<string, RateBucket>();
  private globalBucket: RateBucket | undefined;

  constructor(
    private readonly nowEpochMs: () => number,
    private readonly policy: RuntimeIngressRateLimitPolicy = DEFAULT_POLICY
  ) {
    assertPolicy(policy);
  }

  admitGlobal(): RuntimeIngressRateLimitDecision {
    const now = this.nowEpochMs();
    if (!Number.isFinite(now)) return { admitted: false, retryAfterSeconds: 1 };

    const global = this.consume(this.globalBucket, now, this.policy.globalRequestsPerWindow);
    this.globalBucket = global.bucket;
    return global;
  }

  admitCredential(credentialId: string): RuntimeIngressRateLimitDecision {
    const now = this.nowEpochMs();
    if (!Number.isFinite(now)) return { admitted: false, retryAfterSeconds: 1 };
    const bucket = this.credentialBuckets.get(credentialId);
    if (!bucket && this.credentialBuckets.size >= this.policy.maxCredentialBuckets) {
      this.evictOldestCredentialBucket();
    }
    const credential = this.consume(bucket, now, this.policy.credentialRequestsPerWindow);
    this.credentialBuckets.delete(credentialId);
    this.credentialBuckets.set(credentialId, credential.bucket);
    return credential;
  }

  private consume(
    current: RateBucket | undefined,
    now: number,
    limit: number
  ): RuntimeIngressRateLimitDecision & { readonly bucket: RateBucket } {
    const bucket =
      !current ||
      now < current.windowStartedAtMs ||
      now - current.windowStartedAtMs >= this.policy.windowMs
        ? { count: 0, windowStartedAtMs: now, lastSeenAtMs: now }
        : current;
    bucket.lastSeenAtMs = now;
    if (bucket.count >= limit) {
      return {
        admitted: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.windowStartedAtMs + this.policy.windowMs - now) / 1_000)
        ),
        bucket,
      };
    }
    bucket.count += 1;
    return { admitted: true, retryAfterSeconds: 0, bucket };
  }

  private evictOldestCredentialBucket(): void {
    let oldestKey: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.credentialBuckets) {
      if (bucket.lastSeenAtMs < oldestSeen) {
        oldestKey = key;
        oldestSeen = bucket.lastSeenAtMs;
      }
    }
    if (oldestKey !== undefined) this.credentialBuckets.delete(oldestKey);
  }
}

function assertPolicy(policy: RuntimeIngressRateLimitPolicy): void {
  for (const value of [
    policy.globalRequestsPerWindow,
    policy.credentialRequestsPerWindow,
    policy.windowMs,
    policy.maxCredentialBuckets,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('runtime-ingress-rate-limit-policy-invalid');
    }
  }
}
