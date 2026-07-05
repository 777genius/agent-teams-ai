import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerAccountCapacityStore,
  InMemoryWorkerAccountLeaseStore,
  SelectRuntimeAccountUseCase,
  type WorkerRuntimeDemand,
} from "../index";

const demand: WorkerRuntimeDemand = {
  provider: "codex",
  model: "gpt-5.5",
  reasoningEffort: "xhigh",
  serviceTier: "fast",
};

const highDemand: WorkerRuntimeDemand = {
  ...demand,
  reasoningEffort: "high",
};

describe("SelectRuntimeAccountUseCase", () => {
  it("selects and leases the first available account", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const leaseStore = new InMemoryWorkerAccountLeaseStore();

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseStore,
        now,
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-a",
      lease: {
        accountId: "account-a",
        ownerId: "worker-1",
        expiresAt: new Date("2026-06-01T00:01:00.000Z"),
      },
    });
  });

  it("skips a limited account and selects another allowed account", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    capacityStore.observe({
      accountId: "account-a",
      demand,
      observedAt: now,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-06-01T01:00:00.000Z"),
      },
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore,
        leaseStore: new InMemoryWorkerAccountLeaseStore(),
        now,
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-b",
    });
  });

  it("returns a wait plan when all accounts are unavailable", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const resetAt = new Date("2026-06-01T00:30:00.000Z");
    capacityStore.observe({
      accountId: "account-a",
      demand,
      observedAt: now,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: resetAt,
      },
    });

    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    await leaseStore.acquire({
      accountId: "account-b",
      demand,
      ownerId: "other-worker",
      ttlMs: 120_000,
      now,
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore,
        leaseStore,
        now,
      }),
    ).resolves.toMatchObject({
      type: "all_unavailable",
      waitPlan: {
        waitUntil: new Date("2026-06-01T00:02:00.000Z"),
        waitMs: 120_000,
        unavailable: [
          {
            accountId: "account-a",
            reason: "quota_limited",
            waitUntil: resetAt,
          },
          {
            accountId: "account-b",
            reason: "leased",
            waitUntil: new Date("2026-06-01T00:02:00.000Z"),
          },
        ],
      },
    });
  });

  it("rotates after the last selected account", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b", "account-c"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseStore: new InMemoryWorkerAccountLeaseStore(),
        now,
        lastSelectedAccountId: "account-a",
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-b",
    });
  });

  it("ignores expired leases and selects the released account", async () => {
    const now = new Date("2026-06-01T00:02:00.000Z");
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    await leaseStore.acquire({
      accountId: "account-a",
      demand,
      ownerId: "previous-worker",
      ttlMs: 60_000,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseStore,
        now,
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-a",
      lease: {
        ownerId: "worker-1",
      },
    });
  });

  it("scopes leases by runtime demand", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    await leaseStore.acquire({
      accountId: "account-a",
      demand: highDemand,
      ownerId: "high-worker",
      ttlMs: 120_000,
      now,
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand,
        ownerId: "xhigh-worker",
        leaseTtlMs: 60_000,
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseStore,
        now,
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-a",
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand: highDemand,
        ownerId: "another-high-worker",
        leaseTtlMs: 60_000,
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseStore,
        now,
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-b",
    });
  });

  it("does not invent a wait time for quota blockers without reset time", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    capacityStore.observe({
      accountId: "account-a",
      demand,
      observedAt: now,
      capacity: {
        availability: "quota_exhausted",
        reason: "account_exhausted",
      },
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore,
        leaseStore: new InMemoryWorkerAccountLeaseStore(),
        now,
      }),
    ).resolves.toEqual({
      type: "all_unavailable",
      waitPlan: {
        unavailable: [{
          accountId: "account-a",
          reason: "account_exhausted",
        }],
      },
    });
  });

  it("dedupes and trims allowed accounts before selecting", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    capacityStore.observe({
      accountId: "account-a",
      demand,
      observedAt: now,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-06-01T01:00:00.000Z"),
      },
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: [" account-a ", "account-a", "", " account-b "],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore,
        leaseStore: new InMemoryWorkerAccountLeaseStore(),
        now,
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-b",
    });
  });

  it("selects the next rotated account when the immediate candidate is limited", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    capacityStore.observe({
      accountId: "account-b",
      demand,
      observedAt: now,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-06-01T00:30:00.000Z"),
      },
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b", "account-c"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore,
        leaseStore: new InMemoryWorkerAccountLeaseStore(),
        now,
        lastSelectedAccountId: "account-a",
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-c",
    });
  });

  it("selects a released lease before waiting for a limited account", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    capacityStore.observe({
      accountId: "account-a",
      demand,
      observedAt: now,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-06-01T01:00:00.000Z"),
      },
    });
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const lease = await leaseStore.acquire({
      accountId: "account-b",
      demand,
      ownerId: "previous-worker",
      ttlMs: 120_000,
      now,
    });
    if (lease.status !== "granted") throw new Error("lease_not_granted");
    await leaseStore.release({
      leaseId: lease.lease.leaseId,
      ownerId: "previous-worker",
      reason: "completed",
      now,
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore,
        leaseStore,
        now,
      }),
    ).resolves.toMatchObject({
      type: "selected",
      accountId: "account-b",
    });
  });

  it("waits until the earliest resettable account limit", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const earlyReset = new Date("2026-06-01T00:10:00.000Z");
    const lateReset = new Date("2026-06-01T00:30:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    capacityStore.observe({
      accountId: "account-a",
      demand,
      observedAt: now,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: lateReset,
      },
    });
    capacityStore.observe({
      accountId: "account-b",
      demand,
      observedAt: now,
      capacity: {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: earlyReset,
      },
    });

    await expect(
      new SelectRuntimeAccountUseCase().execute({
        allowedAccounts: ["account-a", "account-b"],
        demand,
        ownerId: "worker-1",
        leaseTtlMs: 60_000,
        capacityStore,
        leaseStore: new InMemoryWorkerAccountLeaseStore(),
        now,
      }),
    ).resolves.toMatchObject({
      type: "all_unavailable",
      waitPlan: {
        waitUntil: earlyReset,
        waitMs: 600_000,
      },
    });
  });
});
