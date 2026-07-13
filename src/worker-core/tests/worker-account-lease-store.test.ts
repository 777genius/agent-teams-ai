import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerAccountLeaseStore,
  type WorkerRuntimeDemand,
} from "../index";

const demand: WorkerRuntimeDemand = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  serviceTier: "fast",
};

describe("InMemoryWorkerAccountLeaseStore", () => {
  it("treats repeated acquisition by the same owner as idempotent", async () => {
    const store = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T10:00:00.000Z");
    const first = await store.acquire({
      accountId: "account-a",
      demand,
      ownerId: "worker-a",
      ttlMs: 60_000,
      now,
    });
    const replay = await store.acquire({
      accountId: " account-a ",
      demand,
      ownerId: " worker-a ",
      ttlMs: 120_000,
      now: new Date(now.getTime() + 1_000),
    });

    expect(first.status).toBe("granted");
    expect(replay).toEqual(first);
  });

  it("renews only the current unexpired lease", async () => {
    const store = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T10:00:00.000Z");
    const acquired = await store.acquire({
      accountId: "account-a",
      demand,
      ownerId: "worker-a",
      ttlMs: 60_000,
      now,
    });
    if (acquired.status !== "granted") throw new Error("lease_not_granted");

    await expect(store.renew({
      leaseId: acquired.lease.leaseId,
      ownerId: "worker-a",
      ttlMs: 120_000,
      now: new Date(now.getTime() + 30_000),
    })).resolves.toMatchObject({
      status: "renewed",
      lease: { expiresAt: new Date("2026-07-13T10:02:30.000Z") },
    });
    await expect(store.renew({
      leaseId: acquired.lease.leaseId,
      ownerId: "other-worker",
      ttlMs: 60_000,
      now,
    })).resolves.toEqual({
      status: "lost",
      reason: "lease_not_current",
    });
  });

  it("fences replacements from stale release handles", async () => {
    const store = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T10:00:00.000Z");
    const stale = await store.acquire({
      accountId: "account-a",
      demand,
      ownerId: "worker-a",
      ttlMs: 1_000,
      now,
    });
    if (stale.status !== "granted") throw new Error("lease_not_granted");
    const replacement = await store.acquire({
      accountId: "account-a",
      demand,
      ownerId: "worker-b",
      ttlMs: 60_000,
      now: new Date(now.getTime() + 1_000),
    });
    if (replacement.status !== "granted") throw new Error("lease_not_replaced");

    expect(replacement.lease.fencingToken).toBeGreaterThan(
      stale.lease.fencingToken,
    );
    await store.release({
      leaseId: stale.lease.leaseId,
      ownerId: stale.lease.ownerId,
      reason: "stale cleanup",
      now: new Date(now.getTime() + 2_000),
    });
    await expect(store.acquire({
      accountId: "account-a",
      demand,
      ownerId: "worker-c",
      ttlMs: 60_000,
      now: new Date(now.getTime() + 2_000),
    })).resolves.toMatchObject({ status: "denied", reason: "leased" });
  });
});
