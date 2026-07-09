import { SubscriptionWorkerError } from "./errors";
import type {
  CapacityAwareSubscriptionWorker,
  SubscriptionWorker,
  WorkerCapacitySnapshot,
  WorkerPoolRetryPolicy,
  WorkerPoolSlotSnapshot,
} from "./types";

export function capacityAwareWorker<Job, Result>(
  worker: SubscriptionWorker<Job, Result>,
): CapacityAwareSubscriptionWorker<Job, Result> | null {
  if ("capacity" in worker && typeof worker.capacity === "function") {
    return worker as CapacityAwareSubscriptionWorker<Job, Result>;
  }
  return null;
}

export function normalizeCapacity(
  capacity: WorkerCapacitySnapshot,
  now: Date,
): WorkerCapacitySnapshot {
  if (
    !isResettableCapacity(capacity) ||
    !capacity.cooldownUntil ||
    capacity.cooldownUntil.getTime() > now.getTime()
  ) {
    return capacity;
  }

  const {
    cooldownUntil: _cooldownUntil,
    lastLimitSignalAt: _lastLimitSignalAt,
    reason: _reason,
    ...rest
  } = capacity;
  return {
    ...rest,
    availability: "available",
  };
}

export function capacityUnavailableError(
  snapshots: readonly WorkerPoolSlotSnapshot[],
  policy: Required<WorkerPoolRetryPolicy>,
): SubscriptionWorkerError | null {
  if (snapshots.some((snapshot) => snapshot.busy)) return null;
  if (
    snapshots.some(
      (snapshot) =>
        isResettableCapacity(snapshot.capacity) &&
        snapshot.capacity.cooldownUntil,
    )
  ) {
    return null;
  }
  if (
    policy.retryOnSlotCapacityUnavailable &&
    snapshots.some((snapshot) => isAuthBlockedCapacity(snapshot.capacity))
  ) {
    return null;
  }

  const unavailable = snapshots.filter(
    (snapshot) => snapshot.capacity.availability !== "available",
  );
  if (unavailable.length === 0) return null;

  return new SubscriptionWorkerError(
    "subscription_worker_pool_capacity_unavailable",
    "Worker pool has no available or resettable-capacity slots.",
    {
      details: {
        availability: summarizeAvailability(unavailable),
        ...capacityRecoveryDetails(unavailable),
      },
    },
  );
}

export function nextCooldownDrainAt(
  snapshots: readonly WorkerPoolSlotSnapshot[],
): number | null {
  return snapshots.reduce<number | null>((nextAt, snapshot) => {
    if (
      !isResettableCapacity(snapshot.capacity) ||
      !snapshot.capacity.cooldownUntil
    ) {
      return nextAt;
    }
    const candidate = snapshot.capacity.cooldownUntil.getTime();
    return nextAt === null ? candidate : Math.min(nextAt, candidate);
  }, null);
}

export function isAuthBlockedCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return capacity.reason === "auth_invalid" ||
    capacity.reason === "auth_missing" ||
    capacity.reason === "account_unavailable" ||
    capacity.reason === "provider_session_invalid" ||
    capacity.reason === "reconnect_required" ||
    capacity.details?.code === "auth_invalid" ||
    capacity.details?.code === "provider_session_invalid";
}

function isResettableCapacity(
  capacity: WorkerCapacitySnapshot,
): boolean {
  return (
    capacity.availability === "cooldown" ||
    capacity.availability === "quota_exhausted"
  );
}

function capacityRecoveryDetails(
  snapshots: readonly WorkerPoolSlotSnapshot[],
): Readonly<Record<string, string>> {
  const reasons = summarizeReasons(snapshots);
  const authBlocked = snapshots.some((snapshot) =>
    isAuthBlockedCapacity(snapshot.capacity)
  );
  return {
    ...(reasons ? { reasons } : {}),
    ...(authBlocked
      ? {
          recoveryHint:
            "One or more worker account slots look auth-stale. Run account diagnostics, relogin the affected slot or sync the per-account auth root to this host, then retry the worker.",
        }
      : {}),
  };
}

function summarizeAvailability(
  snapshots: readonly WorkerPoolSlotSnapshot[],
): string {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    counts.set(
      snapshot.capacity.availability,
      (counts.get(snapshot.capacity.availability) ?? 0) + 1,
    );
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([availability, count]) => `${availability}:${count}`)
    .join(",");
}

function summarizeReasons(snapshots: readonly WorkerPoolSlotSnapshot[]): string {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    const reason = snapshot.capacity.reason ?? snapshot.capacity.details?.code;
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
}
