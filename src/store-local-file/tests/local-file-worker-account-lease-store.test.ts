import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  workerAccountLeaseResourceKey,
  type WorkerAccountLease,
  type WorkerAccountLeaseAcquireResult,
  type WorkerRuntimeDemand,
} from "../../worker-core";
import {
  LocalFileWorkerAccountLeaseStore,
  localFileWorkerAccountLeaseLockStorageVersion,
} from "../index";

const demand: WorkerRuntimeDemand = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  serviceTier: "fast",
};

describe("LocalFileWorkerAccountLeaseStore", () => {
  it("persists an idempotent lease across store instances", async () => {
    const rootDir = await tempRoot();
    const now = new Date("2026-07-13T10:00:00.000Z");
    try {
      const first = await acquire(
        new LocalFileWorkerAccountLeaseStore({ rootDir }),
        "worker-a",
        now,
      );
      const replay = await acquire(
        new LocalFileWorkerAccountLeaseStore({ rootDir }),
        "worker-a",
        new Date(now.getTime() + 5_000),
        120_000,
      );

      expect(replay).toEqual(first);
      expect(first.fencingToken).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("grants exactly one owner under competing store instances", async () => {
    const rootDir = await tempRoot();
    const now = new Date("2026-07-13T10:00:00.000Z");
    try {
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          new LocalFileWorkerAccountLeaseStore({
            rootDir,
            lockAcquireTimeoutMs: 10_000,
            lockPollMs: 1,
          }).acquire({
            accountId: "account-a",
            demand,
            ownerId: `worker-${index}`,
            ttlMs: 60_000,
            now,
          }),
        ),
      );

      expect(results.filter(isGranted)).toHaveLength(1);
      expect(results.filter((result) => result.status === "denied")).toHaveLength(
        23,
      );
      expect(
        new Set(
          results.filter(isGranted).map((result) => result.lease.leaseId),
        ).size,
      ).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("recovers an expired lease and rejects its stale release handle", async () => {
    const rootDir = await tempRoot();
    const now = new Date("2026-07-13T10:00:00.000Z");
    const store = new LocalFileWorkerAccountLeaseStore({ rootDir });
    try {
      const stale = await acquire(store, "worker-a", now, 1_000);
      const replacement = await acquire(
        store,
        "worker-b",
        new Date(now.getTime() + 1_000),
      );
      expect(replacement.fencingToken).toBe(stale.fencingToken + 1);

      await store.release({
        leaseId: stale.leaseId,
        ownerId: stale.ownerId,
        reason: "late stale cleanup",
        now: new Date(now.getTime() + 2_000),
      });
      await expect(store.acquire({
        accountId: "account-a",
        demand,
        ownerId: "worker-c",
        ttlMs: 60_000,
        now: new Date(now.getTime() + 2_000),
      })).resolves.toMatchObject({
        status: "denied",
        currentLeaseExpiresAt: replacement.expiresAt,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("renews only a current unexpired lease without shortening it", async () => {
    const rootDir = await tempRoot();
    const now = new Date("2026-07-13T10:00:00.000Z");
    const store = new LocalFileWorkerAccountLeaseStore({ rootDir });
    try {
      const lease = await acquire(store, "worker-a", now, 60_000);
      await expect(store.renew({
        leaseId: lease.leaseId,
        ownerId: lease.ownerId,
        ttlMs: 10_000,
        now: new Date(now.getTime() + 5_000),
      })).resolves.toMatchObject({
        status: "renewed",
        lease: { expiresAt: lease.expiresAt },
      });
      await expect(store.renew({
        leaseId: lease.leaseId,
        ownerId: lease.ownerId,
        ttlMs: 60_000,
        now: lease.expiresAt,
      })).resolves.toEqual({ status: "lost", reason: "lease_expired" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not persist owner ids or arbitrary release reasons", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountLeaseStore({ rootDir });
    const now = new Date("2026-07-13T10:00:00.000Z");
    try {
      const lease = await acquire(store, "owner-sensitive-value", now);
      await store.release({
        leaseId: lease.leaseId,
        ownerId: lease.ownerId,
        reason: "release-sensitive-value",
        now,
      });
      const [recordName] = await readdir(
        join(rootDir, "worker-account-leases", "records"),
      );
      const persisted = await readFile(
        join(rootDir, "worker-account-leases", "records", recordName!),
        "utf8",
      );
      expect(persisted).not.toContain("owner-sensitive-value");
      expect(persisted).not.toContain("release-sensitive-value");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("recovers a lock owned by a dead process", async () => {
    const rootDir = await tempRoot();
    const resourceHash = hashText(
      workerAccountLeaseResourceKey("account-a", demand),
    );
    const lockPath = join(
      rootDir,
      "worker-account-leases",
      "locks",
      `${resourceHash}.lock`,
    );
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        storageVersion: localFileWorkerAccountLeaseLockStorageVersion,
        lockId: "dead-lock",
        pid: 2_147_483_647,
        acquiredAt: "2026-07-13T09:00:00.000Z",
      })}\n`,
    );
    try {
      await expect(
        new LocalFileWorkerAccountLeaseStore({ rootDir }).acquire({
          accountId: "account-a",
          demand,
          ownerId: "worker-a",
          ttlMs: 60_000,
          now: new Date("2026-07-13T10:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ status: "granted" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

async function acquire(
  store: LocalFileWorkerAccountLeaseStore,
  ownerId: string,
  now: Date,
  ttlMs = 60_000,
): Promise<WorkerAccountLease> {
  const result = await store.acquire({
    accountId: "account-a",
    demand,
    ownerId,
    ttlMs,
    now,
  });
  if (result.status !== "granted") throw new Error("lease_not_granted");
  return result.lease;
}

function isGranted(
  result: WorkerAccountLeaseAcquireResult,
): result is Extract<WorkerAccountLeaseAcquireResult, { status: "granted" }> {
  return result.status === "granted";
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "subscription-runtime-account-leases-"));
}
