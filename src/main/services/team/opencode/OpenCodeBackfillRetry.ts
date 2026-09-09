interface BackfillAttempt {
  attempted: boolean;
  backfilled: boolean;
}

/** Private, request-driven backoff. Cached failures never stand in for task evidence. */
export class OpenCodeBackfillRetry {
  private readonly failures = new Map<string, { scope: string; count: number; retryAt: number }>();
  private readonly inFlight = new Map<string, Promise<BackfillAttempt>>();

  reset(scope: string): void {
    for (const [key, failure] of this.failures) {
      if (failure.scope === scope) this.failures.delete(key);
    }
  }

  run(
    scope: string,
    key: string,
    attempt: () => Promise<BackfillAttempt>
  ): Promise<BackfillAttempt> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const failure = this.failures.get(key);
    if (failure && Date.now() < failure.retryAt) {
      return Promise.resolve({ attempted: false, backfilled: false });
    }
    const recordFailure = (): void => {
      const count = Math.min((failure?.count ?? 0) + 1, 5);
      this.failures.delete(key);
      this.failures.set(key, {
        scope,
        count,
        retryAt: Date.now() + Math.min(5_000 * 2 ** (count - 1), 60_000),
      });
      // Bound inactive task/evidence identities, while preserving in-flight deduplication.
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
    };
    const promise = Promise.resolve()
      .then(attempt)
      .then(
        (result) => {
          if (result.backfilled) this.reset(scope);
          else recordFailure();
          return result;
        },
        (error: unknown) => {
          recordFailure();
          throw error;
        }
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
