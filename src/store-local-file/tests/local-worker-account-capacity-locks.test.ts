import { createHash } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryObservability } from "../../core/testing";
import {
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityMetric,
  WorkerAccountCapacityRecheckMode,
} from "../../worker-core";
import { LocalFileWorkerAccountCapacityStore } from "../index";

describe("Local file worker account capacity locks", () => {
  it("does not count a stale due state that loses the revision CAS", async () => {
    const rootDir = await tempRoot();
    const observability = new MemoryObservability();
    const store = new LocalFileWorkerAccountCapacityStore({
      rootDir,
      observability,
    });
    const dueAt = new Date("2026-06-01T01:00:00.000Z");
    try {
      store.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: dueAt,
        },
      });
      const stale = store.readState({ accountId: "account-a", now: dueAt })!;
      store.observe({
        accountId: "account-a",
        observedAt: dueAt,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-06-01T03:00:00.000Z"),
        },
      });

      expect(store.tryClaimRecheck({
        state: stale,
        ownerId: "stale-worker",
        now: dueAt,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      }).status).toBe(WorkerAccountCapacityClaimStatus.Conflict);
      expect(observability.counts).not.toContainEqual({
        metric: WorkerAccountCapacityMetric.RecheckDue,
        value: 1,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("recovers a record lock left by a dead process", async () => {
    const rootDir = await tempRoot();
    const observability = new MemoryObservability();
    const store = new LocalFileWorkerAccountCapacityStore({
      rootDir,
      observability,
    });
    const firstReset = new Date("2026-06-01T01:00:00.000Z");
    const secondReset = new Date("2026-06-01T02:00:00.000Z");
    try {
      store.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: firstReset,
        },
      });
      await writeFile(
        `${capacityV2RecordPath(rootDir, "account-a")}.capacity-lock`,
        `${JSON.stringify({ token: "dead-owner", pid: 2_147_483_647 })}\n`,
      );

      store.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:01:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: secondReset,
        },
      });
      expect(store.read({
        accountId: "account-a",
        now: new Date("2026-06-01T00:01:00.000Z"),
      })).toMatchObject({ cooldownUntil: secondReset });
      expect(observability.counts).toContainEqual({
        metric: WorkerAccountCapacityMetric.LockRecovery,
        value: 1,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("recovers an old malformed record lock", async () => {
    const rootDir = await tempRoot();
    const observability = new MemoryObservability();
    const store = new LocalFileWorkerAccountCapacityStore({
      rootDir,
      observability,
    });
    try {
      store.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-06-01T01:00:00.000Z"),
        },
      });
      const lockPath = `${capacityV2RecordPath(rootDir, "account-a")}.capacity-lock`;
      await writeFile(lockPath, "{");
      const staleAt = new Date(Date.now() - 5_000);
      await utimes(lockPath, staleAt, staleAt);

      expect(() => store.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:01:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-06-01T02:00:00.000Z"),
        },
      })).not.toThrow();
      expect(observability.counts).toContainEqual({
        metric: WorkerAccountCapacityMetric.LockRecovery,
        value: 1,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "subscription-runtime-account-capacity-"));
}

function capacityV2RecordPath(rootDir: string, accountId: string): string {
  return join(
    rootDir,
    "account-capacity-v2",
    createHash("sha256").update(accountId).digest("hex"),
    "account.json",
  );
}
