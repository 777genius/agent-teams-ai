import {
  normalizeWorkerAccountId,
  workerRuntimeDemandKey,
  type WorkerRuntimeDemand,
} from "../../account-capacity";

export type WorkerAccountLease = {
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly accountId: string;
  readonly demand?: WorkerRuntimeDemand;
  readonly ownerId: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
};

export function workerAccountLeaseResourceKey(
  accountId: string,
  demand: WorkerRuntimeDemand | null,
): string {
  return `${accountId}\u0000${workerRuntimeDemandKey(demand) ?? ""}`;
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

export function selectableWorkerAccountIds(
  allowedAccounts: readonly string[],
  lastSelectedAccountId: string | undefined,
): readonly string[] {
  const accounts = [
    ...new Set(
      allowedAccounts
        .map((account) => normalizeWorkerAccountId(account))
        .filter((account): account is string => account !== null),
    ),
  ];
  return orderedAccounts(
    accounts,
    normalizeWorkerAccountId(lastSelectedAccountId),
  );
}

export function buildRuntimeAccountWaitPlan(
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
  lastSelectedAccountId: string | null,
): readonly string[] {
  if (!lastSelectedAccountId) return accounts;
  const index = accounts.indexOf(lastSelectedAccountId);
  if (index < 0 || index === accounts.length - 1) return accounts;
  return [...accounts.slice(index + 1), ...accounts.slice(0, index + 1)];
}
