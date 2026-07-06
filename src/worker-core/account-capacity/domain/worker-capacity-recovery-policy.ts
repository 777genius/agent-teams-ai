import type { WorkerCapacitySnapshot } from "../../types";

export type WorkerCapacityRecoverySnapshot = {
  readonly busy: boolean;
  readonly capacity: WorkerCapacitySnapshot;
};

export type WorkerCapacityRecoveryDecision =
  | {
      readonly kind: "defer";
    }
  | {
      readonly kind: "unavailable";
      readonly details: Readonly<Record<string, string>>;
    };

export const authBlockedWorkerCapacityRecoveryHint =
  "One or more worker account slots look auth-stale. Run account diagnostics, relogin the affected slot or sync the per-account auth root to this host, then retry the worker.";

export function assessWorkerCapacityRecovery(
  snapshots: readonly WorkerCapacityRecoverySnapshot[],
): WorkerCapacityRecoveryDecision {
  const details = workerCapacityUnavailableDetails(snapshots);
  if (!details) return { kind: "defer" };
  return { kind: "unavailable", details };
}

export function workerCapacityUnavailableDetails(
  snapshots: readonly WorkerCapacityRecoverySnapshot[],
): Readonly<Record<string, string>> | null {
  if (snapshots.some((snapshot) => snapshot.busy)) return null;
  if (snapshots.some((snapshot) => workerCapacityRecoveryAt(snapshot.capacity))) {
    return null;
  }

  const unavailable = snapshots.filter(
    (snapshot) => snapshot.capacity.availability !== "available",
  );
  if (unavailable.length === 0) return null;

  return {
    availability: summarizeAvailability(unavailable),
    ...capacityRecoveryDetails(unavailable),
  };
}

export function nextWorkerCapacityRecoveryAt(
  snapshots: readonly WorkerCapacityRecoverySnapshot[],
): number | null {
  return snapshots.reduce<number | null>((nextAt, snapshot) => {
    const recoveryAt = workerCapacityRecoveryAt(snapshot.capacity);
    if (!recoveryAt) return nextAt;
    const candidate = recoveryAt.getTime();
    return nextAt === null ? candidate : Math.min(nextAt, candidate);
  }, null);
}

export function workerCapacityRecoveryAt(
  capacity: WorkerCapacitySnapshot,
): Date | null {
  if (!isResettableWorkerCapacity(capacity) || !capacity.cooldownUntil) {
    return null;
  }
  return capacity.cooldownUntil;
}

export function normalizeWorkerCapacitySnapshot(
  capacity: WorkerCapacitySnapshot,
  now: Date,
): WorkerCapacitySnapshot {
  if (
    !isResettableWorkerCapacity(capacity) ||
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

export function isResettableWorkerCapacity(
  capacity: WorkerCapacitySnapshot,
): boolean {
  return (
    capacity.availability === "cooldown" ||
    capacity.availability === "quota_exhausted"
  );
}

export function isAuthBlockedWorkerCapacity(
  capacity: WorkerCapacitySnapshot,
): boolean {
  return (
    capacity.reason === "auth_invalid" ||
    capacity.reason === "auth_missing" ||
    capacity.reason === "account_unavailable" ||
    capacity.reason === "provider_session_invalid" ||
    capacity.reason === "reconnect_required" ||
    capacity.details?.code === "auth_invalid" ||
    capacity.details?.code === "provider_session_invalid"
  );
}

function capacityRecoveryDetails(
  snapshots: readonly WorkerCapacityRecoverySnapshot[],
): Readonly<Record<string, string>> {
  const reasons = summarizeReasons(snapshots);
  const authBlocked = snapshots.some((snapshot) =>
    isAuthBlockedWorkerCapacity(snapshot.capacity),
  );
  return {
    ...(reasons ? { reasons } : {}),
    ...(authBlocked
      ? { recoveryHint: authBlockedWorkerCapacityRecoveryHint }
      : {}),
  };
}

function summarizeAvailability(
  snapshots: readonly WorkerCapacityRecoverySnapshot[],
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

function summarizeReasons(
  snapshots: readonly WorkerCapacityRecoverySnapshot[],
): string {
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
