import type {
  WorkerAccountCapacityStore,
  WorkerRuntimeDemand,
} from "./account-capacity";

export type WorkerAccountLease = {
  readonly leaseId: string;
  readonly accountId: string;
  readonly demand?: WorkerRuntimeDemand;
  readonly ownerId: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
};

export type WorkerAccountLeaseAcquireResult =
  | {
      readonly status: "granted";
      readonly lease: WorkerAccountLease;
    }
  | {
      readonly status: "denied";
      readonly reason: "leased";
      readonly currentLeaseExpiresAt?: Date;
    };

export interface WorkerAccountLeaseStore {
  acquire(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseAcquireResult>;

  release(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<void>;
}

export type RuntimeAccountSelectionDecision =
  | {
      readonly type: "selected";
      readonly accountId: string;
      readonly lease: WorkerAccountLease;
    }
  | {
      readonly type: "all_unavailable";
      readonly waitPlan: RuntimeAccountWaitPlan;
    };

export type RuntimeAccountWaitPlan = {
  readonly waitUntil?: Date;
  readonly waitMs?: number;
  readonly unavailable: readonly RuntimeAccountUnavailableReason[];
};

export type RuntimeAccountUnavailableReason = {
  readonly accountId: string;
  readonly reason: string;
  readonly waitUntil?: Date;
};

export type SelectRuntimeAccountInput = {
  readonly allowedAccounts: readonly string[];
  readonly demand?: WorkerRuntimeDemand;
  readonly ownerId: string;
  readonly leaseTtlMs: number;
  readonly capacityStore: WorkerAccountCapacityStore;
  readonly leaseStore: WorkerAccountLeaseStore;
  readonly now: Date;
  readonly lastSelectedAccountId?: string;
};

export class SelectRuntimeAccountUseCase {
  async execute(
    input: SelectRuntimeAccountInput,
  ): Promise<RuntimeAccountSelectionDecision> {
    assertSelectionInput(input);
    const accounts = orderedAccounts(
      [...new Set(input.allowedAccounts.map((account) => account.trim()))]
        .filter(Boolean),
      input.lastSelectedAccountId,
    );
    const unavailable: RuntimeAccountUnavailableReason[] = [];

    for (const accountId of accounts) {
      const capacity = input.capacityStore.read({
        accountId,
        ...(input.demand ? { demand: input.demand } : {}),
        now: input.now,
      });
      if (capacity && capacity.availability !== "available") {
        unavailable.push({
          accountId,
          reason: capacity.reason ?? capacity.availability,
          ...(capacity.cooldownUntil
            ? { waitUntil: capacity.cooldownUntil }
            : {}),
        });
        continue;
      }

      const lease = await input.leaseStore.acquire({
        accountId,
        ...(input.demand ? { demand: input.demand } : {}),
        ownerId: input.ownerId,
        ttlMs: input.leaseTtlMs,
        now: input.now,
      });
      if (lease.status === "granted") {
        return {
          type: "selected",
          accountId,
          lease: lease.lease,
        };
      }
      unavailable.push({
        accountId,
        reason: lease.reason,
        ...(lease.currentLeaseExpiresAt
          ? { waitUntil: lease.currentLeaseExpiresAt }
          : {}),
      });
    }

    return {
      type: "all_unavailable",
      waitPlan: buildWaitPlan(unavailable, input.now),
    };
  }
}

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
    if (!input.accountId.trim()) {
      throw new Error("worker_account_lease_account_id_required");
    }
    if (!input.ownerId.trim()) {
      throw new Error("worker_account_lease_owner_id_required");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("worker_account_lease_ttl_invalid");
    }

    const key = accountLeaseKey(input.accountId, input.demand);
    const current = this.records.get(key);
    if (current && current.expiresAt.getTime() > input.now.getTime()) {
      return {
        status: "denied",
        reason: "leased",
        currentLeaseExpiresAt: current.expiresAt,
      };
    }
    const lease: WorkerAccountLease = {
      leaseId: `${input.ownerId}:${++this.nextLeaseSequence}`,
      accountId: input.accountId,
      ...(input.demand ? { demand: input.demand } : {}),
      ownerId: input.ownerId,
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
    for (const [key, lease] of this.records.entries()) {
      if (lease.leaseId !== input.leaseId || lease.ownerId !== input.ownerId) {
        continue;
      }
      this.records.delete(key);
      return;
    }
  }
}

function buildWaitPlan(
  unavailable: readonly RuntimeAccountUnavailableReason[],
  now: Date,
): RuntimeAccountWaitPlan {
  const waitUntil = unavailable
    .map((item) => item.waitUntil)
    .filter((value): value is Date => value !== undefined)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return {
    unavailable,
    ...(waitUntil ? { waitUntil } : {}),
    ...(waitUntil
      ? { waitMs: Math.max(0, waitUntil.getTime() - now.getTime()) }
      : {}),
  };
}

function orderedAccounts(
  accounts: readonly string[],
  lastSelectedAccountId: string | undefined,
): readonly string[] {
  if (!lastSelectedAccountId) return accounts;
  const index = accounts.indexOf(lastSelectedAccountId);
  if (index < 0 || index === accounts.length - 1) return accounts;
  return [...accounts.slice(index + 1), ...accounts.slice(0, index + 1)];
}

function assertSelectionInput(input: SelectRuntimeAccountInput): void {
  if (!input.ownerId.trim()) {
    throw new Error("select_runtime_account_owner_id_required");
  }
  if (!Number.isFinite(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
    throw new Error("select_runtime_account_lease_ttl_invalid");
  }
}

function accountLeaseKey(
  accountId: string,
  demand: WorkerRuntimeDemand | undefined,
): string {
  const demandKey = demand
    ? [
        `provider=${demand.provider}`,
        `model=${demand.model ?? ""}`,
        `reasoningEffort=${demand.reasoningEffort ?? ""}`,
        `serviceTier=${demand.serviceTier ?? ""}`,
      ].join("\u001f")
    : "";
  return `${accountId.trim()}\u0000${demandKey}`;
}
