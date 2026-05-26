import { describe, expect, it } from "vitest";

import type { PrismaDatabaseClient } from "../prisma/prisma-database-client.js";

import { PrismaDistributedLockPort } from "./prisma-distributed-lock.port.js";

describe("PrismaDistributedLockPort", () => {
  it("returns an acquired lease with a fencing token", async () => {
    const lockedUntil = new Date("2026-05-26T12:00:00.000Z");
    const lock = new PrismaDistributedLockPort(
      fakeDatabaseClient([
        {
          fencing_token: 7n,
          locked_until: lockedUntil,
          name: "cleanup",
          owner_id: "worker-a",
        },
      ]),
    );

    const result = await lock.acquire({
      leaseMilliseconds: 30_000,
      name: "cleanup",
      ownerId: "worker-a",
    });

    expect(result).toEqual({
      acquired: true,
      lease: {
        fencingToken: 7n,
        lockedUntil,
        name: "cleanup",
        ownerId: "worker-a",
      },
    });
  });

  it("returns not acquired when the current lease is still valid", async () => {
    const lock = new PrismaDistributedLockPort(fakeDatabaseClient([]));

    await expect(
      lock.acquire({
        leaseMilliseconds: 30_000,
        name: "cleanup",
        ownerId: "worker-a",
      }),
    ).resolves.toEqual({ acquired: false });
  });

  it("returns not renewed for stale owner or fencing token", async () => {
    const lock = new PrismaDistributedLockPort(fakeDatabaseClient([]));

    await expect(
      lock.renew({
        fencingToken: 1n,
        leaseMilliseconds: 30_000,
        name: "cleanup",
        ownerId: "worker-a",
      }),
    ).resolves.toEqual({ renewed: false });
  });

  it("rejects invalid lock inputs before SQL execution", async () => {
    const lock = new PrismaDistributedLockPort(fakeDatabaseClient([]));

    await expect(
      lock.acquire({
        leaseMilliseconds: 0,
        name: "cleanup",
        ownerId: "worker-a",
      }),
    ).rejects.toThrow("leaseMilliseconds");
    await expect(
      lock.acquire({
        leaseMilliseconds: 30_000,
        name: " ",
        ownerId: "worker-a",
      }),
    ).rejects.toThrow("name");
    await expect(
      lock.acquire({
        leaseMilliseconds: 30_000,
        name: "cleanup",
        ownerId: " ",
      }),
    ).rejects.toThrow("ownerId");
  });
});

function fakeDatabaseClient(rows: readonly unknown[]): PrismaDatabaseClient {
  return {
    getClient: () => ({
      $queryRaw: async () => rows,
    }),
  } as unknown as PrismaDatabaseClient;
}
