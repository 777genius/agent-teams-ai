import type { WorkerCapacitySnapshot } from "../../types";

export type WorkerRuntimeDemand = {
  readonly provider: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly serviceTier?: string;
};

export type WorkerAccountLimitSignal = {
  readonly accountId: string;
  readonly scope?: WorkerAccountCapacitySignalScope;
  readonly demand?: WorkerRuntimeDemand;
  readonly capacity: WorkerCapacitySnapshot;
  readonly observedAt: Date;
  readonly sourceWorkerId?: string;
  readonly retainExpiredForRecheck?: boolean;
};

export enum WorkerAccountCapacitySignalScope {
  AccountWide = "account_wide",
  DemandAware = "demand_aware",
}

export const defaultWorkerAccountLimitReasons = [
  "rate_limit_threshold",
  "quota_limited",
  "account_exhausted",
] as const;

export function defaultAccountIdFromCapacityDetails(
  details: Readonly<Record<string, string>> | undefined,
): string | null {
  return normalizeWorkerAccountId(
    details?.accountId ?? details?.quotaGroup ?? details?.subscriptionAccountId,
  );
}

export function normalizeWorkerAccountId(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeWorkerRuntimeDemand(
  value: WorkerRuntimeDemand | null | undefined,
): WorkerRuntimeDemand | null {
  const provider = value?.provider.trim();
  if (!provider) return null;
  const model = optionalTrimmed(value?.model);
  const reasoningEffort = optionalTrimmed(value?.reasoningEffort);
  const serviceTier = optionalTrimmed(value?.serviceTier);
  return {
    provider,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export function defaultRuntimeDemandFromCapacityDetails(
  details: Readonly<Record<string, string>> | undefined,
): WorkerRuntimeDemand | null {
  const provider = details?.capacityProvider ?? details?.provider ?? "";
  const model = details?.capacityModel ?? details?.model;
  const reasoningEffort =
    details?.capacityReasoningEffort ?? details?.reasoningEffort;
  const serviceTier = details?.capacityServiceTier ?? details?.serviceTier;
  return normalizeWorkerRuntimeDemand({
    provider,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  });
}

export function workerRuntimeDemandKey(
  value: WorkerRuntimeDemand | null | undefined,
): string | null {
  const demand = normalizeWorkerRuntimeDemand(value);
  if (!demand) return null;
  return [
    `provider=${demand.provider}`,
    `model=${demand.model ?? ""}`,
    `reasoningEffort=${demand.reasoningEffort ?? ""}`,
    `serviceTier=${demand.serviceTier ?? ""}`,
  ].join("\u001f");
}

export function normalizeWorkerAccountCapacitySignal(
  input: WorkerAccountLimitSignal,
): WorkerCapacitySnapshot | null {
  const accountId = normalizeWorkerAccountId(input.accountId);
  if (!accountId) return null;
  const capacity = input.capacity;
  if (!isPersistableWorkerAccountCapacity(capacity)) return null;
  if (
    !input.retainExpiredForRecheck &&
    capacity.cooldownUntil &&
    capacity.cooldownUntil.getTime() <= input.observedAt.getTime()
  ) {
    return null;
  }
  return {
    availability: capacity.availability,
    ...(capacity.reason ? { reason: capacity.reason } : {}),
    ...(capacity.cooldownUntil
      ? { cooldownUntil: capacity.cooldownUntil }
      : {}),
    lastLimitSignalAt: input.observedAt,
    details: {
      ...(capacity.details ?? {}),
      accountId,
      ...runtimeDemandDetails(
        input.scope === WorkerAccountCapacitySignalScope.AccountWide
          ? null
          : normalizeWorkerRuntimeDemand(input.demand) ??
              defaultRuntimeDemandFromCapacityDetails(capacity.details),
      ),
      ...(input.sourceWorkerId ? { sourceWorkerId: input.sourceWorkerId } : {}),
    },
  };
}

export function shouldKeepExistingWorkerAccountCapacity(
  existing: WorkerCapacitySnapshot,
  next: WorkerCapacitySnapshot,
): boolean {
  if (severity(existing) > severity(next)) return true;
  if (severity(existing) < severity(next)) return false;
  const existingResetAt = existing.cooldownUntil?.getTime();
  const nextResetAt = next.cooldownUntil?.getTime();
  if (nextResetAt === undefined) return true;
  if (existingResetAt === undefined) return false;
  return existingResetAt >= nextResetAt;
}

export function isWorkerAccountLimitCapacity(
  capacity: WorkerCapacitySnapshot,
  limitReasons: readonly string[],
): boolean {
  if (!isPersistableWorkerAccountCapacity(capacity)) return false;
  if (!capacity.reason) return true;
  return limitReasons.includes(capacity.reason);
}

export function isPersistableWorkerAccountCapacity(
  capacity: WorkerCapacitySnapshot,
): boolean {
  return isPersistableWorkerAccountAvailability(capacity.availability);
}

export function isPersistableWorkerAccountAvailability(
  value: unknown,
): value is WorkerCapacitySnapshot["availability"] {
  return value === "cooldown" || value === "quota_exhausted";
}

export function mergeWorkerAndAccountCapacity(
  worker: WorkerCapacitySnapshot,
  account: WorkerCapacitySnapshot,
): WorkerCapacitySnapshot {
  if (worker.availability === "available") {
    return {
      ...account,
      details: {
        ...(account.details ?? {}),
        ...(worker.details ?? {}),
      },
    };
  }
  if (severity(account) > severity(worker)) {
    return {
      ...account,
      details: {
        ...(account.details ?? {}),
        ...(worker.details ?? {}),
      },
    };
  }
  if (
    severity(account) === severity(worker) &&
    worker.cooldownUntil &&
    account.cooldownUntil &&
    account.cooldownUntil.getTime() > worker.cooldownUntil.getTime()
  ) {
    return {
      ...account,
      details: {
        ...(account.details ?? {}),
        ...(worker.details ?? {}),
      },
    };
  }
  return worker;
}

export function withAccountDetails(
  capacity: WorkerCapacitySnapshot,
  accountId: string,
): WorkerCapacitySnapshot {
  return {
    ...capacity,
    details: {
      ...(capacity.details ?? {}),
      accountId,
    },
  };
}

function severity(capacity: WorkerCapacitySnapshot): number {
  switch (capacity.availability) {
    case "disabled":
      return 70;
    case "quota_exhausted":
      return 60;
    case "cooldown":
      return 50;
    case "degraded":
      return 40;
    case "warming":
      return 30;
    case "busy":
      return 20;
    case "available":
      return 10;
  }
}

function runtimeDemandDetails(
  demand: WorkerRuntimeDemand | null,
): Readonly<Record<string, string>> {
  if (!demand) return {};
  return {
    capacityProvider: demand.provider,
    ...(demand.model ? { capacityModel: demand.model } : {}),
    ...(demand.reasoningEffort
      ? { capacityReasoningEffort: demand.reasoningEffort }
      : {}),
    ...(demand.serviceTier ? { capacityServiceTier: demand.serviceTier } : {}),
  };
}

function optionalTrimmed(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
