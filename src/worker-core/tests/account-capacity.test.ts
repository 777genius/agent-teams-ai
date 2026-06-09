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
