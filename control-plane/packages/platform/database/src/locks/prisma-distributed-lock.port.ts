import type { PrismaDatabaseClient } from "../prisma/prisma-database-client.js";

import type {
  DistributedLockAcquireInput,
  DistributedLockAcquireResult,
  DistributedLockLease,
  DistributedLockPort,
  DistributedLockReleaseInput,
  DistributedLockRenewInput,
  DistributedLockRenewResult,
} from "./distributed-lock.js";

type DistributedLockRow = Readonly<{
  fencing_token: bigint;
  locked_until: Date;
  name: string;
  owner_id: string;
}>;

export class PrismaDistributedLockPort implements DistributedLockPort {
  public constructor(private readonly databaseClient: PrismaDatabaseClient) {}

  public async acquire(
    input: DistributedLockAcquireInput,
  ): Promise<DistributedLockAcquireResult> {
    validateLockName(input.name);
    validateOwnerId(input.ownerId);
    validateLeaseMilliseconds(input.leaseMilliseconds);

    const rows = await this.databaseClient.getClient().$queryRaw<DistributedLockRow[]>`
      INSERT INTO distributed_locks (
        name,
        owner_id,
        locked_until,
        fencing_token,
        created_at,
        updated_at
      )
      VALUES (
        ${input.name},
        ${input.ownerId},
        now() + (${input.leaseMilliseconds}::double precision * interval '1 millisecond'),
        1,
        now(),
        now()
      )
      ON CONFLICT (name) DO UPDATE
      SET
        owner_id = EXCLUDED.owner_id,
        locked_until = EXCLUDED.locked_until,
        fencing_token = distributed_locks.fencing_token + 1,
        updated_at = now()
      WHERE distributed_locks.locked_until < now()
      RETURNING name, owner_id, locked_until, fencing_token;
    `;

    const lease = firstLease(rows);
    return lease === undefined ? { acquired: false } : { acquired: true, lease };
  }

  public async renew(
    input: DistributedLockRenewInput,
  ): Promise<DistributedLockRenewResult> {
    validateLockName(input.name);
    validateOwnerId(input.ownerId);
    validateLeaseMilliseconds(input.leaseMilliseconds);

    const rows = await this.databaseClient.getClient().$queryRaw<DistributedLockRow[]>`
      UPDATE distributed_locks
      SET
        locked_until = now() + (${input.leaseMilliseconds}::double precision * interval '1 millisecond'),
        updated_at = now()
      WHERE name = ${input.name}
        AND owner_id = ${input.ownerId}
        AND fencing_token = ${input.fencingToken}
        AND locked_until >= now()
      RETURNING name, owner_id, locked_until, fencing_token;
    `;

    const lease = firstLease(rows);
    return lease === undefined ? { renewed: false } : { renewed: true, lease };
  }

  public async release(input: DistributedLockReleaseInput): Promise<void> {
    validateLockName(input.name);
    validateOwnerId(input.ownerId);

    await this.databaseClient.getClient().$executeRaw`
      DELETE FROM distributed_locks
      WHERE name = ${input.name}
        AND owner_id = ${input.ownerId}
        AND fencing_token = ${input.fencingToken};
    `;
  }
}

function firstLease(
  rows: readonly DistributedLockRow[],
): DistributedLockLease | undefined {
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }

  return {
    fencingToken: row.fencing_token,
    lockedUntil: row.locked_until,
    name: row.name,
    ownerId: row.owner_id,
  };
}

function validateLockName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("Distributed lock name must be non-empty.");
  }
}

function validateOwnerId(ownerId: string): void {
  if (ownerId.trim().length === 0) {
    throw new Error("Distributed lock ownerId must be non-empty.");
  }
}

function validateLeaseMilliseconds(leaseMilliseconds: number): void {
  if (
    !Number.isFinite(leaseMilliseconds) ||
    !Number.isInteger(leaseMilliseconds) ||
    leaseMilliseconds <= 0
  ) {
    throw new Error("Distributed lock leaseMilliseconds must be a positive integer.");
  }
}
