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
});
