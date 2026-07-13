import type {
  WorkerAccountCapacityStore,
  WorkerRuntimeDemand,
} from "../../account-capacity";
import {
  buildRuntimeAccountWaitPlan,
  selectableWorkerAccountIds,
  type RuntimeAccountSelectionDecision,
  type RuntimeAccountUnavailableReason,
} from "../domain";
import type { WorkerAccountLeaseStore } from "../ports";

export type SelectRuntimeAccountInput = {
  readonly allowedAccounts: readonly string[];
  readonly demand?: WorkerRuntimeDemand;
  readonly leaseDemand?: WorkerRuntimeDemand | null;
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
    const accounts = selectableWorkerAccountIds(
      input.allowedAccounts,
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

      const leaseDemand = input.leaseDemand === undefined
        ? input.demand
        : input.leaseDemand;
      const lease = await input.leaseStore.acquire({
        accountId,
        ...(leaseDemand ? { demand: leaseDemand } : {}),
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
      waitPlan: buildRuntimeAccountWaitPlan(unavailable, input.now),
    };
  }
}

function assertSelectionInput(input: SelectRuntimeAccountInput): void {
  if (!input.ownerId.trim()) {
    throw new Error("select_runtime_account_owner_id_required");
  }
  if (!Number.isFinite(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
    throw new Error("select_runtime_account_lease_ttl_invalid");
  }
}
