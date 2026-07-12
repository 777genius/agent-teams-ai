import { describe, expect, it } from "vitest";
import {
  AccountCapacityAwareWorker,
  BoundedSubscriptionWorkerPool,
  InMemoryWorkerAccountCapacityStore,
  accountCapacityAwareWorkerFactory,
  type CapacityAwareSubscriptionWorker,
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

  it("keeps factory-provided runtime demand scoped by account", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    const highFactory = accountCapacityAwareWorkerFactory({
      accountCapacityStore: store,
      runtimeDemand: {
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: "fast",
      },
      clock: { now: () => now },
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, "high", {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: resetAt,
          details: { accountId: "account-a" },
        }),
    });
    const xhighFactory = accountCapacityAwareWorkerFactory({
      accountCapacityStore: store,
      runtimeDemand: {
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      },
      clock: { now: () => now },
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, "xhigh", {
          availability: "available",
          details: { accountId: "account-a" },
        }),
    });

    const high = highFactory({
      slotIndex: 0,
      workerId: "worker-high",
    }) as CapacityAwareSubscriptionWorker<string, string>;
    await high.start();
    expect(high.capacity()).toMatchObject({
      availability: "quota_exhausted",
    });
    expect(
      store.read({
        accountId: "account-a",
        demand: {
          provider: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
        },
        now,
      }),
    ).toMatchObject({
      availability: "quota_exhausted",
      details: {
        accountId: "account-a",
        capacityReasoningEffort: "high",
      },
    });

    const xhigh = xhighFactory({
      slotIndex: 1,
      workerId: "worker-xhigh",
    }) as CapacityAwareSubscriptionWorker<string, string>;
    await xhigh.start();
    await expect(xhigh.run("second")).resolves.toBe("xhigh:second");
    expect(xhigh.capacity()).toMatchObject({
      availability: "available",
      details: { accountId: "account-a" },
    });
  });
});

describe("AccountCapacityAwareWorker quota rechecks", () => {
  it("rechecks once after reset and runs only when provider reports available", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    let rechecks = 0;
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      clock,
      capacityRechecker: {
        async recheck() {
          rechecks += 1;
          return { availability: "available" };
        },
      },
    });

    await expect(worker.run("after-reset")).resolves.toBe("a:after-reset");
    expect(rechecks).toBe(1);
    expect(inner.runCount).toBe(1);
    expect(store.read({ accountId: "account-a", now: clock.now() })).toBeNull();
  });

  it("extends exact cooldown without calling the provider worker when still limited", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    const nextReset = new Date("2026-06-01T03:00:00.000Z");
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      clock,
      capacityRechecker: {
        async recheck() {
          return {
            availability: "quota_exhausted",
            reason: "quota_limited",
            cooldownUntil: nextReset,
          };
        },
      },
    });

    await expect(worker.run("must-not-run")).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
    });
    expect(inner.runCount).toBe(0);
    expect(store.read({ accountId: "account-a", now: clock.now() })).toMatchObject({
      cooldownUntil: nextReset,
    });
  });

  it("single-flights concurrent post-reset rechecks", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const deferred = new Deferred<WorkerCapacitySnapshot>();
    let rechecks = 0;
    const makeWorker = (id: string) => {
      const inner = new FakeWorker(id, id, {
        availability: "available",
        details: { accountId: "account-a" },
      });
      return {
        inner,
        worker: new AccountCapacityAwareWorker({
          worker: inner,
          accountCapacityStore: store,
          accountId: "account-a",
          clock,
          capacityRechecker: {
            async recheck() {
              rechecks += 1;
              return await deferred.promise;
            },
          },
        }),
      };
    };
    const first = makeWorker("worker-a");
    const second = makeWorker("worker-b");

    const firstRun = first.worker.run("first");
    await Promise.resolve();
    await expect(second.worker.run("second")).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
    });
    deferred.resolve({ availability: "available" });
    await expect(firstRun).resolves.toBe("worker-a:first");
    expect(rechecks).toBe(1);
    expect(second.inner.runCount).toBe(0);
  });

  it("fails closed when a post-reset recheck outlives its claim", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      recheckClaimTtlMs: 1000,
      clock,
      capacityRechecker: {
        async recheck() {
          clock.advanceMs(1001);
          return { availability: "available" };
        },
      },
    });

    await expect(worker.run("must-not-run")).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
      details: expect.objectContaining({ reason: "quota_recheck_unresolved" }),
    });
    expect(inner.runCount).toBe(0);
  });

  it("automatically refines a worker quota failure with live capacity", async () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const store = new InMemoryWorkerAccountCapacityStore();
    const resetAt = new Date("2026-06-01T04:00:00.000Z");
    const inner = new FailingQuotaWorker("worker-a", clock.now());
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      accountWideLimitReasons: ["quota_limited"],
      clock,
      capacityRechecker: {
        async recheck() {
          return {
            availability: "quota_exhausted",
            reason: "quota_limited",
            cooldownUntil: resetAt,
          };
        },
      },
    });

    await expect(worker.run("quota")).rejects.toThrow("quota reached");
    expect(store.read({ accountId: "account-a", now: clock.now() })).toMatchObject({
      availability: "quota_exhausted",
      cooldownUntil: resetAt,
    });
  });

  it("keeps the original worker failure and applies bounded recheck backoff", async () => {
    const clock = new MutableClock(new Date("2026-06-01T00:00:00.000Z"));
    const store = new InMemoryWorkerAccountCapacityStore();
    const worker = new AccountCapacityAwareWorker({
      worker: new FailingQuotaWorker("worker-a", clock.now()),
      accountCapacityStore: store,
      accountId: "account-a",
      accountWideLimitReasons: ["quota_limited"],
      recheckFailureCooldownMs: 30_000,
      clock,
      capacityRechecker: {
        async recheck() {
          throw new Error("observer unavailable");
        },
      },
    });

    await expect(worker.run("quota")).rejects.toThrow("quota reached");
    expect(store.read({ accountId: "account-a", now: clock.now() })).toMatchObject({
      availability: "cooldown",
      reason: "quota_recheck_failed",
      cooldownUntil: new Date("2026-06-01T00:00:30.000Z"),
    });
  });

  it("fails closed when a long recheck returns an already-expired limited snapshot", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      recheckClaimTtlMs: 5 * 60_000,
      clock,
      capacityRechecker: {
        async recheck(input) {
          clock.advanceMs(2 * 60_000);
          return {
            availability: "cooldown",
            reason: "quota_recheck_inconclusive",
            cooldownUntil: new Date(input.now.getTime() + 60_000),
          };
        },
      },
    });

    await expect(worker.run("must-not-run")).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
    });
    expect(inner.runCount).toBe(0);
    expect(store.read({ accountId: "account-a", now: clock.now() })).toMatchObject({
      reason: "quota_recheck_invalid_limited",
      cooldownUntil: new Date("2026-06-01T01:03:00.001Z"),
    });
  });

  it("does not let a stale recheck clear a fresh limit observation", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const deferred = new Deferred<WorkerCapacitySnapshot>();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      clock,
      capacityRechecker: { async recheck() { return deferred.promise; } },
    });
    const run = worker.run("must-not-run");
    await Promise.resolve();
    const freshReset = new Date("2026-06-01T04:00:00.000Z");
    store.observe({
      accountId: "account-a",
      observedAt: clock.now(),
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: freshReset,
      },
    });
    deferred.resolve({ availability: "available" });

    await expect(run).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
    });
    expect(inner.runCount).toBe(0);
    expect(store.read({ accountId: "account-a", now: clock.now() })).toMatchObject({
      availability: "quota_exhausted",
      cooldownUntil: freshReset,
    });
  });

  it("blocks provider prewarm while account quota is unavailable", async () => {
    const clock = new MutableClock(new Date("2026-06-01T00:30:00.000Z"));
    const store = expiredQuotaStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      requireCapacityRecheckWhenDue: true,
      clock,
    });

    await expect(worker.prewarm()).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
    });
    expect(inner.prewarmCount).toBe(0);
  });

  it("fails closed after reset when no provider rechecker is configured", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      requireCapacityRecheckWhenDue: true,
      clock,
    });

    await expect(worker.run("must-not-run")).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
      details: expect.objectContaining({ reason: "quota_recheck_unavailable" }),
    });
    await expect(worker.prewarm()).rejects.toMatchObject({
      code: "subscription_worker_account_unavailable",
    });
    expect(inner.runCount).toBe(0);
    expect(inner.prewarmCount).toBe(0);
  });

  it("rechecks an expired quota before provider prewarm", async () => {
    const clock = new MutableClock(new Date("2026-06-01T01:00:00.001Z"));
    const store = expiredQuotaStore();
    const inner = new FakeWorker("worker-a", "a", {
      availability: "available",
      details: { accountId: "account-a" },
    });
    let rechecks = 0;
    const worker = new AccountCapacityAwareWorker({
      worker: inner,
      accountCapacityStore: store,
      accountId: "account-a",
      clock,
      capacityRechecker: {
        async recheck() {
          rechecks += 1;
          return { availability: "available" };
        },
      },
    });

    await expect(worker.prewarm()).resolves.toMatchObject({ status: "ready" });
    expect(rechecks).toBe(1);
    expect(inner.prewarmCount).toBe(1);
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
  prewarmCount = 0;

  constructor(
    readonly workerId: string,
    private readonly resultPrefix: string,
    readonly capacitySnapshot: WorkerCapacitySnapshot | undefined,
  ) {}

  async start(): Promise<void> {
    this.state = "started";
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.prewarmCount += 1;
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

class FailingQuotaWorker implements SubscriptionWorker<string, string> {
  state: SubscriptionWorkerState = "started";
  private failed = false;
  constructor(
    readonly workerId: string,
    private readonly observedAt: Date,
  ) {}
  async start(): Promise<void> {}
  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    return { status: "ready", warmedAt: this.observedAt, warnings: [] };
  }
  async run(): Promise<string> {
    this.failed = true;
    throw new Error("quota reached");
  }
  async health() {
    return {
      status: "healthy" as const,
      state: this.state,
      checkedAt: this.observedAt,
      warnings: [],
    };
  }
  capacity(): WorkerCapacitySnapshot {
    if (!this.failed) {
      return {
        availability: "available",
        details: { accountId: "account-a" },
      };
    }
    return {
      availability: "quota_exhausted",
      reason: "quota_limited",
      cooldownUntil: new Date(this.observedAt.getTime() + 15 * 60_000),
      lastLimitSignalAt: this.observedAt,
      details: { accountId: "account-a" },
    };
  }
  async dispose(): Promise<void> {
    this.state = "disposed";
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolvePromise = resolve;
    });
  }
  resolve(value: T): void {
    this.resolvePromise(value);
  }
}

function expiredQuotaStore(): InMemoryWorkerAccountCapacityStore {
  const store = new InMemoryWorkerAccountCapacityStore();
  store.observe({
    accountId: "account-a",
    observedAt: new Date("2026-06-01T00:00:00.000Z"),
    capacity: {
      availability: "quota_exhausted",
      reason: "quota_limited",
      cooldownUntil: new Date("2026-06-01T01:00:00.000Z"),
    },
  });
  return store;
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
