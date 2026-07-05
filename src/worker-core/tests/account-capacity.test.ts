import { describe, expect, it } from "vitest";
import {
  AccountCapacityAwareWorker,
  BoundedSubscriptionWorkerPool,
  InMemoryWorkerAccountCapacityStore,
  accountCapacityAwareWorkerFactory,
  type SubscriptionWorker,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerState,
  type WorkerCapacitySnapshot,
} from "../index";

describe("AccountCapacityAwareWorker", () => {
  it("propagates provider-neutral account cooldown to sibling workers", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    const first = accountAware(
      new FakeWorker("worker-a1", "a1", {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
        details: { quotaGroup: "claude-oauth:account-a" },
      }),
      store,
      clock,
    );
    const second = accountAware(
      new FakeWorker("worker-a2", "a2", {
        availability: "available",
        details: { quotaGroup: "claude-oauth:account-a" },
      }),
      store,
      clock,
    );

    expect(first.capacity()).toMatchObject({
      availability: "cooldown",
      reason: "rate_limit_threshold",
      details: {
        accountId: "claude-oauth:account-a",
      },
    });
    expect(second.capacity()).toMatchObject({
      availability: "cooldown",
      reason: "rate_limit_threshold",
      cooldownUntil: resetAt,
      details: {
        accountId: "claude-oauth:account-a",
        sourceWorkerId: "worker-a1",
      },
    });
  });

  it("expires account cooldown at reset time", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    const worker = accountAware(
      new FakeWorker("worker-a", "a", {
        availability: "available",
        details: { accountId: "account-a" },
      }),
      store,
      clock,
    );
    store.observe({
      accountId: "account-a",
      observedAt: clock.now(),
      sourceWorkerId: "limit-source",
      capacity: {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
      },
    });

    expect(worker.capacity()).toMatchObject({
      availability: "cooldown",
      cooldownUntil: resetAt,
    });
    clock.advanceMs(60 * 60 * 1000 + 1);
    expect(worker.capacity()).toMatchObject({
      availability: "available",
    });
  });

  it("normalizes account ids from explicit config and capacity details", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    const first = new AccountCapacityAwareWorker({
      worker: new FakeWorker("worker-a1", "a1", {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
      }),
      accountCapacityStore: store,
      accountId: " account-a ",
      clock,
    });
    const second = accountAware(
      new FakeWorker("worker-a2", "a2", {
        availability: "available",
        details: { accountId: "account-a" },
      }),
      store,
      clock,
    );

    expect(first.capacity()).toMatchObject({
      details: { accountId: "account-a" },
    });
    expect(second.capacity()).toMatchObject({
      availability: "cooldown",
      details: { accountId: "account-a" },
    });
  });

  it("normalizes account ids at the shared capacity store boundary", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();

    store.observe({
      accountId: " account-a ",
      observedAt: clock.now(),
      sourceWorkerId: "limit-source",
      capacity: {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
      },
    });

    expect(store.read({ accountId: "account-a", now: clock.now() })).toMatchObject({
      availability: "cooldown",
      details: { accountId: "account-a" },
    });
    store.clear({ accountId: " account-a " });
    expect(store.read({ accountId: "account-a", now: clock.now() })).toBeNull();
  });

  it("keeps account capacity scoped to runtime demand", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();

    store.observe({
      accountId: "account-a",
      observedAt: clock.now(),
      demand: {
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: "fast",
      },
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: resetAt,
      },
    });

    expect(
      store.read({
        accountId: "account-a",
        now: clock.now(),
        demand: {
          provider: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
        },
      }),
    ).toMatchObject({
      availability: "quota_exhausted",
      cooldownUntil: resetAt,
    });
    expect(
      store.read({
        accountId: "account-a",
        now: clock.now(),
        demand: {
          provider: "codex",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
        },
      }),
    ).toBeNull();
  });

  it("does not propagate a demand-specific limit to the same account on another demand", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    const high = accountAware(
      new FakeWorker("worker-high", "high", {
        availability: "cooldown",
        reason: "quota_limited",
        cooldownUntil: resetAt,
        details: codexDemandDetails("account-a", "high"),
      }),
      store,
      clock,
    );
    const xhigh = accountAware(
      new FakeWorker("worker-xhigh", "xhigh", {
        availability: "available",
        details: codexDemandDetails("account-a", "xhigh"),
      }),
      store,
      clock,
    );

    expect(high.capacity()).toMatchObject({
      availability: "cooldown",
      reason: "quota_limited",
      details: {
        accountId: "account-a",
        capacityReasoningEffort: "high",
      },
    });
    expect(xhigh.capacity()).toMatchObject({
      availability: "available",
      details: {
        accountId: "account-a",
        capacityReasoningEffort: "xhigh",
      },
    });
  });

  it("replaces same-severity account limits when the next signal adds a reset time", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();

    store.observe({
      accountId: "account-a",
      observedAt: clock.now(),
      capacity: {
        availability: "quota_exhausted",
      },
    });
    store.observe({
      accountId: "account-a",
      observedAt: clock.now(),
      capacity: {
        availability: "quota_exhausted",
        cooldownUntil: resetAt,
      },
    });

    expect(store.read({ accountId: "account-a", now: clock.now() })).toMatchObject({
      availability: "quota_exhausted",
      cooldownUntil: resetAt,
    });
    clock.advanceMs(60 * 60 * 1000 + 1);
    expect(store.read({ accountId: "account-a", now: clock.now() })).toBeNull();
  });

  it("rejects direct runs before delegating when the account is unavailable", async () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "account-a",
      observedAt: clock.now(),
      sourceWorkerId: "limit-source",
      capacity: {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
      },
    });
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    const worker = accountAware(inner, store, clock);

    await expect(worker.run("must-not-run")).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
      details: {
        accountId: "account-a",
        availability: "cooldown",
        reason: "rate_limit_threshold",
      },
    });
    expect(inner.runCount).toBe(0);
  });

  it("allows direct runs after the worker cooldown has expired", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "cooldown",
      reason: "rate_limit_threshold",
      cooldownUntil: resetAt,
      lastLimitSignalAt: new Date("2026-06-01T00:30:00.000Z"),
      details: { accountId: "account-a" },
    });
    const worker = accountAware(inner, store, clock);

    const capacity = worker.capacity();
    expect(capacity).toMatchObject({
      availability: "available",
      details: { accountId: "account-a" },
    });
    expect(capacity).not.toHaveProperty("reason");
    expect(capacity).not.toHaveProperty("cooldownUntil");
    expect(capacity).not.toHaveProperty("lastLimitSignalAt");
    await expect(worker.run("after-reset")).resolves.toBe("a:after-reset");
    expect(inner.runCount).toBe(1);
  });

  it("allows direct runs after resettable worker quota exhaustion has expired", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "quota_exhausted",
      reason: "quota_limited",
      cooldownUntil: resetAt,
      lastLimitSignalAt: new Date("2026-06-01T00:00:00.000Z"),
      details: { accountId: "account-a" },
    });
    const worker = accountAware(inner, store, clock);

    const capacity = worker.capacity();
    expect(capacity).toMatchObject({
      availability: "available",
      details: { accountId: "account-a" },
    });
    expect(capacity).not.toHaveProperty("reason");
    expect(capacity).not.toHaveProperty("cooldownUntil");
    expect(capacity).not.toHaveProperty("lastLimitSignalAt");
    await expect(worker.run("after-quota-reset")).resolves.toBe(
      "a:after-quota-reset",
    );
    expect(inner.runCount).toBe(1);
  });

  it("keeps a longer same-severity account quota reset over worker-local quota reset", () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const workerResetAt = new Date("2026-06-01T00:30:00.000Z");
    const accountResetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "account-a",
      observedAt: clock.now(),
      sourceWorkerId: "worker-b",
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: accountResetAt,
      },
    });
    const worker = accountAware(
      new FakeWorker("worker-a", "a", {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: workerResetAt,
        details: { accountId: "account-a" },
      }),
      store,
      clock,
    );

    expect(worker.capacity()).toMatchObject({
      availability: "quota_exhausted",
      reason: "quota_limited",
      cooldownUntil: accountResetAt,
      details: {
        accountId: "account-a",
        sourceWorkerId: "worker-b",
      },
    });
  });

  it("lets the generic pool pick a standby worker from another account", async () => {
    const clock = new MutableClock(new Date());
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);
    const store = new InMemoryWorkerAccountCapacityStore();
    const capacities: WorkerCapacitySnapshot[] = [
      {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
        details: { accountId: "account-a" },
      },
      {
        availability: "available",
        details: { accountId: "account-a" },
      },
      {
        availability: "available",
        details: { accountId: "account-b" },
      },
    ];
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "account-aware",
      slots: 3,
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore: store,
        clock,
        workerFactory: ({ slotIndex, workerId }) =>
          new FakeWorker(
            workerId,
            `slot-${slotIndex + 1}`,
            capacities[slotIndex],
          ),
      }),
    });

    await pool.start();
    await expect(pool.run("review")).resolves.toBe("slot-3:review");
    await pool.dispose();
  });
});

function accountAware(
  worker: FakeWorker,
  accountCapacityStore: InMemoryWorkerAccountCapacityStore,
  clock: MutableClock,
): AccountCapacityAwareWorker<string, string> {
  return new AccountCapacityAwareWorker({
    worker,
    accountCapacityStore,
    clock,
  });
}

class FakeWorker implements SubscriptionWorker<string, string> {
  state: SubscriptionWorkerState = "created";
  runCount = 0;

  constructor(
    readonly workerId: string,
    private readonly resultPrefix: string,
    readonly capacitySnapshot: WorkerCapacitySnapshot | undefined,
  ) {}

  async start(): Promise<void> {
    this.state = "started";
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.state = "ready";
    return {
      status: "ready",
      warmedAt: new Date(),
      warnings: [],
    };
  }

  async run(job: string): Promise<string> {
    this.runCount += 1;
    return `${this.resultPrefix}:${job}`;
  }

  async health() {
    return {
      status: "healthy" as const,
      state: this.state,
      checkedAt: new Date(),
      warnings: [],
    };
  }

  capacity(): WorkerCapacitySnapshot {
    return this.capacitySnapshot ?? { availability: "available" };
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
  }
}

class MutableClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function codexDemandDetails(
  accountId: string,
  reasoningEffort: string,
): Readonly<Record<string, string>> {
  return {
    accountId,
    capacityProvider: "codex",
    capacityModel: "gpt-5.5",
    capacityReasoningEffort: reasoningEffort,
    capacityServiceTier: "fast",
  };
}
