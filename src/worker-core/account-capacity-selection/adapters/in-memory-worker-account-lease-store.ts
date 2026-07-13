import {
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  type WorkerRuntimeDemand,
} from "../../account-capacity";
import {
  workerAccountLeaseResourceKey,
  type WorkerAccountLease,
} from "../domain";
import type {
  WorkerAccountLeaseAcquireResult,
  WorkerAccountLeaseRenewResult,
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
    const key = workerAccountLeaseResourceKey(accountId, demand);
    const current = this.records.get(key);
    if (current && current.expiresAt.getTime() > input.now.getTime()) {
      if (current.ownerId === ownerId) {
        return { status: "granted", lease: current };
      }
      return {
        status: "denied",
        reason: "leased",
        currentLeaseExpiresAt: current.expiresAt,
      };
    }
    const lease: WorkerAccountLease = {
      leaseId: `${ownerId}:${++this.nextLeaseSequence}`,
      fencingToken: this.nextLeaseSequence,
      accountId,
      ...(demand ? { demand } : {}),
      ownerId,
      acquiredAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.ttlMs),
    };
    this.records.set(key, lease);
    return { status: "granted", lease };
  }

  async renew(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseRenewResult> {
    const leaseId = input.leaseId.trim();
    const ownerId = input.ownerId.trim();
    if (!leaseId) throw new Error("worker_account_lease_id_required");
    if (!ownerId) throw new Error("worker_account_lease_owner_id_required");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("worker_account_lease_ttl_invalid");
    }

    for (const [key, lease] of this.records.entries()) {
      if (lease.leaseId !== leaseId || lease.ownerId !== ownerId) continue;
      if (lease.expiresAt.getTime() <= input.now.getTime()) {
        return { status: "lost", reason: "lease_expired" };
      }
      const renewed: WorkerAccountLease = {
        ...lease,
        expiresAt: new Date(
          Math.max(
            lease.expiresAt.getTime(),
            input.now.getTime() + input.ttlMs,
          ),
        ),
      };
      this.records.set(key, renewed);
      return { status: "renewed", lease: renewed };
    }
    return { status: "lost", reason: "lease_not_current" };
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
