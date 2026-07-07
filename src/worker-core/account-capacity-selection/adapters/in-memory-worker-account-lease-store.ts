import {
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  workerRuntimeDemandKey,
  type WorkerRuntimeDemand,
} from "../../account-capacity";
import type { WorkerAccountLease } from "../domain";
import type {
  WorkerAccountLeaseAcquireResult,
  WorkerAccountLeaseStore,
} from "../ports";

export class InMemoryWorkerAccountLeaseStore implements WorkerAccountLeaseStore {
  private readonly records = new Map<string, WorkerAccountLease>();
  private nextLeaseSequence = 0;

  async acquire(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseAcquireResult> {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) {
      throw new Error("worker_account_lease_account_id_required");
    }
    const ownerId = input.ownerId.trim();
    if (!ownerId) {
      throw new Error("worker_account_lease_owner_id_required");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("worker_account_lease_ttl_invalid");
    }

    const demand = normalizeWorkerRuntimeDemand(input.demand);
    const key = accountLeaseKey(accountId, demand);
    const current = this.records.get(key);
    if (current && current.expiresAt.getTime() > input.now.getTime()) {
      return {
        status: "denied",
        reason: "leased",
        currentLeaseExpiresAt: current.expiresAt,
      };
    }
    const lease: WorkerAccountLease = {
      leaseId: `${ownerId}:${++this.nextLeaseSequence}`,
      accountId,
      ...(demand ? { demand } : {}),
      ownerId,
      acquiredAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.ttlMs),
    };
    this.records.set(key, lease);
    return { status: "granted", lease };
  }

  async release(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<void> {
    const ownerId = input.ownerId.trim();
    for (const [key, lease] of this.records.entries()) {
      if (lease.leaseId !== input.leaseId || lease.ownerId !== ownerId) {
        continue;
      }
      this.records.delete(key);
      return;
    }
  }
}

function accountLeaseKey(
  accountId: string,
  demand: WorkerRuntimeDemand | null,
): string {
  return `${accountId}\u0000${workerRuntimeDemandKey(demand) ?? ""}`;
}
