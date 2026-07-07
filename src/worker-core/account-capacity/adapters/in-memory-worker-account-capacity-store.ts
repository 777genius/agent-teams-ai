import type { WorkerCapacitySnapshot } from "../../types";
import {
  defaultRuntimeDemandFromCapacityDetails,
  normalizeWorkerAccountCapacitySignal,
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  shouldKeepExistingWorkerAccountCapacity,
  workerRuntimeDemandKey,
  type WorkerAccountLimitSignal,
  type WorkerRuntimeDemand,
} from "../domain";
import type { WorkerAccountCapacityStore } from "../ports";

export class InMemoryWorkerAccountCapacityStore
  implements WorkerAccountCapacityStore
{
  private readonly records = new Map<string, WorkerCapacitySnapshot>();

  read(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return null;
    const demand = normalizeWorkerRuntimeDemand(input.demand);
    const now = input.now ?? new Date();
    const current = this.readByKey(accountCapacityKey(accountId, demand), now);
    if (current) return current;
    if (demand) {
      return this.readByKey(accountCapacityKey(accountId, null), now);
    }
    return this.readAggregate(accountId, now);
  }

  private readByKey(key: string, now: Date): WorkerCapacitySnapshot | null {
    const current = this.records.get(key);
    if (!current) return null;
    if (
      current.cooldownUntil &&
      current.cooldownUntil.getTime() <= now.getTime()
    ) {
      this.records.delete(key);
      return null;
    }
    return current;
  }

  private readAggregate(
    accountId: string,
    now: Date,
  ): WorkerCapacitySnapshot | null {
    const prefix = `${accountId}\u0000`;
    let selected: WorkerCapacitySnapshot | null = null;
    for (const key of this.records.keys()) {
      if (key !== accountId && !key.startsWith(prefix)) continue;
      const capacity = this.readByKey(key, now);
      if (!capacity) continue;
      if (
        !selected ||
        !shouldKeepExistingWorkerAccountCapacity(selected, capacity)
      ) {
        selected = capacity;
      }
    }
    return selected;
  }

  observe(input: WorkerAccountLimitSignal): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;
    const capacity = normalizeWorkerAccountCapacitySignal(input);
    if (!capacity) return;
    const demand =
      normalizeWorkerRuntimeDemand(input.demand) ??
      defaultRuntimeDemandFromCapacityDetails(input.capacity.details);

    const existing = this.read({
      accountId,
      ...(demand ? { demand } : {}),
      now: input.observedAt,
    });
    if (
      existing &&
      shouldKeepExistingWorkerAccountCapacity(existing, capacity)
    ) {
      return;
    }
    this.records.set(accountCapacityKey(accountId, demand), capacity);
  }

  clear(input: { readonly accountId: string }): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;
    const prefix = `${accountId}\u0000`;
    for (const key of this.records.keys()) {
      if (key === accountId || key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
  }
}

function accountCapacityKey(
  accountId: string,
  demand: WorkerRuntimeDemand | null,
): string {
  const demandKey = workerRuntimeDemandKey(demand);
  return demandKey ? `${accountId}\u0000${demandKey}` : accountId;
}
