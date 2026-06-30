import type {
  WorkerAccountCapacityStore,
  WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  ProviderAccountCapacityReaderPort,
  ProviderAccountDiagnosticSignal,
  ProviderAccountInventoryItem,
} from "./types";

export type WorkerAccountCapacityReaderOptions = {
  readonly store: WorkerAccountCapacityStore;
};

export function createWorkerAccountCapacityReader<
  Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem,
>(
  options: WorkerAccountCapacityReaderOptions,
): ProviderAccountCapacityReaderPort<Account> {
  return {
    async readCapacity(input) {
      const accountId =
        input.account.capacityAccountId ?? input.identity.providerAccountId;
      if (!accountId) return null;
      const capacity = options.store.read({
        accountId,
        now: input.now,
      });
      return capacity ? workerCapacityToDiagnosticSignal(capacity) : null;
    },
  };
}

export function workerCapacityToDiagnosticSignal(
  capacity: WorkerCapacitySnapshot,
): ProviderAccountDiagnosticSignal | null {
  switch (capacity.availability) {
    case "available":
      return {
        availability: "available",
        source: "cached",
        ...(capacity.reason ? { reason: capacity.reason } : {}),
        ...(capacity.details ? { details: capacity.details } : {}),
      };
    case "quota_exhausted":
    case "cooldown":
      return {
        availability: "limited",
        source: "cached",
        reason: capacity.reason ?? capacity.availability,
        ...(capacity.cooldownUntil
          ? {
              limitResetAt: capacity.cooldownUntil,
              rawResetText: capacity.cooldownUntil.toISOString(),
            }
          : {}),
        ...(capacity.lastLimitSignalAt
          ? { checkedAt: capacity.lastLimitSignalAt }
          : {}),
        ...(capacity.details ? { details: capacity.details } : {}),
      };
    case "disabled":
    case "degraded":
      return {
        availability: "unhealthy",
        source: "cached",
        reason: capacity.reason ?? capacity.availability,
        ...(capacity.details ? { details: capacity.details } : {}),
      };
    case "busy":
    case "warming":
      return {
        availability: "unknown",
        source: "cached",
        reason: capacity.reason ?? capacity.availability,
        ...(capacity.details ? { details: capacity.details } : {}),
      };
  }
}
