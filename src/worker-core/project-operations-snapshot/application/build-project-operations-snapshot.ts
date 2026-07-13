import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
} from "../../project-control/domain/project-admission";
import {
  PROJECT_OPERATIONS_SNAPSHOT_MAX_EVIDENCE_LENGTH,
  PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS,
  PROJECT_OPERATIONS_SNAPSHOT_MAX_WORKER_EVIDENCE,
  PROJECT_OPERATIONS_SNAPSHOT_PROJECTION_VERSION,
  PROJECT_OPERATIONS_SNAPSHOT_SCHEMA_VERSION,
  ProjectOperationsSnapshotCompletenessStatus,
  ProjectOperationsSnapshotFreshnessStatus,
  ProjectOperationsSnapshotSection,
  ProjectOperationsWorkerState,
  ProjectOperationsWorkloadClass,
  type BuildProjectOperationsSnapshotInput,
  type ProjectOperationsHeavyWorkerEvidence,
  type ProjectOperationsPoolCount,
  type ProjectOperationsSnapshot,
  type ProjectOperationsWorkerObservation,
} from "../domain/project-operations-snapshot";

const workerRoleOrder = Object.values(ProjectAdmissionWorkerRole);
const workerStateOrder = Object.values(ProjectOperationsWorkerState);
const debtReasonOrder = Object.values(ProjectDebtReason);

export class BuildProjectOperationsSnapshotUseCase {
  build(input: BuildProjectOperationsSnapshotInput): ProjectOperationsSnapshot {
    const projectId = requiredText(input.projectId, "projectId");
    const observedAtMs = validDateMs(input.observedAt, "observedAt");
    const nowMs = validDateMs(input.now, "now");
    const staleAfterMs = nonNegativeInteger(input.staleAfterMs, "staleAfterMs");
    const ageMs = Math.max(0, nowMs - observedAtMs);
    const missingSections = missingSectionsFor(input);
    const workers = input.workers ?? [];

    validateWorkers(workers);
    validateOutputDebt(input.outputDebt);
    validateHostMemory(input.hostMemory);

    const heavyWorkers = runningHeavyWorkers(workers);
    const heavyEvidence = heavyWorkers
      .slice(0, PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS)
      .map(toHeavyWorkerEvidence);

    return {
      schemaVersion: PROJECT_OPERATIONS_SNAPSHOT_SCHEMA_VERSION,
      projectionVersion: PROJECT_OPERATIONS_SNAPSHOT_PROJECTION_VERSION,
      authoritative: false,
      projectId,
      observedAt: new Date(observedAtMs).toISOString(),
      completeness: {
        status: missingSections.length === 0
          ? ProjectOperationsSnapshotCompletenessStatus.Complete
          : ProjectOperationsSnapshotCompletenessStatus.Partial,
        missingSections,
      },
      freshness: {
        status: ageMs > staleAfterMs
          ? ProjectOperationsSnapshotFreshnessStatus.Stale
          : ProjectOperationsSnapshotFreshnessStatus.Fresh,
        ageMs,
        staleAfterMs,
      },
      pool: {
        total: workers.length,
        counts: aggregateWorkerCounts(workers),
      },
      outputDebt: input.outputDebt === undefined
        ? { available: false, count: null, reasons: [] }
        : {
          available: true,
          count: input.outputDebt.count,
          reasons: orderedUniqueDebtReasons(input.outputDebt.reasons),
        },
      hostMemory: input.hostMemory === undefined
        ? { available: false, totalBytes: null, availableBytes: null }
        : {
          available: true,
          totalBytes: input.hostMemory.totalBytes,
          availableBytes: input.hostMemory.availableBytes,
        },
      heavyWorkers: {
        running: heavyWorkers.length,
        evidence: heavyEvidence,
        truncated: heavyWorkers.length - heavyEvidence.length,
      },
      admission: input.admission === undefined
        ? { available: false, allowed: null, reason: null }
        : {
          available: true,
          allowed: input.admission.allowed,
          reason: input.admission.reason,
        },
    };
  }
}

export function buildProjectOperationsSnapshot(
  input: BuildProjectOperationsSnapshotInput,
): ProjectOperationsSnapshot {
  return new BuildProjectOperationsSnapshotUseCase().build(input);
}

function missingSectionsFor(
  input: BuildProjectOperationsSnapshotInput,
): readonly ProjectOperationsSnapshotSection[] {
  return [
    ...(input.workers === undefined ? [ProjectOperationsSnapshotSection.Pool] : []),
    ...(input.outputDebt === undefined
      ? [ProjectOperationsSnapshotSection.OutputDebt]
      : []),
    ...(input.hostMemory === undefined
      ? [ProjectOperationsSnapshotSection.HostMemory]
      : []),
    ...(input.admission === undefined
      ? [ProjectOperationsSnapshotSection.Admission]
      : []),
  ];
}

function aggregateWorkerCounts(
  workers: readonly ProjectOperationsWorkerObservation[],
): readonly ProjectOperationsPoolCount[] {
  const counts = new Map<string, number>();
  for (const worker of workers) {
    const key = workerCountKey(worker.role, worker.state);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return workerRoleOrder.flatMap((role) =>
    workerStateOrder.flatMap((state) => {
      const count = counts.get(workerCountKey(role, state)) ?? 0;
      return count === 0 ? [] : [{ role, state, count }];
    })
  );
}

function workerCountKey(
  role: ProjectAdmissionWorkerRole,
  state: ProjectOperationsWorkerState,
): string {
  return `${role}\u0000${state}`;
}

function runningHeavyWorkers(
  workers: readonly ProjectOperationsWorkerObservation[],
): readonly ProjectOperationsWorkerObservation[] {
  return workers.filter((worker) =>
    worker.workloadClass === ProjectOperationsWorkloadClass.Heavy &&
    worker.state === ProjectOperationsWorkerState.Running
  ).sort((left, right) => left.workerId.localeCompare(right.workerId));
}

function toHeavyWorkerEvidence(
  worker: ProjectOperationsWorkerObservation,
): ProjectOperationsHeavyWorkerEvidence {
  return {
    workerId: worker.workerId.trim(),
    role: worker.role,
    evidence: boundedEvidence(worker.evidence ?? []),
  };
}

function boundedEvidence(evidence: readonly string[]): readonly string[] {
  return [...new Set(evidence
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, PROJECT_OPERATIONS_SNAPSHOT_MAX_EVIDENCE_LENGTH)))]
    .slice(0, PROJECT_OPERATIONS_SNAPSHOT_MAX_WORKER_EVIDENCE);
}

function orderedUniqueDebtReasons(
  reasons: readonly ProjectDebtReason[],
): readonly ProjectDebtReason[] {
  const present = new Set(reasons);
  return debtReasonOrder.filter((reason) => present.has(reason));
}

function validateWorkers(
  workers: readonly ProjectOperationsWorkerObservation[],
): void {
  const workerIds = new Set<string>();
  for (const worker of workers) {
    const workerId = requiredText(worker.workerId, "worker.workerId");
    if (workerIds.has(workerId)) {
      throw new TypeError(`Duplicate workerId: ${workerId}`);
    }
    workerIds.add(workerId);
    if (!workerRoleOrder.includes(worker.role)) {
      throw new TypeError(`Invalid worker role for ${workerId}`);
    }
    if (!workerStateOrder.includes(worker.state)) {
      throw new TypeError(`Invalid worker state for ${workerId}`);
    }
    if (!Object.values(ProjectOperationsWorkloadClass).includes(worker.workloadClass)) {
      throw new TypeError(`Invalid workload class for ${workerId}`);
    }
  }
}

function validateOutputDebt(
  outputDebt: BuildProjectOperationsSnapshotInput["outputDebt"],
): void {
  if (outputDebt === undefined) return;
  nonNegativeInteger(outputDebt.count, "outputDebt.count");
  for (const reason of outputDebt.reasons) {
    if (!debtReasonOrder.includes(reason)) {
      throw new TypeError("Invalid output debt reason");
    }
  }
}

function validateHostMemory(
  hostMemory: BuildProjectOperationsSnapshotInput["hostMemory"],
): void {
  if (hostMemory === undefined) return;
  const totalBytes = positiveInteger(hostMemory.totalBytes, "hostMemory.totalBytes");
  const availableBytes = nonNegativeInteger(
    hostMemory.availableBytes,
    "hostMemory.availableBytes",
  );
  if (availableBytes > totalBytes) {
    throw new RangeError("hostMemory.availableBytes must not exceed totalBytes");
  }
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function validDateMs(value: Date, field: string): number {
  const time = value.getTime();
  if (!Number.isFinite(time)) throw new TypeError(`${field} must be a valid Date`);
  return time;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}
