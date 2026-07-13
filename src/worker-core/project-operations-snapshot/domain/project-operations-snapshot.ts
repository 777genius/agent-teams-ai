import type {
  ProjectAdmissionDecisionReason,
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
} from "../../project-control/domain/project-admission";

export const PROJECT_OPERATIONS_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const PROJECT_OPERATIONS_SNAPSHOT_PROJECTION_VERSION = 1 as const;
export const PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS = 12;
export const PROJECT_OPERATIONS_SNAPSHOT_MAX_WORKER_EVIDENCE = 4;
export const PROJECT_OPERATIONS_SNAPSHOT_MAX_EVIDENCE_LENGTH = 256;

export enum ProjectOperationsWorkerState {
  Queued = "queued",
  Starting = "starting",
  Running = "running",
  Blocked = "blocked",
  Completed = "completed",
  Failed = "failed",
  Stopped = "stopped",
  Unknown = "unknown",
}

export enum ProjectOperationsWorkloadClass {
  Standard = "standard",
  Heavy = "heavy",
}

export enum ProjectOperationsSnapshotCompletenessStatus {
  Complete = "complete",
  Partial = "partial",
}

export enum ProjectOperationsSnapshotFreshnessStatus {
  Fresh = "fresh",
  Stale = "stale",
}

export enum ProjectOperationsSnapshotSection {
  Pool = "pool",
  OutputDebt = "output_debt",
  HostMemory = "host_memory",
  Admission = "admission",
}

/**
 * Provider adapters normalize their worker-specific lifecycle into this input.
 * Evidence must already be sanitized; the projection additionally bounds it.
 */
export type ProjectOperationsWorkerObservation = {
  readonly workerId: string;
  readonly role: ProjectAdmissionWorkerRole;
  readonly state: ProjectOperationsWorkerState;
  readonly workloadClass: ProjectOperationsWorkloadClass;
  readonly evidence?: readonly string[];
};

export type ProjectOperationsOutputDebtObservation = {
  readonly count: number;
  readonly reasons: readonly ProjectDebtReason[];
};

export type ProjectOperationsHostMemoryObservation = {
  readonly totalBytes: number;
  readonly availableBytes: number;
};

export type ProjectOperationsAdmissionObservation = {
  readonly allowed: boolean;
  readonly reason: ProjectAdmissionDecisionReason;
};

export type BuildProjectOperationsSnapshotInput = {
  readonly projectId: string;
  readonly observedAt: Date;
  readonly now: Date;
  readonly staleAfterMs: number;
  readonly workers?: readonly ProjectOperationsWorkerObservation[];
  readonly outputDebt?: ProjectOperationsOutputDebtObservation;
  readonly hostMemory?: ProjectOperationsHostMemoryObservation;
  readonly admission?: ProjectOperationsAdmissionObservation;
};

export type ProjectOperationsPoolCount = {
  readonly role: ProjectAdmissionWorkerRole;
  readonly state: ProjectOperationsWorkerState;
  readonly count: number;
};

export type ProjectOperationsHeavyWorkerEvidence = {
  readonly workerId: string;
  readonly role: ProjectAdmissionWorkerRole;
  readonly evidence: readonly string[];
};

export type ProjectOperationsSnapshot = {
  readonly schemaVersion: typeof PROJECT_OPERATIONS_SNAPSHOT_SCHEMA_VERSION;
  readonly projectionVersion: typeof PROJECT_OPERATIONS_SNAPSHOT_PROJECTION_VERSION;
  readonly authoritative: false;
  readonly projectId: string;
  readonly observedAt: string;
  readonly completeness: {
    readonly status: ProjectOperationsSnapshotCompletenessStatus;
    readonly missingSections: readonly ProjectOperationsSnapshotSection[];
  };
  readonly freshness: {
    readonly status: ProjectOperationsSnapshotFreshnessStatus;
    readonly ageMs: number;
    readonly staleAfterMs: number;
  };
  readonly pool: {
    readonly total: number;
    readonly counts: readonly ProjectOperationsPoolCount[];
  };
  readonly outputDebt: {
    readonly available: boolean;
    readonly count: number | null;
    readonly reasons: readonly ProjectDebtReason[];
  };
  readonly hostMemory: {
    readonly available: boolean;
    readonly totalBytes: number | null;
    readonly availableBytes: number | null;
  };
  readonly heavyWorkers: {
    readonly running: number;
    readonly evidence: readonly ProjectOperationsHeavyWorkerEvidence[];
    readonly truncated: number;
  };
  readonly admission: {
    readonly available: boolean;
    readonly allowed: boolean | null;
    readonly reason: ProjectAdmissionDecisionReason | null;
  };
};
