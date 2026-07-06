import { ProjectOperation } from "../../access-control";

export enum ProjectAdmissionWorkerRole {
  Producer = "producer",
  Fastgate = "fastgate",
  Reviewer = "reviewer",
  Integration = "integration",
  Adoption = "adoption",
  ReadOnly = "read_only",
}

export enum ProjectAdmissionDecisionStatus {
  Allowed = "allowed",
  Denied = "denied",
  AllowedForDrainOnly = "allowed_for_drain_only",
}

export enum ProjectAdmissionDecisionReason {
  Allowed = "allowed",
  OutputDebtPresent = "output_debt_present",
  SnapshotUnavailable = "snapshot_unavailable",
  SnapshotStale = "snapshot_stale",
  UnreadableProjectState = "unreadable_project_state",
  DiskPressure = "disk_pressure",
}

export enum ProjectDebtReason {
  InactiveDirtyWorkspace = "inactive_dirty_workspace",
  UnconsumedCompletedJob = "unconsumed_completed_job",
  OrphanLegacyWorkspace = "orphan_legacy_workspace",
  ConsumedDirtyWorkspace = "consumed_dirty_workspace",
  IncompleteConsumedOutputRecord = "incomplete_consumed_output_record",
  ActiveWriterConflict = "active_writer_conflict",
  StaleDirtyWorker = "stale_dirty_worker",
  UnreadableRoot = "unreadable_root",
  UnreadableWorkspace = "unreadable_workspace",
  SnapshotStale = "snapshot_stale",
  DiskPressure = "disk_pressure",
}

export type ProjectDebtItem = {
  readonly reason: ProjectDebtReason;
  readonly subject: string;
  readonly evidence: readonly string[];
  readonly severity?: "info" | "warning" | "blocking";
};

export type ProjectAdmissionSnapshot = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly observedAt: string;
  readonly stale?: boolean;
  readonly unavailable?: boolean;
  readonly debt: readonly ProjectDebtItem[];
  readonly counts?: {
    readonly inactiveDirtyWorkspaces?: number;
    readonly unconsumedCompletedJobs?: number;
    readonly orphanLegacyWorkspaces?: number;
    readonly consumedDirtyWorkspaces?: number;
    readonly incompleteConsumedOutputRecords?: number;
    readonly activeWriterConflicts?: number;
    readonly staleDirtyWorkers?: number;
    readonly unreadableRoots?: number;
    readonly unreadableWorkspaces?: number;
    readonly diskPressure?: number;
  };
};

export type ProjectAdmissionDebtSummary = {
  readonly unreadableProjectState: readonly ProjectDebtItem[];
  readonly staleSnapshot: readonly ProjectDebtItem[];
  readonly diskPressure: readonly ProjectDebtItem[];
  readonly blockingAdmissionDebt: readonly ProjectDebtItem[];
  readonly counts: NonNullable<ProjectAdmissionSnapshot["counts"]>;
};

export type ProjectAdmissionRequest = {
  readonly projectId?: string;
  readonly operation: ProjectOperation;
  readonly jobId?: string;
  readonly workspacePath?: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
};

export type ProjectAdmissionDecision = {
  readonly status: ProjectAdmissionDecisionStatus;
  readonly allowed: boolean;
  readonly operation: ProjectOperation;
  readonly reason: ProjectAdmissionDecisionReason;
  readonly projectId?: string;
  readonly workerRole: ProjectAdmissionWorkerRole;
  readonly evidence: readonly string[];
  readonly debt: readonly ProjectDebtItem[];
};

export interface ProjectAdmissionGate {
  evaluate(
    request: ProjectAdmissionRequest,
  ): Promise<ProjectAdmissionDecision> | ProjectAdmissionDecision;
}

export function evaluateProjectAdmission(input: {
  readonly request: ProjectAdmissionRequest;
  readonly snapshot?: ProjectAdmissionSnapshot;
}): ProjectAdmissionDecision {
  const workerRole = normalizeProjectAdmissionWorkerRole(
    input.request.workerRole,
    input.request.tags,
  );
  const base = {
    operation: input.request.operation,
    ...(input.request.projectId === undefined
      ? {}
      : { projectId: input.request.projectId }),
    workerRole,
  };
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.unavailable) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.SnapshotUnavailable,
      evidence: ["project admission snapshot is unavailable"],
      debt: [],
    });
  }
  const debtSummary = summarizeProjectAdmissionDebt(snapshot.debt);
  if (debtSummary.unreadableProjectState.length > 0) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.UnreadableProjectState,
      evidence: debtSummary.unreadableProjectState.flatMap((item) => item.evidence),
      debt: debtSummary.unreadableProjectState,
    });
  }
  if (snapshot.stale || debtSummary.staleSnapshot.length > 0) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.SnapshotStale,
      evidence: debtSummary.staleSnapshot.length > 0
        ? debtSummary.staleSnapshot.flatMap((item) => item.evidence)
        : ["project admission snapshot is stale"],
      debt: debtSummary.staleSnapshot,
    });
  }
  if (debtSummary.diskPressure.length > 0) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.DiskPressure,
      evidence: debtSummary.diskPressure.flatMap((item) => item.evidence),
      debt: debtSummary.diskPressure,
    });
  }
  if (debtSummary.blockingAdmissionDebt.length === 0) {
    return {
      ...base,
      status: ProjectAdmissionDecisionStatus.Allowed,
      allowed: true,
      reason: ProjectAdmissionDecisionReason.Allowed,
      evidence: ["project admission snapshot has no blocking debt"],
      debt: [],
    };
  }
  if (isDrainWorkerRole(workerRole)) {
    return {
      ...base,
      status: ProjectAdmissionDecisionStatus.AllowedForDrainOnly,
      allowed: true,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      evidence: ["project output debt exists; only drain/review roles are admitted"],
      debt: debtSummary.blockingAdmissionDebt,
    };
  }
  return denied({
    ...base,
    reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    evidence: ["project output debt blocks producer work"],
    debt: debtSummary.blockingAdmissionDebt,
  });
}

export function summarizeProjectAdmissionDebt(
  debt: readonly ProjectDebtItem[],
): ProjectAdmissionDebtSummary {
  return {
    unreadableProjectState: debt.filter((item) =>
      item.reason === ProjectDebtReason.UnreadableRoot
    ),
    staleSnapshot: debt.filter((item) =>
      item.reason === ProjectDebtReason.SnapshotStale
    ),
    diskPressure: debt.filter((item) =>
      item.reason === ProjectDebtReason.DiskPressure
    ),
    blockingAdmissionDebt: debt.filter((item) => item.severity !== "info"),
    counts: projectAdmissionDebtCounts(debt),
  };
}

export function normalizeProjectAdmissionWorkerRole(
  value?: ProjectAdmissionRequest["workerRole"],
  tags: readonly string[] = [],
): ProjectAdmissionWorkerRole {
  if (value && isProjectAdmissionWorkerRole(value)) return value;
  const tagRole = tags
    .map((tag) => tag.trim())
    .find((tag) => tag.startsWith("worker-role-"))
    ?.replace(/^worker-role-/, "");
  if (tagRole && isProjectAdmissionWorkerRole(tagRole)) return tagRole;
  return ProjectAdmissionWorkerRole.Producer;
}

export function isDrainWorkerRole(role: ProjectAdmissionWorkerRole): boolean {
  return role === ProjectAdmissionWorkerRole.Fastgate ||
    role === ProjectAdmissionWorkerRole.Reviewer ||
    role === ProjectAdmissionWorkerRole.Integration ||
    role === ProjectAdmissionWorkerRole.Adoption ||
    role === ProjectAdmissionWorkerRole.ReadOnly;
}

function isProjectAdmissionWorkerRole(
  value: string,
): value is ProjectAdmissionWorkerRole {
  return (Object.values(ProjectAdmissionWorkerRole) as readonly string[])
    .includes(value);
}

function denied(input: Omit<ProjectAdmissionDecision, "status" | "allowed">): ProjectAdmissionDecision {
  return {
    ...input,
    status: ProjectAdmissionDecisionStatus.Denied,
    allowed: false,
  };
}

function projectAdmissionDebtCounts(
  debt: readonly ProjectDebtItem[],
): NonNullable<ProjectAdmissionSnapshot["counts"]> {
  const count = (reason: ProjectDebtReason) =>
    debt.filter((item) => item.reason === reason).length;
  return {
    inactiveDirtyWorkspaces: count(ProjectDebtReason.InactiveDirtyWorkspace),
    unconsumedCompletedJobs: count(ProjectDebtReason.UnconsumedCompletedJob),
    orphanLegacyWorkspaces: count(ProjectDebtReason.OrphanLegacyWorkspace),
    consumedDirtyWorkspaces: count(ProjectDebtReason.ConsumedDirtyWorkspace),
    incompleteConsumedOutputRecords: count(ProjectDebtReason.IncompleteConsumedOutputRecord),
    activeWriterConflicts: count(ProjectDebtReason.ActiveWriterConflict),
    staleDirtyWorkers: count(ProjectDebtReason.StaleDirtyWorker),
    unreadableRoots: count(ProjectDebtReason.UnreadableRoot),
    unreadableWorkspaces: count(ProjectDebtReason.UnreadableWorkspace),
    diskPressure: count(ProjectDebtReason.DiskPressure),
  };
}
